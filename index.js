import {
    DEFAULT_SETTINGS,
    numOr,
    createEmptyMemoryData,
    normalizeMemoryData,
    cleanMessageText,
    callIndependentLLM,
    fetchWithTimeout,
    summarizeSingleTurn,
    rollbackMemoryFromMessageIndex,
    calculateRoundForMessageIndex,
    retrieveRelevantArchivedMemories,
    buildInjectedMemoryPrompt,
    mergeEditedMemoryWithEmbeddings,
    backfillExistingChatHistory,
    shouldSettleBeforeGeneration,
    computeHiddenMessageCutoff,
    rebuildMemoryHierarchy,
} from "./memory-engine.js";

const EXTENSION_NAME = "tiandao-memory-engine";
const PROMPT_KEY = "tiandao_memory_prompt";
const LS_SETTINGS_KEY = "suwei_memory_settings_backup_v1";
const SENSITIVE_SETTING_KEYS = new Set(["apiKey", "embeddingApiKey"]);

// 运行时状态控制
let isBackfilling = false;
let abortBackfillFlag = false;
let activeBackfillChatKey = null;
let summaryQueue = Promise.resolve();
let summaryEpoch = 0;
const activeSummaryChats = new Set();
let chatSaveTimer = null;
let lastChatFingerprint = [];

// 设置输入框登记表：支持“输入即保存”，并在按钮点击前强制落盘
const settingsInputRegistry = [];

function commitSettingInput(entry) {
    const raw = String(entry.el.value ?? "").trim();
    let value = raw;
    if (entry.isNum) {
        value = raw === "" ? "" : (Number.isFinite(Number(raw)) ? Number(raw) : "");
    }
    const settings = getSettings();
    if (settings[entry.key] === value) {
        if (entry.key === "model") syncModelChipActive();
        return;
    }
    settings[entry.key] = value;
    saveSettings();
    if (entry.key === "model") syncModelChipActive();
    if (entry.onChange) entry.onChange(value);
}

function flushSettingInputs() {
    for (const entry of settingsInputRegistry) {
        clearTimeout(entry.timer);
        commitSettingInput(entry);
    }
}

function syncModelChipActive() {
    const current = (getSettings().model || "").trim();
    document.querySelectorAll("#tiandao_floating_widget .tiandao-chip").forEach(chip => {
        chip.classList.toggle("active", chip.getAttribute("data-model") === current);
    });
}

function getSTContext() {
    if (globalThis.SillyTavern?.getContext) {
        return globalThis.SillyTavern.getContext();
    }
    return window;
}

function getChatKey() {
    const ctx = getSTContext();
    try {
        if (typeof ctx.getCurrentChatId === "function") {
            return String(ctx.getCurrentChatId() || "");
        }
    } catch (_) { /* 忽略 */ }
    return String(ctx.chatId || `${ctx.name1 || ""}::${ctx.name2 || ""}`);
}

function isCurrentChat(chatKey) {
    return !chatKey || getChatKey() === chatKey;
}

function buildChatFingerprint(chat) {
    if (!Array.isArray(chat)) return [];
    return chat.map(msg => {
        if (!msg) return "";
        return [
            msg.send_date || "",
            msg.name || "",
            msg.is_user ? "u" : "a",
            msg.is_system ? "s" : "n",
            String(msg.mes || "").slice(0, 120),
        ].join("|");
    });
}

function refreshChatFingerprint(chat = getSTContext().chat || []) {
    lastChatFingerprint = buildChatFingerprint(chat);
}

function findFirstChangedMessageIndex(previous, current) {
    const max = Math.max(previous.length, current.length);
    for (let i = 0; i < max; i++) {
        if (previous[i] !== current[i]) return i;
    }
    return -1;
}

function scheduleChatSave() {
    clearTimeout(chatSaveTimer);
    const chatKey = getChatKey();
    chatSaveTimer = setTimeout(async () => {
        chatSaveTimer = null;
        if (!isCurrentChat(chatKey)) return;
        const ctx = getSTContext();
        try {
            if (typeof ctx.saveChat === "function") {
                await ctx.saveChat();
            } else if (typeof ctx.saveMetadataDebounced === "function") {
                ctx.saveMetadataDebounced();
            }
        } catch (error) {
            console.warn("[溯微] 保存聊天状态失败:", error);
        }
    }, 250);
}

function enqueueBackgroundSummary(task, label = "自动归档") {
    summaryQueue = summaryQueue
        .then(async () => {
            await task();
        })
        .catch(error => {
            console.error(`[溯微] ${label}失败:`, error);
            updateStatusBar(`❌ ${error.message || label + "失败"}`, true);
        });
    return summaryQueue;
}

// 旧版本曾把示例值直接写进默认配置；这里把它们视为“未配置”自动清空，
// 用户真实填写过的内容（含 API Key）不受影响
const LEGACY_PREFILLED_DEFAULTS = {
    apiUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    targetContentTags: "content,story,reply",
    customStripTags: "thinking,think,report,options_engine,small_theater,status_bar",
    embeddingApiUrl: "https://api.siliconflow.cn/v1",
    embeddingModel: "BAAI/bge-m3",
};

function getSettings() {
    const ctx = getSTContext();
    const extSettings = ctx.extensionSettings || window.extension_settings || {};
    if (!extSettings[EXTENSION_NAME]) {
        extSettings[EXTENSION_NAME] = Object.assign({}, DEFAULT_SETTINGS);
        // 酒馆配置缺失（重装扩展 / 更换环境）时，从本地备份恢复 API 配置
        try {
            const backup = JSON.parse(localStorage.getItem(LS_SETTINGS_KEY) || "null");
            if (backup && typeof backup === "object") {
                let containedSensitiveKey = false;
                for (const [key, value] of Object.entries(backup)) {
                    if (SENSITIVE_SETTING_KEYS.has(key)) {
                        containedSensitiveKey = true;
                    } else {
                        extSettings[EXTENSION_NAME][key] = value;
                    }
                }
                if (containedSensitiveKey) {
                    const sanitized = { ...backup };
                    for (const key of SENSITIVE_SETTING_KEYS) delete sanitized[key];
                    localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(sanitized));
                }
            }
        } catch (_) { /* 备份损坏时忽略 */ }
    }
    const s = extSettings[EXTENSION_NAME];
    // 兼容旧配置项迁移
    if (s.keepRecentRoundsCount === undefined) {
        const oldMessagesCount = s.keepRecentMessagesCount;
        s.keepRecentRoundsCount = oldMessagesCount ? Math.max(1, Math.round(oldMessagesCount / 2)) : "";
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) {
            s[k] = v;
        }
    }
    // 清空旧版本自动预填的示例值（不影响用户自行配置过的真实值）
    if (!s.apiKey) {
        if (s.apiUrl === LEGACY_PREFILLED_DEFAULTS.apiUrl) s.apiUrl = "";
        if (s.model === LEGACY_PREFILLED_DEFAULTS.model) s.model = "";
    }
    if (!s.embeddingApiKey) {
        if (s.embeddingApiUrl === LEGACY_PREFILLED_DEFAULTS.embeddingApiUrl) s.embeddingApiUrl = "";
        if (s.embeddingModel === LEGACY_PREFILLED_DEFAULTS.embeddingModel) s.embeddingModel = "";
    }
    if (s.targetContentTags === LEGACY_PREFILLED_DEFAULTS.targetContentTags) s.targetContentTags = "";
    if (s.customStripTags === LEGACY_PREFILLED_DEFAULTS.customStripTags) s.customStripTags = "";
    return s;
}

function saveSettings() {
    const ctx = getSTContext();
    if (typeof ctx.saveSettingsDebounced === "function") {
        ctx.saveSettingsDebounced();
    }
    // 本地双保险备份：保存非敏感配置；API Key 只留在酒馆设置中，不额外镜像到 localStorage。
    try {
        const backup = { ...getSettings() };
        for (const key of SENSITIVE_SETTING_KEYS) delete backup[key];
        localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(backup));
    } catch (_) { /* 隐私模式等场景忽略 */ }
}

function getChatMemory() {
    const ctx = getSTContext();
    const metadata = ctx.chatMetadata || window.chat_metadata;
    if (!metadata) return createEmptyMemoryData();
    if (!metadata.tiandao_memory) {
        metadata.tiandao_memory = createEmptyMemoryData();
    }
    return normalizeMemoryData(metadata.tiandao_memory);
}

async function saveChatMemory() {
    const ctx = getSTContext();
    if (typeof ctx.saveMetadata === "function") {
        await ctx.saveMetadata();
    } else if (typeof window.saveMetadata === "function") {
        await window.saveMetadata();
    }
}

function updateStatusBar(text, isError = false) {
    const el = document.getElementById("tiandao_status_bar");
    if (!el) return;
    const label = el.querySelector(".tiandao-status-text");
    if (label) {
        label.textContent = text;
    } else {
        el.textContent = text;
    }
    el.classList.toggle("error", Boolean(isError));
    el.title = text;
}

/**
 * 应用内置看板主题（月白瓷 / 抹茶乳霜）：
 * 写在 <html data-sw-theme> 上，悬浮窗、状态栏与账本弹窗全部同步换肤
 */
function applyWidgetTheme() {
    const theme = getSettings().widgetTheme === "matcha" ? "matcha" : "porcelain";
    document.documentElement.dataset.swTheme = theme;
}

function buildRecentContextQuery(chat, targetContentTags, customStripTags) {
    if (!Array.isArray(chat) || chat.length === 0) return "";
    const snippets = [];
    for (let i = chat.length - 1; i >= 0 && snippets.length < 2; i--) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;
        const cleaned = cleanMessageText(msg.mes, targetContentTags, customStripTags);
        if (cleaned) {
            snippets.push(cleaned.slice(-300));
        }
    }
    return snippets.reverse().join("\n");
}

async function refreshPromptInjection(customQuery = "") {
    const ctx = getSTContext();
    const settings = getSettings();
    if (typeof ctx.setExtensionPrompt !== "function") return;

    if (!settings.enabled) {
        ctx.setExtensionPrompt(
            PROMPT_KEY,
            "",
            Math.min(2, Math.max(0, numOr(settings.injectionPosition, 1))),
            Math.max(0, numOr(settings.injectionDepth, 4))
        );
        updateFloatingWidgetUI();
        return;
    }

    const chatKey = getChatKey();
    const memoryData = getChatMemory();
    const hasMemory = Object.values(memoryData.levels || {}).some(list => Array.isArray(list) && list.length > 0)
        || Object.keys(memoryData.stateLedger?.characters || {}).length > 0
        || (memoryData.stateLedger?.todosAndPromises || []).length > 0;
    if (!hasMemory) {
        ctx.setExtensionPrompt(PROMPT_KEY, "", numOr(settings.injectionPosition, 1), numOr(settings.injectionDepth, 4));
        updateFloatingWidgetUI();
        return;
    }
    const queryText = customQuery || buildRecentContextQuery(ctx.chat || [], settings.targetContentTags, settings.customStripTags);

    let retrieved = [];
    if (settings.enableRetrieval && queryText) {
        retrieved = await retrieveRelevantArchivedMemories(settings, memoryData, queryText);
    }
    if (!isCurrentChat(chatKey)) return;

    const promptText = buildInjectedMemoryPrompt(memoryData, retrieved);
    ctx.setExtensionPrompt(
        PROMPT_KEY,
        promptText,
        Math.min(2, Math.max(0, numOr(settings.injectionPosition, 1))),
        Math.max(0, numOr(settings.injectionDepth, 4)),
        false,
        Math.min(2, Math.max(0, numOr(settings.injectionRole, 0)))
    );

    updateFloatingWidgetUI();
}

globalThis.tiandaoMemoryInterceptor = async function (chat, _contextSize, _abort, type) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        if (String(type || "") === "quiet") return;

        // 拦截器收到的是过滤掉隐藏消息后的 coreChat，索引不能用于记忆回滚。
        const ctx = getSTContext();
        const fullChat = ctx.chat || [];

        if (settings.summarizeTiming === "on_next_send" && shouldSettleBeforeGeneration(type)) {
            schedulePendingTurnsBeforeGeneration(fullChat, type);
        }

        syncHiddenMessagesState();
        refreshChatFingerprint(fullChat);
        const query = buildRecentContextQuery(fullChat, settings.targetContentTags, settings.customStripTags);
        await refreshPromptInjection(query);
    } catch (e) {
        console.warn("[溯微] Interceptor refresh error:", e);
    }
};

/**
 * 严格按照一问一答“轮数 (Round)”来裁剪隐藏历史：
 * 保留最近 keepRecentRoundsCount 轮完整一问一答，更早的旧轮次自动隐藏
 */
function syncHiddenMessagesState(forceRestoreAll = false) {
    const settings = getSettings();
    const ctx = getSTContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) return 0;
    const memoryData = getChatMemory();

    const shouldHide = settings.enabled && settings.autoHideOldMessages && !forceRestoreAll;
    const keepRounds = Math.max(1, numOr(settings.keepRecentRoundsCount, 3));

    // 只隐藏已经归档的轮次。首次安装、清空记忆或重建期间，原文必须继续发送。
    const cutoffIndex = shouldHide
        ? computeHiddenMessageCutoff(chat, keepRounds, memoryData.lastProcessedMessageId)
        : 0;

    let restoredCount = 0;
    let changed = false;

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;

        if (i < cutoffIndex) {
            if (!msg.is_system && !msg.extra?.tiandao_hidden) {
                msg.is_system = true;
                msg.extra = msg.extra || {};
                msg.extra.tiandao_hidden = true;
                changed = true;
            }
            const msgBlock = document.querySelector(`.mes[mesid="${i}"]`);
            if (msgBlock) msgBlock.setAttribute("is_system", "true");
        } else {
            if (msg.is_system && msg.extra?.tiandao_hidden) {
                msg.is_system = false;
                delete msg.extra.tiandao_hidden;
                restoredCount++;
                changed = true;
                const msgBlock = document.querySelector(`.mes[mesid="${i}"]`);
                if (msgBlock) msgBlock.setAttribute("is_system", "false");
            }
        }
    }
    if (changed) {
        refreshChatFingerprint(chat);
        scheduleChatSave();
        try {
            ctx.refresh?.();
        } catch (_) { /* 忽略旧版本兼容问题 */ }
    }
    updateFloatingWidgetUI();
    return restoredCount;
}

/**
 * 总结指定的一问一答轮次
 */
async function processSingleAiTurn(targetMessageId, isManual = false, options = {}) {
    const settings = getSettings();
    if (!settings.enabled && !isManual) return false;

    const ctx = options.ctx || getSTContext();
    const chat = options.chat || ctx.chat || [];
    const chatKey = options.chatKey || getChatKey();
    const epoch = options.epoch ?? summaryEpoch;
    if (isBackfilling && activeBackfillChatKey === chatKey) return false;
    if (chat.length === 0 || !isCurrentChat(chatKey)) return false;
    if (activeSummaryChats.has(chatKey)) return false;

    const msgIdx = typeof targetMessageId === "number" ? targetMessageId : chat.length - 1;
    const targetMsg = chat[msgIdx];
    if (!targetMsg || targetMsg.is_user || (targetMsg.is_system && !targetMsg.extra?.tiandao_hidden)) return false;

    const memoryData = options.memoryData || getChatMemory();
    const userName = ctx.name1 || "User";
    const charName = targetMsg.name || ctx.name2 || "Character";
    const roundNumber = options.roundNumber || calculateRoundForMessageIndex(chat, msgIdx);

    const lines = [];
    let startFloor = msgIdx;
    if (msgIdx > 0 && chat[msgIdx - 1] && chat[msgIdx - 1].is_user) {
        startFloor = msgIdx - 1;
        const userCleaned = cleanMessageText(chat[msgIdx - 1].mes, settings.targetContentTags, settings.customStripTags);
        if (userCleaned) {
            lines.push(`【${userName}】：\n${userCleaned}`);
        }
    }
    const aiCleaned = cleanMessageText(targetMsg.mes, settings.targetContentTags, settings.customStripTags);
    if (aiCleaned) {
        lines.push(`【${charName}】：\n${aiCleaned}`);
    }
    if (lines.length === 0) return false;

    activeSummaryChats.add(chatKey);
    updateFloatingWidgetUI();
    try {
        updateStatusBar(`⏳ 正在总结第 ${roundNumber} 轮对话并更新状态账本...`);
        const result = await summarizeSingleTurn(settings, memoryData, {
            roundNumber,
            startMessageId: startFloor,
            endMessageId: msgIdx,
            userName,
            charName,
            dialogueText: lines.join("\n\n"),
            shouldCommit: () => isCurrentChat(chatKey)
                && epoch === summaryEpoch
                && (isManual || getSettings().enabled)
                && getChatMemory() === memoryData
                && chat[msgIdx] === targetMsg,
        });
        if (!result) {
            if (isCurrentChat(chatKey)) {
                updateStatusBar("⏸️ 归档已取消：聊天已变化或切换了存档");
            }
            return false;
        }
        memoryData.lastProcessedMessageId = msgIdx;
        memoryData.lastProcessedRound = roundNumber;
        if (!isCurrentChat(chatKey)) return false;
        await saveChatMemory();
        if (isCurrentChat(chatKey) && epoch === summaryEpoch) {
            await refreshPromptInjection(aiCleaned);
            syncHiddenMessagesState();
        }
        if (isCurrentChat(chatKey)) {
            updateStatusBar(`✅ 第 ${roundNumber} 轮已归档`);
        }
        return true;
    } catch (err) {
        console.error("[溯微] Summarize turn error:", err);
        if (isCurrentChat(chatKey)) {
            updateStatusBar(`❌ 总结失败: ${err.message}`, true);
        }
        return false;
    } finally {
        activeSummaryChats.delete(chatKey);
        updateFloatingWidgetUI();
    }
}

/**
 * 玩家发送下一条消息时，把上一轮已定稿的一问一答放进后台队列。
 * 主生成不再等待摘要 API。
 */
function schedulePendingTurnsBeforeGeneration(chat, generationType) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoSummarizePerTurn) return false;
    if (!shouldSettleBeforeGeneration(generationType)) return false;

    if (!Array.isArray(chat) || chat.length < 2) return false;
    const ctx = getSTContext();
    const memoryData = getChatMemory();
    const chatKey = getChatKey();
    if (isBackfilling && activeBackfillChatKey === chatKey) return false;
    const epoch = summaryEpoch;

    const lastMsg = chat[chat.length - 1];
    const settledEndIdx = lastMsg?.is_user ? chat.length - 2 : chat.length - 1;
    if (settledEndIdx <= memoryData.lastProcessedMessageId) return false;

    const pending = [];
    for (let idx = Math.max(0, memoryData.lastProcessedMessageId + 1); idx <= settledEndIdx; idx++) {
        const msg = chat[idx];
        if (!msg || msg.is_user || (msg.is_system && !msg.extra?.tiandao_hidden)) continue;
        pending.push({ idx, msg });
    }
    if (pending.length === 0) return false;

    enqueueBackgroundSummary(async () => {
        for (const task of pending) {
            if (!isCurrentChat(chatKey) || epoch !== summaryEpoch) return;
            if (chat[task.idx] !== task.msg) continue;
            if (memoryData.lastProcessedMessageId >= task.idx) continue;
            await processSingleAiTurn(task.idx, false, {
                ctx,
                chat,
                chatKey,
                memoryData,
                epoch,
            });
        }
    }, "结算上一轮");
    return true;
}

// ==================== 🌌 “溯微” 实时记忆悬浮窗 (Floating Widget) ====================
let isWidgetExpanded = false;

function initFloatingWidget() {
    let widget = document.getElementById("tiandao_floating_widget");
    if (widget) return;

    applyWidgetTheme();

    widget = document.createElement("div");
    widget.id = "tiandao_floating_widget";
    widget.innerHTML = `
        <div id="tiandao_widget_pill" class="tiandao-widget-pill" title="溯微长线记忆引擎 (点击展开/折叠，可任意拖拽)">
            <span class="tiandao-pill-title"><i class="fa-solid fa-feather-pointed"></i> 溯微</span>
            <span id="tiandao_widget_badge" class="tiandao-pill-badge">就绪</span>
        </div>
        <div id="tiandao_widget_card" class="tiandao-widget-card" style="display: none;">
            <div class="tiandao-card-header">
                <div class="tiandao-segmented-control">
                    <button type="button" id="tiandao_tab_ledger_btn" class="tiandao-segment-btn active"><i class="fa-solid fa-book-bookmark"></i> 状态看板</button>
                    <button type="button" id="tiandao_tab_story_btn" class="tiandao-segment-btn"><i class="fa-solid fa-scroll"></i> 剧情</button>
                    <button type="button" id="tiandao_tab_settings_btn" class="tiandao-segment-btn"><i class="fa-solid fa-sliders"></i> 溯微设置</button>
                </div>
                <button type="button" id="tiandao_widget_close_btn" class="tiandao-card-close" title="折叠看板">&times;</button>
            </div>

            <div id="tiandao_status_bar" class="tiandao-status-bar">
                <i class="fa-solid fa-circle-dot" style="font-size:0.75em; opacity:0.8;"></i> <span class="tiandao-status-text">当前状态：就绪</span>
            </div>

            <div id="tiandao_widget_body" class="tiandao-card-body">
                <!-- Tab 1: 状态看板 -->
                <div id="tiandao_tab_ledger_content" class="tiandao-tab-page">
                    <div id="tiandao_widget_body_inner" class="tiandao-ledger-list">
                        <!-- 动态内容 -->
                    </div>
                </div>

                <!-- Tab 2: 剧情（各轮总结时间线） -->
                <div id="tiandao_tab_story_content" class="tiandao-tab-page" style="display: none;">
                    <div id="tiandao_story_page_timeline" class="tiandao-story-page"></div>
                </div>

                <!-- Tab 3: 溯微设置（二级分页：运行 / API / 数据） -->
                <div id="tiandao_tab_settings_content" class="tiandao-tab-page" style="display: none;">
                    <div class="tiandao-subtabs">
                        <button type="button" class="tiandao-subtab active" data-page="run"><i class="fa-solid fa-sliders"></i> 运行</button>
                        <button type="button" class="tiandao-subtab" data-page="api"><i class="fa-solid fa-plug"></i> API</button>
                        <button type="button" class="tiandao-subtab" data-page="data"><i class="fa-solid fa-database"></i> 数据</button>
                    </div>

                    <!-- 设置分页 1 · 运行 -->
                    <div class="tiandao-settings-page" data-page="run">
                        <!-- 核心运行与轮次裁剪 -->
                        <div class="tiandao-card-panel">
                            <div class="tiandao-panel-title">
                                <i class="fa-solid fa-sliders"></i> 核心运行与轮次裁剪
                            </div>
                            <div class="tiandao-control-group">
                                <label class="tiandao-toggle-row">
                                    <span class="tiandao-toggle-label">启用溯微记忆引擎（注入主模型）</span>
                                    <input id="tiandao_enabled" type="checkbox" class="tiandao-checkbox" />
                                </label>
                                <label class="tiandao-toggle-row">
                                    <span class="tiandao-toggle-label">自动调用独立 API 总结每轮</span>
                                    <input id="tiandao_auto_summarize" type="checkbox" class="tiandao-checkbox" />
                                </label>
                                <div class="tiandao-form-row">
                                    <span class="tiandao-field-label">总结触发时机</span>
                                    <select id="tiandao_summarize_timing" class="tiandao-select">
                                        <option value="on_next_send">发送下一条时 (重Roll零消耗·推荐)</option>
                                        <option value="after_reply">AI 回复完成后立即总结</option>
                                    </select>
                                </div>
                                <div class="tiandao-form-row">
                                    <span class="tiandao-field-label">🎨 看板主题</span>
                                    <select id="tiandao_widget_theme" class="tiandao-select">
                                        <option value="porcelain">月白瓷 · 清爽瓷白</option>
                                        <option value="matcha">抹茶乳霜 · 奶绿软糯</option>
                                    </select>
                                </div>
                            </div>

                            <div class="tiandao-panel-divider"></div>

                            <div class="tiandao-control-group">
                                <label class="tiandao-toggle-row">
                                    <span class="tiandao-toggle-label"><b>自动隐藏超出轮次原文</b>（长篇防爆）</span>
                                    <input id="tiandao_auto_hide" type="checkbox" class="tiandao-checkbox" />
                                </label>
                                <div class="tiandao-form-row">
                                    <span class="tiandao-field-label">保留最近几轮一问一答</span>
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        <input id="tiandao_keep_recent" type="number" class="tiandao-input tiandao-input-sm" min="1" max="25" placeholder="3" />
                                        <button type="button" id="tiandao_restore_hidden_btn" class="tiandao-btn tiandao-btn-sm" title="恢复所有被溯微隐藏的历史轮次">
                                            <i class="fa-solid fa-eye"></i> 恢复全部
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- 记忆金字塔与注入设置（自「高级」页移入） -->
                        <div class="tiandao-card-panel">
                            <div class="tiandao-panel-title">
                                <i class="fa-solid fa-layer-group"></i> 记忆金字塔与提示词注入
                            </div>
                            <div class="tiandao-form-row">
                                <span class="tiandao-field-label">向上合并步长 (满 K 轮合并为 1 条)</span>
                                <input id="tiandao_merge_chunk" type="number" class="tiandao-input tiandao-input-sm" min="2" max="15" placeholder="5" />
                            </div>
                            <div class="tiandao-form-row">
                                <span class="tiandao-field-label">最大递归层级数 (L0 ~ L_max)</span>
                                <input id="tiandao_max_level" type="number" class="tiandao-input tiandao-input-sm" min="2" max="5" placeholder="3" />
                            </div>
                            <div class="tiandao-form-row">
                                <span class="tiandao-field-label">提示词注入位置</span>
                                <select id="tiandao_inject_pos" class="tiandao-select">
                                    <option value="1">聊天历史中 (@ Depth)</option>
                                    <option value="0">聊天历史之后 (In-Prompt)</option>
                                    <option value="2">主提示词之前</option>
                                </select>
                            </div>
                            <div class="tiandao-form-row">
                                <span class="tiandao-field-label">提示词注入深度 (Depth)</span>
                                <input id="tiandao_inject_depth" type="number" class="tiandao-input tiandao-input-sm" min="0" max="20" placeholder="4" />
                            </div>
                            <div class="tiandao-form-row">
                                <span class="tiandao-field-label">提示词注入角色 (Role)</span>
                                <select id="tiandao_inject_role" class="tiandao-select">
                                    <option value="0">System (系统)</option>
                                    <option value="1">User (用户·高兼容)</option>
                                    <option value="2">Assistant (AI助手)</option>
                                </select>
                            </div>
                        </div>

                        <!-- 向量与关键词混合检索设置（自「高级」页移入） -->
                        <div class="tiandao-card-panel">
                            <div class="tiandao-panel-title">
                                <i class="fa-solid fa-brain"></i> 陈年小事按需唤醒 (混合召回)
                            </div>
                            <label class="tiandao-toggle-row">
                                <span class="tiandao-toggle-label">开启微摘要按需唤醒 (聊到旧事自动召回)</span>
                                <input id="tiandao_enable_retrieval" type="checkbox" class="tiandao-checkbox" />
                            </label>
                            <div class="tiandao-form-row">
                                <span class="tiandao-field-label">最多唤醒小事条数 (Top-K)</span>
                                <input id="tiandao_retrieval_topk" type="number" class="tiandao-input tiandao-input-sm" min="1" max="10" placeholder="3" />
                            </div>
                            <label class="tiandao-toggle-row" style="margin-top:6px;">
                                <span class="tiandao-toggle-label">启用外部 Embedding 向量 API (默认本地词法分词)</span>
                                <input id="tiandao_use_embedding" type="checkbox" class="tiandao-checkbox" />
                            </label>
                            <div class="tiandao-form-row" id="tiandao_embedding_hint_row">
                                <span class="tiandao-field-label">└ Embedding URL / Key / 模型</span>
                                <span class="tiandao-chip" id="tiandao_emb_expand_chip" title="勾选上方复选框后展开配置项">勾选后展开</span>
                            </div>

                            <div id="tiandao_embedding_box" style="display: none; margin-top: 8px;">
                                <div class="tiandao-input-block">
                                    <label class="tiandao-field-caption">Embedding URL</label>
                                    <input id="tiandao_emb_url" type="text" class="tiandao-input" placeholder="https://api.siliconflow.cn/v1" />
                                </div>
                                <div class="tiandao-input-block">
                                    <label class="tiandao-field-caption">Embedding API Key</label>
                                    <input id="tiandao_emb_key" type="password" class="tiandao-input" placeholder="sk-..." />
                                </div>
                                <div class="tiandao-input-block">
                                    <label class="tiandao-field-caption">Embedding 模型</label>
                                    <input id="tiandao_emb_model" type="text" class="tiandao-input" placeholder="BAAI/bge-m3" />
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 设置分页 2 · API -->
                    <div class="tiandao-settings-page" data-page="api" style="display: none;">
                        <!-- 独立总结 API 设置 -->
                        <div class="tiandao-card-panel">
                            <div class="tiandao-panel-title">
                                <i class="fa-solid fa-plug-circle-bolt"></i> 独立总结 API 设置 (OpenAI 兼容)
                            </div>

                            <div class="tiandao-input-block">
                                <label class="tiandao-field-caption">API 地址 (Base URL)</label>
                                <div class="tiandao-input-wrapper">
                                    <i class="fa-solid fa-link tiandao-input-icon"></i>
                                    <input id="tiandao_api_url" type="text" class="tiandao-input with-icon" placeholder="https://api.deepseek.com/v1" />
                                </div>
                            </div>

                            <div class="tiandao-input-block">
                                <label class="tiandao-field-caption">API Key</label>
                                <div class="tiandao-input-wrapper">
                                    <i class="fa-solid fa-key tiandao-input-icon"></i>
                                    <input id="tiandao_api_key" type="password" class="tiandao-input with-icon" placeholder="sk-..." />
                                </div>
                            </div>

                            <div class="tiandao-input-block">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                    <label class="tiandao-field-caption" style="margin:0;">总结模型 (Model)</label>
                                    <button type="button" id="tiandao_fetch_models_btn" class="tiandao-link-btn" title="输入 API 地址与 Key 后，点击可自动拉取渠道模型列表">
                                        <i class="fa-solid fa-cloud-arrow-down"></i> 自动拉取模型列表
                                    </button>
                                </div>
                                <div class="tiandao-input-wrapper">
                                    <i class="fa-solid fa-microchip tiandao-input-icon"></i>
                                    <input id="tiandao_model" type="text" class="tiandao-input with-icon" list="tiandao_model_datalist" placeholder="例如 deepseek-chat 或点击下方快捷标签" />
                                    <datalist id="tiandao_model_datalist">
                                        <option value="deepseek-chat"></option>
                                        <option value="gemini-2.5-flash"></option>
                                        <option value="gpt-4o-mini"></option>
                                        <option value="qwen-2.5-72b-instruct"></option>
                                    </datalist>
                                </div>
                                <!-- 常用快捷模型 Chips -->
                                <div class="tiandao-quick-chips">
                                    <span class="tiandao-chip" data-model="deepseek-chat">deepseek-chat</span>
                                    <span class="tiandao-chip" data-model="gemini-2.5-flash">gemini-2.5-flash</span>
                                    <span class="tiandao-chip" data-model="gpt-4o-mini">gpt-4o-mini</span>
                                </div>
                            </div>

                            <div class="tiandao-form-row" style="margin-top: 8px;">
                                <span class="tiandao-field-label">总结温度 (Temperature)</span>
                                <input id="tiandao_temp" type="number" step="0.05" min="0" max="1.5" class="tiandao-input tiandao-input-sm" placeholder="0.2" />
                            </div>

                            <div class="tiandao-input-block" style="margin-top: 8px;">
                                <label class="tiandao-field-caption">🎯 目标正文提取标签（白名单优先）</label>
                                <input id="tiandao_target_tags" type="text" class="tiandao-input" placeholder="默认留空（若有特定标签可填 content, story 等）" />
                            </div>

                            <div class="tiandao-input-block">
                                <label class="tiandao-field-caption">备用排除标签（黑名单）</label>
                                <input id="tiandao_strip_tags" type="text" class="tiandao-input" placeholder="默认内置 thinking, report, options_engine 等" />
                            </div>

                            <button type="button" id="tiandao_test_api_btn" class="tiandao-btn tiandao-btn-primary tiandao-btn-full" style="margin-top: 10px;">
                                <i class="fa-solid fa-bolt"></i> 测试独立 API 连通性
                            </button>
                        </div>
                    </div>

                    <!-- 设置分页 3 · 数据（一键扫描 / 清空 / 导入导出） -->
                    <div class="tiandao-settings-page" data-page="data" style="display: none;">
                        <!-- 记忆维护与数据操作（自「高级」页移入） -->
                        <div class="tiandao-card-panel">
                            <div class="tiandao-panel-title">
                                <i class="fa-solid fa-wrench"></i> 记忆维护与数据操作
                            </div>
                            <div class="tiandao-action-grid">
                                <button type="button" id="tiandao_backfill_btn" class="tiandao-btn">
                                    <i class="fa-solid fa-clock-rotate-left"></i> 一键扫描旧历史
                                </button>
                                <button type="button" id="tiandao_clear_memory_btn" class="tiandao-btn tiandao-btn-danger">
                                    <i class="fa-solid fa-trash-can"></i> 清空本存档记忆
                                </button>
                            </div>
                        </div>

                        <!-- 导入与导出 -->
                        <div class="tiandao-card-panel">
                            <div class="tiandao-panel-title">
                                <i class="fa-solid fa-file-export"></i> 导入与导出
                            </div>
                            <div class="tiandao-action-grid">
                                <button type="button" id="tiandao_export_json_btn" class="tiandao-btn">
                                    <i class="fa-solid fa-file-export"></i> 导出记忆数据
                                </button>
                                <label class="tiandao-btn" style="cursor:pointer; margin:0;">
                                    <i class="fa-solid fa-file-import"></i> 导入记忆数据
                                    <input id="tiandao_import_json_input" type="file" accept=".json" style="display:none;" />
                                </label>
                            </div>
                            <div class="tiandao-field-caption" style="margin-top:7px; margin-bottom:0;">
                                导出当前存档的记忆 JSON 文件；导入会覆盖本存档的全部记忆数据。
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 卡片底栏 -->
            <div class="tiandao-card-footer">
                <div id="tiandao_widget_summary_info" class="tiandao-footer-meta">
                    L0: 0 | L1: 0 | L2: 0
                </div>
                <div class="tiandao-footer-actions">
                    <button type="button" id="tiandao_widget_refresh_last_btn" class="tiandao-btn tiandao-btn-sm" title="重整当前最新一问一答轮次">
                        <i class="fa-solid fa-rotate"></i> 重整本轮
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(widget);

    const pill = document.getElementById("tiandao_widget_pill");
    const card = document.getElementById("tiandao_widget_card");
    const closeBtn = document.getElementById("tiandao_widget_close_btn");
    const tabLedgerBtn = document.getElementById("tiandao_tab_ledger_btn");
    const tabStoryBtn = document.getElementById("tiandao_tab_story_btn");
    const tabSettingsBtn = document.getElementById("tiandao_tab_settings_btn");
    const tabLedgerContent = document.getElementById("tiandao_tab_ledger_content");
    const tabStoryContent = document.getElementById("tiandao_tab_story_content");
    const tabSettingsContent = document.getElementById("tiandao_tab_settings_content");
    const refreshLastBtn = document.getElementById("tiandao_widget_refresh_last_btn");

    // 展开/折叠
    pill.addEventListener("click", () => {
        isWidgetExpanded = !isWidgetExpanded;
        card.style.display = isWidgetExpanded ? "flex" : "none";
        if (isWidgetExpanded) {
            positionFloatingWidgetCard();
            updateFloatingWidgetUI();
        }
    });

    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        isWidgetExpanded = false;
        card.style.display = "none";
    });

    // 主 Tab 切换（状态看板 / 剧情 / 溯微设置）
    const switchMainTab = (btn, content) => {
        [tabLedgerBtn, tabStoryBtn, tabSettingsBtn].forEach(b => b.classList.toggle("active", b === btn));
        [tabLedgerContent, tabStoryContent, tabSettingsContent].forEach(c => {
            c.style.display = c === content ? "block" : "none";
        });
    };

    tabLedgerBtn.addEventListener("click", () => {
        switchMainTab(tabLedgerBtn, tabLedgerContent);
        updateFloatingWidgetUI();
    });

    tabStoryBtn.addEventListener("click", () => {
        switchMainTab(tabStoryBtn, tabStoryContent);
        renderStoryTimeline();
    });

    tabSettingsBtn.addEventListener("click", () => {
        switchMainTab(tabSettingsBtn, tabSettingsContent);
    });

    // 设置 Tab 的二级页签（运行 / API / 数据）
    const settingsSubtabs = card.querySelectorAll("#tiandao_tab_settings_content .tiandao-subtab");
    settingsSubtabs.forEach(sub => {
        sub.addEventListener("click", () => {
            settingsSubtabs.forEach(t => t.classList.toggle("active", t === sub));
            const target = sub.getAttribute("data-page");
            card.querySelectorAll("#tiandao_tab_settings_content .tiandao-settings-page").forEach(p => {
                p.style.display = p.dataset.page === target ? "block" : "none";
            });
        });
    });

    if (refreshLastBtn) refreshLastBtn.addEventListener("click", async () => {
        const ctx = getSTContext();
        const chat = ctx.chat || [];
        let msgIdx = chat.length - 1;
        while (msgIdx >= 0 && (chat[msgIdx]?.is_user || (chat[msgIdx]?.is_system && !chat[msgIdx]?.extra?.tiandao_hidden))) {
            msgIdx--;
        }
        if (msgIdx < 0) {
            updateStatusBar("当前没有可重整的 AI 回复", true);
            return;
        }
        const chatKey = getChatKey();
        const epoch = summaryEpoch;
        const targetMsg = chat[msgIdx];
        enqueueBackgroundSummary(async () => {
            if (!isCurrentChat(chatKey) || epoch !== summaryEpoch || chat[msgIdx] !== targetMsg) return;
            await processSingleAiTurn(msgIdx, true, { ctx, chat, chatKey, epoch });
        }, "重整本轮");
    });

    // 快捷模型标签点击填充
    const chips = card.querySelectorAll(".tiandao-chip");
    chips.forEach(chip => {
        chip.addEventListener("click", () => {
            const m = chip.getAttribute("data-model");
            const modelInput = document.getElementById("tiandao_model");
            if (!modelInput || !m) return;
            modelInput.value = m;
            const settings = getSettings();
            settings.model = m;
            saveSettings();
            syncModelChipActive();
            updateStatusBar(`✨ 已选择模型: ${m}`);
        });
    });

    // 自动拉取模型列表功能
    const fetchModelsBtn = document.getElementById("tiandao_fetch_models_btn");
    if (fetchModelsBtn) {
        fetchModelsBtn.addEventListener("click", async () => {
            // 先把输入框中尚未失焦的内容落盘，避免读到旧配置
            flushSettingInputs();
            const settings = getSettings();
            const baseUrl = (settings.apiUrl || "").trim().replace(/\/+$/, "");
            if (!baseUrl) {
                updateStatusBar("❌ 请先填写 API 地址 (Base URL)", true);
                return;
            }
            try {
                updateStatusBar("⏳ 正在获取可用模型列表...");
                fetchModelsBtn.disabled = true;
                const endpoint = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
                const headers = {};
                if (settings.apiKey && settings.apiKey.trim()) {
                    headers["Authorization"] = `Bearer ${settings.apiKey.trim()}`;
                }
                const res = await fetchWithTimeout(endpoint, { method: "GET", headers }, 20_000);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const data = await res.json();
                const raw = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
                const names = raw
                    .map(x => (typeof x === "string" ? x : (x?.id || x?.name || "")))
                    .filter(Boolean)
                    .sort((a, b) => a.localeCompare(b));
                const datalist = document.getElementById("tiandao_model_datalist");
                if (datalist && names.length > 0) {
                    const frag = document.createDocumentFragment();
                    for (const n of names) {
                        const opt = document.createElement("option");
                        opt.value = n;
                        frag.appendChild(opt);
                    }
                    datalist.replaceChildren(frag);
                    updateStatusBar(`✅ 已拉取 ${names.length} 个模型，点击模型输入框即可下拉选择`);
                } else {
                    updateStatusBar("⚠️ 渠道未返回模型列表，请手动输入模型名称", true);
                }
            } catch (err) {
                updateStatusBar(`❌ 拉取模型列表失败: ${String(err.message || err).slice(0, 160)}`, true);
            } finally {
                fetchModelsBtn.disabled = false;
            }
        });
    }

    makeDraggable(widget, pill, { onDragMove: positionFloatingWidgetCard });
    // 卡片头部空白处也可拖拽（按钮与输入框不受影响）
    const cardHeaderEl = card.querySelector(".tiandao-card-header");
    if (cardHeaderEl) makeDraggable(widget, cardHeaderEl, { onDragMove: positionFloatingWidgetCard });
    bindSettingsUI();
    updateFloatingWidgetUI();
}

/**
 * 根据悬浮胶囊当前在屏幕中的位置，自动决定卡片向左/向右、向上/向下展开，
 * 避免拖到屏幕边缘时看板被遮挡
 */
function positionFloatingWidgetCard() {
    const widget = document.getElementById("tiandao_floating_widget");
    const card = document.getElementById("tiandao_widget_card");
    if (!widget || !card) return;

    const rect = widget.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const desiredWidth = Math.min(360, vw - 20);

    const openRightward = rect.left < desiredWidth;
    const spaceBelow = vh - rect.bottom - 10;
    const spaceAbove = rect.top - 10;
    const openUpward = spaceBelow < Math.min(340, vh * 0.55) && spaceAbove > spaceBelow;

    card.classList.toggle("tiandao-open-leftward", !openRightward);
    card.classList.toggle("tiandao-open-rightward", openRightward);
    card.classList.toggle("tiandao-open-upward", openUpward);
    card.style.maxHeight = Math.max(200, Math.min(610, openUpward ? spaceAbove : spaceBelow)) + "px";
}

function makeDraggable(element, handle, { onDragMove = null } = {}) {
    let pointerId = null;
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
    let moved = false;

    handle.style.touchAction = "none";

    const isInteractive = (target) =>
        target.closest("button, input, select, textarea, .tiandao-chip, summary, a");

    handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || isInteractive(e.target)) return;
        pointerId = e.pointerId;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = element.getBoundingClientRect();
        baseLeft = rect.left;
        baseTop = rect.top;
        element.style.left = baseLeft + "px";
        element.style.top = baseTop + "px";
        element.style.right = "auto";
        element.style.bottom = "auto";
        try { handle.setPointerCapture(e.pointerId); } catch (_) { /* 环境不支持时忽略 */ }
        e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
        if (pointerId === null || e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const width = element.offsetWidth || 120;
        const height = element.offsetHeight || 40;
        const nextLeft = Math.min(Math.max(8, baseLeft + dx), window.innerWidth - width - 8);
        const nextTop = Math.min(Math.max(8, baseTop + dy), window.innerHeight - height - 8);
        element.style.left = nextLeft + "px";
        element.style.top = nextTop + "px";
        if (onDragMove) onDragMove();
    });

    const finishDrag = (e) => {
        if (pointerId === null || e.pointerId !== pointerId) return;
        pointerId = null;
        try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
        if (onDragMove) onDragMove();
        setTimeout(() => { moved = false; }, 0);
    };
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);

    // 拖拽结束后拦截紧接着的 click，避免误触发展开/折叠
    handle.addEventListener("click", (e) => {
        if (moved) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);
}

function updateFloatingWidgetUI() {
    const settings = getSettings();
    const widget = document.getElementById("tiandao_floating_widget");
    if (!widget) return;

    applyWidgetTheme();

    // 悬浮窗同时是唯一设置入口。暂停引擎时保留入口，避免用户无法再次开启。
    widget.style.display = "block";
    positionFloatingWidgetCard();

    const memoryData = getChatMemory();
    const pill = document.getElementById("tiandao_widget_pill");
    const badge = document.getElementById("tiandao_widget_badge");
    const bodyInner = document.getElementById("tiandao_widget_body_inner");
    const summaryInfo = document.getElementById("tiandao_widget_summary_info");

    const l0Count = (memoryData.levels?.[0] || []).length;
    const l1Count = (memoryData.levels?.[1] || []).length;
    const l2Count = (memoryData.levels?.[2] || []).length;
    const l3Count = (memoryData.levels?.[3] || []).length;

    if (badge) {
        const badgeText = !settings.enabled
            ? "已暂停"
            : (isBackfilling && activeBackfillChatKey === getChatKey()
                ? "回溯中"
                : (activeSummaryChats.has(getChatKey()) ? "整理中" : (memoryData.lastProcessedRound > 0 ? `第${memoryData.lastProcessedRound}轮` : "就绪")));
        badge.textContent = badgeText;
    }
    if (pill) {
        pill.classList.toggle("tiandao-pill-paused", !settings.enabled);
        pill.title = settings.enabled
            ? "溯微长线记忆引擎 (点击展开/折叠，可任意拖拽)"
            : "溯微已暂停。点击展开设置，勾选“启用溯微记忆引擎”即可恢复。";
    }

    if (summaryInfo) {
        summaryInfo.textContent = `L0(${l0Count}) L1(${l1Count}) L2(${l2Count}) L3(${l3Count}) · 回溯池:${memoryData.archivePool?.length || 0}`;
    }

    if (!bodyInner) return;
    bodyInner.innerHTML = buildLedgerHtml(memoryData);

    // 「剧情」Tab 的时间线随数据实时刷新（纯展示无输入，重建安全）
    renderStoryTimeline();
}

/**
 * HTML 转义：账本内容来自模型输出或用户导入，统一转义防止注入
 */
function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * 状态账本通用渲染（状态看板 Tab 与 剧情 → 状态账本 分页共用同一份数据视图）
 */
function buildLedgerHtml(memoryData) {
    const ledger = memoryData.stateLedger || {};
    const chars = ledger.characters || {};
    const charCards = [];

    for (const [name, info] of Object.entries(chars)) {
        if (!info) continue;
        // 已摘除的饰品并入随身道具展示（标注“已摘下”），不再单列一行
        const removedParts = (Array.isArray(info.removedItemsLock) ? info.removedItemsLock : [])
            .map(x => {
                const label = /已摘|未佩戴|已脱/.test(String(x)) ? String(x) : `${String(x)}（已摘下）`;
                return `<span class="tiandao-item-off">${escapeHTML(label)}</span>`;
            });
        const allItems = [
            ...(Array.isArray(info.inventory) ? info.inventory : []).map(x => escapeHTML(x)),
            ...removedParts,
        ];
        const inv = allItems.length > 0
            ? `<div class="tiandao-char-prop tag-info"><i class="fa-solid fa-box-archive"></i> <b>随身道具</b>: ${allItems.join("，")}</div>`
            : "";

        charCards.push(`
            <div class="tiandao-char-card">
                <div class="tiandao-char-card-header">
                    <span class="tiandao-char-name">${escapeHTML(name)}</span>
                    <span class="tiandao-char-loc"><i class="fa-solid fa-location-dot"></i> ${escapeHTML(info.location || "未知位置")}</span>
                </div>
                <div class="tiandao-char-body">
                    <div class="tiandao-char-prop"><b>状态行动</b>: ${escapeHTML(info.statusAndAction || "平静")}</div>
                    <div class="tiandao-char-prop"><b>当前衣着</b>: ${escapeHTML(info.wear || "常规穿戴")}</div>
                    ${inv}
                </div>
            </div>
        `);
    }

    const todoHtml = (ledger.todosAndPromises || []).length > 0
        ? ledger.todosAndPromises.map(x => `<div class="tiandao-todo-item"><i class="fa-solid fa-thumbtack" style="color:var(--sw-accent); font-size:0.85em;"></i> <span>${escapeHTML(x)}</span></div>`).join("")
        : "<div class='tiandao-empty-hint'>暂无未完成的约定与待办</div>";

    return `
        <div class="tiandao-time-banner">
            <span class="tiandao-time-label"><i class="fa-regular fa-clock"></i> 故事时间</span>
            <span class="tiandao-time-val">${escapeHTML(ledger.time || "未知时间")}</span>
        </div>
        ${charCards.length > 0 ? charCards.join("") : "<div class='tiandao-empty-hint'>暂无在场人物追踪</div>"}
        <div class="tiandao-todo-box">
            <div class="tiandao-todo-title"><i class="fa-solid fa-list-check"></i> 待办与约定追踪</div>
            <div class="tiandao-todo-list">${todoHtml}</div>
        </div>
    `;
}

/**
 * 剧情时间线：各轮总结按层级（L2 大阶段 → L1 阶段 → L0 单轮）由远及近汇总，
 * 每条总结带编辑按钮，可内联修改剧情文本
 */
function buildTimelineHtml(memoryData) {
    const sections = [];
    const levels = memoryData.levels || {};
    const maxLvl = Math.max(...Object.keys(levels).map(Number), 1);

    const pushEntry = (lvl, item, idx) => {
        const badgeClass = lvl >= 2 ? "tiandao-lvl-2" : (lvl === 1 ? "tiandao-lvl-1" : "tiandao-lvl-0");
        const kindText = lvl >= 2 ? "大阶段脉络" : (lvl === 1 ? "阶段脉络" : "单轮微摘要");
        sections.push(`
            <div class="tiandao-story-entry${lvl >= 2 ? " strong" : ""}" data-lvl="${lvl}" data-idx="${idx}">
                <div class="tiandao-entry-meta">
                    <span class="tiandao-lvl ${badgeClass}">L${lvl}</span>
                    <span class="tiandao-round">第 ${escapeHTML(item.roundRange)} 轮 · ${kindText}</span>
                    <button type="button" class="tiandao-entry-edit-btn" title="编辑这条剧情总结" onclick="window.tiandaoEditStoryEntry(${lvl}, ${idx})">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                </div>
                <div class="tiandao-entry-text">${escapeHTML(item.text)}</div>
            </div>`);
    };

    for (let lvl = maxLvl; lvl >= 1; lvl--) {
        (levels[lvl] || []).forEach((it, idx) => pushEntry(lvl, it, idx));
    }
    (levels[0] || []).forEach((it, idx) => pushEntry(0, it, idx));

    const body = sections.length > 0
        ? sections.join("")
        : `<div class='tiandao-empty-hint'>暂无剧情总结 · 开启自动总结后，这里会按轮次逐步填充</div>`;

    return `
        <div class="tiandao-pagehead">
            <span class="tiandao-pagecap">剧情时间线（由远及近）</span>
            <span class="tiandao-pagehint">点击 ✏ 可修改每条剧情总结</span>
        </div>
        ${body}`;
}

/**
 * 「剧情」Tab：各轮总结时间线（L2 大阶段 → L1 阶段 → L0 单轮，由远及近）
 * 编辑期间暂停重绘，避免输入内容被覆盖丢失
 */
let storyEditingKey = null; // 正在编辑的条目键（"层级:序号"）
let storyEditingId = null;

function renderStoryTimeline() {
    const page = document.getElementById("tiandao_story_page_timeline");
    if (!page || storyEditingKey) return;
    page.innerHTML = buildTimelineHtml(getChatMemory());
}

// ==================== 剧情总结内联编辑 ====================

window.tiandaoEditStoryEntry = (lvl, idx) => {
    if (storyEditingKey) {
        updateStatusBar("⚠️ 请先保存或取消正在编辑的剧情总结", true);
        return;
    }
    const item = getChatMemory()?.levels?.[lvl]?.[idx];
    const page = document.getElementById("tiandao_story_page_timeline");
    const entry = page?.querySelector(`.tiandao-story-entry[data-lvl="${lvl}"][data-idx="${idx}"]`);
    const textDiv = entry?.querySelector(".tiandao-entry-text");
    if (!item || !entry || !textDiv) return;

    storyEditingKey = `${lvl}:${idx}`;
    storyEditingId = item.id || null;
    const editor = document.createElement("div");
    editor.className = "tiandao-entry-editor";
    editor.innerHTML = `
        <textarea class="tiandao-entry-editor-input" spellcheck="false">${escapeHTML(item.text ?? "")}</textarea>
        <div class="tiandao-entry-editor-actions">
            <button type="button" class="tiandao-btn tiandao-btn-sm tiandao-btn-primary" onclick="window.tiandaoSaveStoryEntry(${lvl}, ${idx})">
                <i class="fa-solid fa-check"></i> 保存
            </button>
            <button type="button" class="tiandao-btn tiandao-btn-sm" onclick="window.tiandaoCancelStoryEntry()">
                <i class="fa-solid fa-xmark"></i> 取消
            </button>
        </div>`;
    textDiv.style.display = "none";
    textDiv.after(editor);
    const editBtn = entry.querySelector(".tiandao-entry-edit-btn");
    if (editBtn) editBtn.style.display = "none";

    const ta = editor.querySelector("textarea");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
};

window.tiandaoCancelStoryEntry = () => {
    storyEditingKey = null;
    storyEditingId = null;
    renderStoryTimeline();
};

window.tiandaoSaveStoryEntry = async (lvl, idx) => {
    const page = document.getElementById("tiandao_story_page_timeline");
    const ta = page?.querySelector(`.tiandao-story-entry[data-lvl="${lvl}"][data-idx="${idx}"] .tiandao-entry-editor-input`);
    if (!ta) {
        storyEditingKey = null;
        storyEditingId = null;
        renderStoryTimeline();
        return;
    }
    const newText = ta.value.trim();
    if (!newText) {
        updateStatusBar("⚠️ 剧情总结内容不能为空", true);
        return;
    }
    const memoryData = getChatMemory();
    let item = null;
    if (storyEditingId) {
        item = memoryData?.levels?.[lvl]?.find(x => x?.id === storyEditingId)
            || (Number(lvl) === 0 ? memoryData?.archivePool?.find(x => x?.id === storyEditingId) : null);
    } else {
        item = memoryData?.levels?.[lvl]?.[idx];
    }
    if (!item) {
        storyEditingKey = null;
        storyEditingId = null;
        renderStoryTimeline();
        updateStatusBar("⚠️ 该剧情条目已被合并或移除，请重新选择", true);
        return;
    }
    summaryEpoch++;
    const chatKey = getChatKey();
    const epoch = summaryEpoch;
    item.text = newText;
    item.embedding = null; // 文本已变化，旧向量不再可信；召回会回退到本地词法检索。
    // L0 条目与回溯池同源存档：同步更新回溯池中的同 id 条目，保证陈年小事召回读到新文本
    if (Number(lvl) === 0 && Array.isArray(memoryData.archivePool)) {
        const poolItem = memoryData.archivePool.find(x => x && x.id === item.id);
        if (poolItem) {
            poolItem.text = newText;
            poolItem.embedding = null;
        }
    }
    // 高层摘要是由低层文本合成的；编辑低层后必须让受影响的高层摘要失效，
    // 否则注入给主模型的仍是旧内容。
    if (Number(lvl) === 0) {
        const l0 = (memoryData.archivePool || [])
            .filter(x => x && x.level === 0)
            .sort((a, b) => numOr(a.startMessageId, 0) - numOr(b.startMessageId, 0));
        memoryData.levels = { 0: l0 };
    } else {
        const maxLevel = Math.max(...Object.keys(memoryData.levels || {}).map(Number), Number(lvl));
        for (let level = Number(lvl) + 1; level <= maxLevel; level++) {
            memoryData.levels[level] = [];
        }
    }
    storyEditingKey = null;
    await saveChatMemory();
    await refreshPromptInjection();
    renderStoryTimeline();
    if (Number(lvl) === 0 && getSettings().enabled) {
        enqueueBackgroundSummary(async () => {
            if (!isCurrentChat(chatKey) || epoch !== summaryEpoch) return;
            if (isBackfilling && activeBackfillChatKey === chatKey) return;
            const rebuilt = await rebuildMemoryHierarchy(
                getSettings(),
                memoryData,
                () => isCurrentChat(chatKey)
                    && epoch === summaryEpoch
                    && getChatMemory() === memoryData,
            );
            if (!rebuilt) return;
            if (!isCurrentChat(chatKey) || getChatMemory() !== memoryData) return;
            await saveChatMemory();
            await refreshPromptInjection();
            updateFloatingWidgetUI();
            updateStatusBar(`✅ 已修改第 ${item.roundRange} 轮，并重建高层摘要`);
        }, "重建记忆层级");
        updateStatusBar(`✅ 已修改第 ${item.roundRange} 轮，正在后台重建高层摘要...`);
    } else {
        updateStatusBar(`✅ 已修改第 ${item.roundRange} 轮的剧情总结`);
    }
    storyEditingId = null;
};

/**
 * 「数据」分页：导出当前存档记忆数据（跨存档迁移 JSON 文件）
 */
function exportMemoryJson() {
    const ctx = getSTContext();
    const blob = new Blob([JSON.stringify(getChatMemory(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suwei_memory_${ctx.name2 || "chat"}_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 「数据」分页：导入记忆数据文件并直接覆盖当前存档记忆
 */
function importMemoryJsonFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const imported = JSON.parse(String(reader.result));
            if (!imported || typeof imported !== "object" || !imported.levels || !imported.stateLedger) {
                throw new Error("文件缺少 levels / stateLedger 字段，不是溯微记忆数据");
            }
            if (!confirm("导入会覆盖当前存档的全部记忆数据，确定继续吗？")) return;
            summaryEpoch++;
            storyEditingKey = null;
            storyEditingId = null;
            const normalizedImport = normalizeMemoryData(imported);
            const merged = normalizeMemoryData(mergeEditedMemoryWithEmbeddings(getChatMemory(), normalizedImport));
            const ctx = getSTContext();
            const metadata = ctx.chatMetadata || window.chat_metadata;
            if (metadata) {
                metadata.tiandao_memory = merged;
                await saveChatMemory();
                await refreshPromptInjection();
                syncHiddenMessagesState();
                updateFloatingWidgetUI();
                updateStatusBar("✅ 记忆数据导入成功并已生效！");
            }
        } catch (err) {
            updateStatusBar(`❌ 导入记忆数据失败: ${err.message}`, true);
        }
    };
    reader.readAsText(file);
}

function bindSettingsUI() {
    const settings = getSettings();

    const bindCheck = (id, key, onChange) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = Boolean(settings[key]);
        el.addEventListener("change", () => {
            settings[key] = el.checked;
            saveSettings();
            if (onChange) onChange(el.checked);
        });
    };

    // 输入即保存（350ms 防抖），失焦时立即落盘；数值留空保存为空串并回退内置默认值
    const bindInput = (id, key, isNum = false, onChange = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = settings[key] ?? "";
        const entry = { el, key, isNum, onChange, timer: null };
        settingsInputRegistry.push(entry);
        el.addEventListener("input", () => {
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => commitSettingInput(entry), 350);
        });
        el.addEventListener("change", () => {
            clearTimeout(entry.timer);
            commitSettingInput(entry);
        });
    };

    bindCheck("tiandao_enabled", "enabled", () => {
        summaryEpoch++;
        refreshPromptInjection();
        syncHiddenMessagesState();
        updateFloatingWidgetUI();
    });
    bindCheck("tiandao_auto_summarize", "autoSummarizePerTurn");
    bindInput("tiandao_summarize_timing", "summarizeTiming");
    bindInput("tiandao_widget_theme", "widgetTheme", false, () => applyWidgetTheme());

    bindCheck("tiandao_auto_hide", "autoHideOldMessages", (checked) => {
        const count = syncHiddenMessagesState(!checked);
        if (!checked) {
            updateStatusBar(`👁️ 已关闭自动隐藏，恢复显示 ${count} 条历史原文`);
        } else {
            updateStatusBar(`🙈 已开启原文裁剪：仅发送最近 ${numOr(settings.keepRecentRoundsCount, 3)} 轮一问一答原文`);
        }
    });
    bindInput("tiandao_keep_recent", "keepRecentRoundsCount", true, (val) => {
        syncHiddenMessagesState();
        if (settings.autoHideOldMessages) {
            updateStatusBar(`📏 已更新保留轮数：当前仅发送最近 ${numOr(val, 3)} 轮一问一答原文`);
        }
    });

    bindInput("tiandao_api_url", "apiUrl");
    bindInput("tiandao_api_key", "apiKey");
    bindInput("tiandao_model", "model");
    bindInput("tiandao_temp", "temperature", true);
    bindInput("tiandao_target_tags", "targetContentTags");
    bindInput("tiandao_strip_tags", "customStripTags");

    bindInput("tiandao_merge_chunk", "mergeChunkSize", true);
    bindInput("tiandao_max_level", "maxLevel", true);
    bindInput("tiandao_inject_pos", "injectionPosition", true, () => refreshPromptInjection());
    bindInput("tiandao_inject_depth", "injectionDepth", true, () => refreshPromptInjection());
    bindInput("tiandao_inject_role", "injectionRole", true, () => refreshPromptInjection());

    bindCheck("tiandao_enable_retrieval", "enableRetrieval", () => refreshPromptInjection());
    bindInput("tiandao_retrieval_topk", "retrievalTopK", true);

    // Embedding 配置区展开/收起：未勾选时显示「└ Embedding URL / Key / 模型 · 勾选后展开」提示行
    const updateEmbeddingBoxVisibility = () => {
        const on = Boolean(getSettings().useEmbeddingApi);
        const embBox = document.getElementById("tiandao_embedding_box");
        if (embBox) embBox.style.display = on ? "block" : "none";
        const hintRow = document.getElementById("tiandao_embedding_hint_row");
        if (hintRow) hintRow.style.display = on ? "none" : "flex";
    };
    updateEmbeddingBoxVisibility();
    bindCheck("tiandao_use_embedding", "useEmbeddingApi", () => updateEmbeddingBoxVisibility());
    const embExpandChip = document.getElementById("tiandao_emb_expand_chip");
    if (embExpandChip) embExpandChip.addEventListener("click", () => {
        const cb = document.getElementById("tiandao_use_embedding");
        if (!cb) return;
        cb.checked = true;
        settings.useEmbeddingApi = true;
        saveSettings();
        updateEmbeddingBoxVisibility();
    });
    bindInput("tiandao_emb_url", "embeddingApiUrl");
    bindInput("tiandao_emb_key", "embeddingApiKey");
    bindInput("tiandao_emb_model", "embeddingModel");

    const testBtn = document.getElementById("tiandao_test_api_btn");
    if (testBtn) testBtn.addEventListener("click", async () => {
        flushSettingInputs();
        try {
            updateStatusBar("⏳ 正在测试独立 API 连接...");
            const reply = await callIndependentLLM(getSettings(), [{ role: "user", content: "请仅回复“连接成功”四个字。" }]);
            updateStatusBar(`✅ API 测试通过！模型回复: ${reply.slice(0, 30)}`);
        } catch (e) {
            updateStatusBar(`❌ API 连接失败: ${e.message}`, true);
        }
    });

    const backfillBtn = document.getElementById("tiandao_backfill_btn");
    if (backfillBtn) backfillBtn.addEventListener("click", async () => {
        if (isBackfilling) {
            abortBackfillFlag = true;
            updateStatusBar("⏸️ 正在安全停止历史回溯...");
            return;
        }
        const ctx = getSTContext();
        const chat = ctx.chat || [];
        if (chat.length === 0) return updateStatusBar("当前无历史消息可扫描", true);
        const memoryData = getChatMemory();
        const nextStart = Math.max(0, (memoryData.lastProcessedMessageId ?? -1) + 1);
        if (nextStart >= chat.length) return updateStatusBar("✅ 所有历史对话轮次均已在记忆树中。");
        if (!confirm(`确定要扫描当前存档中的历史对话轮次吗？`)) return;
        isBackfilling = true;
        abortBackfillFlag = false;
        summaryEpoch++;
        const backfillChatKey = getChatKey();
        activeBackfillChatKey = backfillChatKey;
        backfillBtn.innerHTML = `<i class="fa-solid fa-stop"></i> 暂停扫描`;
        try {
            const userName = ctx.name1 || "User";
            const charName = ctx.name2 || "Character";
            const result = await backfillExistingChatHistory(getSettings(), memoryData, chat, userName, charName, {
                onProgress: (cur, total, roundNumber) => updateStatusBar(`⏳ 扫描旧历史 (${cur}/${total}) · 第 ${roundNumber} 轮...`),
                onChunkSaved: async () => {
                    if (!isCurrentChat(backfillChatKey)) return;
                    await saveChatMemory();
                    await refreshPromptInjection();
                },
                shouldAbort: () => abortBackfillFlag || !isCurrentChat(backfillChatKey),
                shouldCommitTurn: () => isCurrentChat(backfillChatKey),
            });
            if (!isCurrentChat(backfillChatKey)) return;
            syncHiddenMessagesState();
            updateStatusBar(result.aborted
                ? `⏸️ 已暂停，当前已处理 ${result.processedCount} 轮；再次点击可继续。`
                : `✅ 存量历史按轮次扫描构建完成！`);
        } catch (e) { updateStatusBar(`❌ 历史回溯中断: ${e.message}`, true); }
        finally {
            isBackfilling = false;
            activeBackfillChatKey = null;
            backfillBtn.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> 一键扫描旧历史`;
        }
    });

    const restoreHiddenBtn = document.getElementById("tiandao_restore_hidden_btn");
    if (restoreHiddenBtn) restoreHiddenBtn.addEventListener("click", () => {
        syncHiddenMessagesState(true);
        settings.autoHideOldMessages = false;
        const autoHideEl = document.getElementById("tiandao_auto_hide");
        if (autoHideEl) autoHideEl.checked = false;
        saveSettings();
        updateStatusBar(`👁️ 已恢复显示所有历史原文。`);
    });

    const clearBtn = document.getElementById("tiandao_clear_memory_btn");
    if (clearBtn) clearBtn.addEventListener("click", async () => {
        if (!confirm("确定要清空当前聊天存档的所有记忆与状态账本吗？")) return;
        const ctx = getSTContext();
        const metadata = ctx.chatMetadata || window.chat_metadata;
        if (metadata) {
            summaryEpoch++;
            storyEditingKey = null;
            storyEditingId = null;
            syncHiddenMessagesState(true);
            metadata.tiandao_memory = createEmptyMemoryData();
            await saveChatMemory();
            await refreshPromptInjection();
            updateStatusBar("🗑️ 已清空本存档记忆账本");
            updateFloatingWidgetUI();
        }
    });

    // 「数据」分页：导出 / 导入记忆数据
    const exportBtn = document.getElementById("tiandao_export_json_btn");
    if (exportBtn) exportBtn.addEventListener("click", exportMemoryJson);

    const importInput = document.getElementById("tiandao_import_json_input");
    if (importInput) importInput.addEventListener("change", (ev) => {
        importMemoryJsonFile(ev.target.files?.[0]);
        ev.target.value = ""; // 允许重复选择同一个文件
    });

    syncModelChipActive();
}

(async function initTiandaoMemoryExtension() {
    try {
        initFloatingWidget();
        window.addEventListener("resize", positionFloatingWidgetCard);

        const ctx = getSTContext();
        const eventSource = ctx.eventSource || window.eventSource;
        const eventTypes = ctx.eventTypes || ctx.event_types || window.event_types || window.eventTypes || {};
        refreshChatFingerprint(ctx.chat || []);
        syncHiddenMessagesState();

        if (eventSource && eventTypes) {
            if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, async () => {
                summaryEpoch++;
                summaryQueue = Promise.resolve();
                activeSummaryChats.clear();
                if (isBackfilling) abortBackfillFlag = true;
                refreshChatFingerprint(getSTContext().chat || []);
                await refreshPromptInjection(); syncHiddenMessagesState(); updateFloatingWidgetUI();
            });
            if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, async (type, _options, dryRun) => {
                const settings = getSettings();
                // 正常生成由 generate_interceptor 统一处理；dryRun 不会运行拦截器，
                // 这里只刷新提示词，不触发摘要，避免预览时消耗 API。
                if (!dryRun) return;
                syncHiddenMessagesState();
                const currentChat = getSTContext().chat || [];
                await refreshPromptInjection(buildRecentContextQuery(currentChat, settings.targetContentTags, settings.customStripTags));
            });
            if (eventTypes.CHARACTER_MESSAGE_RENDERED) eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, async (msgId) => {
                const settings = getSettings();
                const currentCtx = getSTContext();
                const chat = currentCtx.chat || [];
                refreshChatFingerprint(chat);
                syncHiddenMessagesState(); updateFloatingWidgetUI();
                if (settings.autoSummarizePerTurn && settings.summarizeTiming === "after_reply") {
                    const chatKey = getChatKey();
                    const epoch = summaryEpoch;
                    const targetMsg = chat[msgId];
                    enqueueBackgroundSummary(async () => {
                        if (!isCurrentChat(chatKey) || epoch !== summaryEpoch || chat[msgId] !== targetMsg) return;
                        await processSingleAiTurn(msgId, false, { ctx: currentCtx, chat, chatKey, epoch });
                    }, "即时归档");
                }
            });
            if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, async (newLength) => {
                const chat = getSTContext().chat || [];
                const previousFingerprint = lastChatFingerprint;
                const currentFingerprint = buildChatFingerprint(chat);
                const changedIndex = findFirstChangedMessageIndex(previousFingerprint, currentFingerprint);
                const cutoff = changedIndex >= 0
                    ? changedIndex
                    : Math.min(chat.length, Number.isFinite(Number(newLength)) ? Number(newLength) : chat.length);
                summaryEpoch++;
                refreshChatFingerprint(chat);
                const memoryData = getChatMemory();
                if (cutoff >= 0 && memoryData.lastProcessedMessageId >= cutoff) {
                    if (rollbackMemoryFromMessageIndex(memoryData, cutoff)) {
                        await saveChatMemory();
                        await refreshPromptInjection();
                    }
                }
                syncHiddenMessagesState(); updateFloatingWidgetUI();
            });
            if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, async (idx) => {
                summaryEpoch++;
                const currentCtx = getSTContext();
                const chat = currentCtx.chat || [];
                refreshChatFingerprint(chat);
                const memoryData = getChatMemory();
                if (memoryData.lastProcessedMessageId >= idx) {
                    rollbackMemoryFromMessageIndex(memoryData, idx);
                    await saveChatMemory();
                }
                const targetMsg = chat[idx];
                const settings = getSettings();
                if (targetMsg && !targetMsg.is_user && settings.enabled && settings.autoSummarizePerTurn) {
                    const chatKey = getChatKey();
                    const epoch = summaryEpoch;
                    enqueueBackgroundSummary(async () => {
                        if (!isCurrentChat(chatKey) || epoch !== summaryEpoch || chat[idx] !== targetMsg) return;
                        await processSingleAiTurn(idx, false, { ctx: currentCtx, chat, chatKey, epoch });
                    }, "编辑后重建");
                } else {
                    await refreshPromptInjection();
                }
                updateFloatingWidgetUI();
            });
            if (eventTypes.MESSAGE_SWIPED) eventSource.on(eventTypes.MESSAGE_SWIPED, async (idx) => {
                summaryEpoch++;
                const chat = getSTContext().chat || [];
                refreshChatFingerprint(chat);
                const memoryData = getChatMemory();
                const startFloor = idx > 0 && chat[idx - 1]?.is_user ? idx - 1 : idx;
                if (memoryData.lastProcessedMessageId >= startFloor) {
                    rollbackMemoryFromMessageIndex(memoryData, startFloor);
                    await saveChatMemory();
                    await refreshPromptInjection();
                    updateFloatingWidgetUI();
                }
            });
            if (eventTypes.MESSAGE_UPDATED) eventSource.on(eventTypes.MESSAGE_UPDATED, () => {
                refreshChatFingerprint(getSTContext().chat || []);
            });
        }
        updateFloatingWidgetUI();
        console.log("[溯微] v1.8.0 (后台归档·原子状态提交·可回滚分层记忆) 加载完毕！");
    } catch (err) { console.error("[溯微] 初始化异常:", err); }
})();
