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
    estimatePromptTokens,
    mergeEditedMemoryWithEmbeddings,
    backfillExistingChatHistory,
    shouldSettleBeforeGeneration,
    computeHiddenMessageCutoff,
    rebuildMemoryHierarchy,
    checkAndCascadeMerge,
    collectPendingAiTurns,
    cleanupPlaceholderCharacters,
    pruneStaleCharacters,
    parseRoundRange,
    isAiReplyMessage,
    isActiveChatContext,
    getRoundMessageWindow,
    resolveStateLedgerAfterEntry,
    buildRoundMessageIndex,
    invalidateDerivedSummariesInRange,
    readResponseText,
    captureLatestL0StateStorage,
    stampLatestL0StateSnapshot,
    restoreLatestL0StateStorage,
} from "./memory-engine.js";

const EXTENSION_NAME = "tiandao-memory-engine";
const PROMPT_KEY = "tiandao_memory_prompt";
const LS_SETTINGS_KEY = "suwei_memory_settings_backup_v1";
const SENSITIVE_SETTING_KEYS = new Set(["apiKey", "embeddingApiKey"]);
const API_PROFILE_FIELDS = ["apiUrl", "apiKey", "model", "temperature", "useJsonMode"];

// 运行时状态控制
let isBackfilling = false;
let abortBackfillFlag = false;
let activeBackfillChatKey = null;
let summaryQueue = Promise.resolve();
let summaryEpoch = 0;
const activeSummaryChats = new Set();
let chatSaveTimer = null;
let lastChatFingerprint = [];
let statusBarHideTimer = null;
let summaryTaskSequence = 0;
let activeSummaryTask = null;
let lastMemoryPromptTokens = 0;
let fetchedModelNames = [];
let fetchedEmbeddingModelNames = [];
let swipeRepairTimer = null;
const expandedCharacterCards = new Set();
const expandedInventoryCards = new Set();
const pendingHierarchyEdits = new Set();
const roundIndexCache = new WeakMap();
let floatingUiFrame = null;
let lastLedgerRenderKey = "";
const pendingLedgerRender = { force: false };

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
        return;
    }
    settings[entry.key] = value;
    saveSettings();
    if (entry.onChange) entry.onChange(value);
}

function flushSettingInputs() {
    for (const entry of settingsInputRegistry) {
        clearTimeout(entry.timer);
        commitSettingInput(entry);
    }
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

function clearSwipeRepairTimer() {
    if (swipeRepairTimer !== null) {
        clearTimeout(swipeRepairTimer);
        swipeRepairTimer = null;
    }
}

function getCachedRoundIndex(chat, includeNativeHidden = false) {
    if (!Array.isArray(chat)) {
        return buildRoundMessageIndex(chat, includeNativeHidden);
    }
    const cached = roundIndexCache.get(chat);
    if (cached?.includeNativeHidden === includeNativeHidden) return cached.index;
    const index = buildRoundMessageIndex(chat, includeNativeHidden);
    roundIndexCache.set(chat, { includeNativeHidden, index });
    return index;
}

function invalidateRoundIndexCache(chat) {
    if (Array.isArray(chat)) roundIndexCache.delete(chat);
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

function sanitizeApiProfiles(value) {
    const profiles = [];
    const seenIds = new Set();
    for (const [index, raw] of (Array.isArray(value) ? value : []).entries()) {
        if (!raw || typeof raw !== "object") continue;
        const name = String(raw.name || "").trim().slice(0, 80);
        if (!name) continue;
        let id = String(raw.id || "").trim() || `profile-${Date.now()}-${index}`;
        while (seenIds.has(id)) id = `${id}-${index}`;
        seenIds.add(id);
        const profile = { id, name };
        for (const field of API_PROFILE_FIELDS) {
            profile[field] = field === "useJsonMode"
                ? raw[field] !== false
                : (raw[field] ?? "");
        }
        profiles.push(profile);
    }
    return profiles;
}

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
        s.keepRecentRoundsCount = oldMessagesCount ? Math.max(1, Math.round(oldMessagesCount / 2)) : 5;
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) {
            s[k] = Array.isArray(v) ? v.slice() : v;
        }
    }
    s.apiProfiles = sanitizeApiProfiles(s.apiProfiles);
    s.activeApiProfileId = String(s.activeApiProfileId || "");
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
        if (Array.isArray(backup.apiProfiles)) {
            backup.apiProfiles = backup.apiProfiles.map(profile => {
                const safeProfile = { ...profile };
                delete safeProfile.apiKey;
                return safeProfile;
            });
        }
        localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(backup));
    } catch (_) { /* 隐私模式等场景忽略 */ }
}

function refreshApiProfileSelect(preferredId = "") {
    const select = document.getElementById("tiandao_api_profile_select");
    if (!select) return;
    const settings = getSettings();
    const profiles = settings.apiProfiles;
    const placeholder = new Option(profiles.length > 0 ? "选择已保存配置" : "暂无已保存配置", "");
    select.replaceChildren(placeholder);
    for (const profile of profiles) {
        select.add(new Option(profile.name, profile.id));
    }
    const targetId = preferredId || settings.activeApiProfileId;
    if (targetId && profiles.some(profile => profile.id === targetId)) {
        select.value = targetId;
    }
    const deleteBtn = document.getElementById("tiandao_api_profile_delete_btn");
    if (deleteBtn) deleteBtn.disabled = !select.value;
}

function applyApiProfileToForm(profile) {
    if (!profile) return;
    flushSettingInputs();
    const settings = getSettings();
    const bindings = {
        apiUrl: "tiandao_api_url",
        apiKey: "tiandao_api_key",
        model: "tiandao_model",
        temperature: "tiandao_temp",
        useJsonMode: "tiandao_use_json_mode",
    };
    for (const [field, id] of Object.entries(bindings)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const value = profile[field] ?? (field === "useJsonMode" ? true : "");
        settings[field] = value;
        if (field === "useJsonMode") {
            el.checked = Boolean(value);
        } else {
            el.value = value;
        }
    }
    settings.activeApiProfileId = profile.id;
    setFetchedModelNames([]);
    saveSettings();
    const nameInput = document.getElementById("tiandao_api_profile_name");
    if (nameInput) nameInput.value = profile.name;
    refreshApiProfileSelect(profile.id);
    updateStatusBar(`✅ 已切换到 API 配置「${profile.name}」；模型列表已清空，请重新拉取`);
}

function loadSelectedApiProfile() {
    const select = document.getElementById("tiandao_api_profile_select");
    const deleteBtn = document.getElementById("tiandao_api_profile_delete_btn");
    if (deleteBtn) deleteBtn.disabled = !select?.value;
    if (!select?.value) return;
    const profile = getSettings().apiProfiles.find(item => item.id === select.value);
    applyApiProfileToForm(profile);
}

function saveCurrentApiProfile() {
    flushSettingInputs();
    const nameInput = document.getElementById("tiandao_api_profile_name");
    const name = String(nameInput?.value || "").trim();
    if (!name) {
        updateStatusBar("⚠️ 请先填写 API 配置名称", true);
        nameInput?.focus();
        return;
    }

    const settings = getSettings();
    const profiles = settings.apiProfiles.slice();
    const existingIndex = profiles.findIndex(profile => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const profile = {
        id: existingIndex >= 0
            ? profiles[existingIndex].id
            : `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name,
    };
    for (const field of API_PROFILE_FIELDS) {
        profile[field] = field === "useJsonMode"
            ? settings.useJsonMode !== false
            : (settings[field] ?? "");
    }
    if (existingIndex >= 0) {
        profiles[existingIndex] = profile;
    } else {
        profiles.push(profile);
    }
    settings.apiProfiles = profiles;
    settings.activeApiProfileId = profile.id;
    saveSettings();
    if (nameInput) nameInput.value = name;
    refreshApiProfileSelect(profile.id);
    updateStatusBar(`✅ 已保存 API 配置「${name}」`);
}

function deleteSelectedApiProfile() {
    const select = document.getElementById("tiandao_api_profile_select");
    const id = select?.value;
    if (!id) return;
    const settings = getSettings();
    const profile = settings.apiProfiles.find(item => item.id === id);
    if (!profile) return;
    if (!confirm(`确定删除 API 配置「${profile.name}」吗？`)) return;
    settings.apiProfiles = settings.apiProfiles.filter(item => item.id !== id);
    if (settings.activeApiProfileId === id) settings.activeApiProfileId = "";
    saveSettings();
    refreshApiProfileSelect();
    const nameInput = document.getElementById("tiandao_api_profile_name");
    if (nameInput) nameInput.value = "";
    updateStatusBar(`🗑️ 已删除 API 配置「${profile.name}」`);
}

function getChatMemory() {
    const ctx = getSTContext();
    const metadata = ctx.chatMetadata || window.chat_metadata;
    if (!metadata) return createEmptyMemoryData();
    if (!metadata.tiandao_memory) {
        metadata.tiandao_memory = createEmptyMemoryData();
    }
    const previousStateStorageVersion = metadata.tiandao_memory.stateStorageVersion;
    const previousMemoryVersion = metadata.tiandao_memory.version;
    const memoryData = normalizeMemoryData(metadata.tiandao_memory);
    if (previousStateStorageVersion !== memoryData.stateStorageVersion
        || previousMemoryVersion !== memoryData.version) {
        scheduleChatSave();
    }
    if (cleanupPlaceholderCharacters(memoryData, ctx.name1 || "")) {
        scheduleChatSave();
    }
    return memoryData;
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
    el.style.display = "flex";
    clearTimeout(statusBarHideTimer);
    statusBarHideTimer = setTimeout(() => {
        el.style.display = "none";
    }, isError ? 9000 : 3500);
}

function beginSummaryTask({ label, total = 1, canCancel = true } = {}) {
    if (activeSummaryTask) return null;
    const task = {
        id: `summary-task-${++summaryTaskSequence}`,
        label: String(label || "总结剧情"),
        current: 0,
        total: Math.max(1, numOr(total, 1)),
        roundNumber: 0,
        detail: "准备开始",
        canCancel: Boolean(canCancel),
        cancelRequested: false,
        controller: new AbortController(),
        startedAt: Date.now(),
    };
    activeSummaryTask = task;
    renderSummaryProgress();
    return task;
}

async function acquireSummaryTask(config, isReady = () => true) {
    while (isReady()) {
        const task = beginSummaryTask(config);
        if (task) return task;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
}

function updateSummaryTask(task, patch = {}) {
    if (!task || activeSummaryTask !== task) return;
    Object.assign(task, patch);
    if (patch.total !== undefined) task.total = Math.max(1, numOr(patch.total, 1));
    if (patch.current !== undefined) task.current = Math.max(0, numOr(patch.current, 0));
    renderSummaryProgress();
}

function finishSummaryTask(task) {
    if (!task || activeSummaryTask !== task) return;
    activeSummaryTask = null;
    renderSummaryProgress();
}

function requestSummaryTaskStop() {
    // 停止必须同时作废队列：只 abort 当前 task 的话，下一项会立刻接替执行。
    summaryEpoch++;
    clearSwipeRepairTimer();
    const task = activeSummaryTask;
    if (!task) {
        updateStatusBar("⏸️ 总结队列已清空");
        return;
    }
    if (task.cancelRequested) return;
    task.cancelRequested = true;
    task.detail = "正在安全停止，当前请求会立即中断";
    task.controller.abort();
    renderSummaryProgress();
    updateStatusBar("⏸️ 已请求停止总结");
}

function isSummaryTaskCancelled(task = activeSummaryTask) {
    return Boolean(task?.cancelRequested || task?.controller?.signal?.aborted);
}

function renderSummaryProgress() {
    const box = document.getElementById("tiandao_summary_progress");
    if (!box) return;
    const task = activeSummaryTask;
    if (!task) {
        box.style.display = "none";
        return;
    }

    box.style.display = "flex";
    const title = document.getElementById("tiandao_summary_progress_title");
    const detail = document.getElementById("tiandao_summary_progress_detail");
    const counter = document.getElementById("tiandao_summary_progress_counter");
    const bar = document.getElementById("tiandao_summary_progress_bar");
    const stopBtn = document.getElementById("tiandao_summary_progress_stop");

    if (title) title.textContent = task.label;
    if (detail) {
        detail.textContent = task.cancelRequested
            ? "正在安全停止，当前请求会立即中断"
            : (task.detail || "正在总结");
    }
    if (counter) {
        counter.textContent = task.total > 1 ? `${task.current}/${task.total}` : "";
    }
    if (bar) {
        const percent = task.total > 0
            ? Math.min(100, Math.max(0, (task.current / task.total) * 100))
            : 0;
        bar.style.width = `${percent}%`;
    }
    if (stopBtn) {
        stopBtn.style.display = task.canCancel ? "inline-flex" : "none";
        stopBtn.disabled = task.cancelRequested;
        stopBtn.innerHTML = task.cancelRequested
            ? '<i class="fa-solid fa-spinner fa-spin"></i><span>停止中</span>'
            : '<i class="fa-solid fa-stop"></i><span>停止</span>';
    }
}

/**
 * 应用内置看板主题与字体外观：
 * 写在 <html> 上，悬浮窗、状态栏与账本弹窗全部同步换肤和缩放
 */
function applyWidgetAppearance() {
    const settings = getSettings();
    const theme = settings.widgetTheme === "journal" ? "journal" : "porcelain";
    const fontFamily = ["inherit", "sans", "serif"].includes(settings.widgetFontFamily)
        ? settings.widgetFontFamily
        : "inherit";
    const fontScale = Math.min(130, Math.max(85, numOr(settings.widgetFontScale, 100)));
    document.documentElement.dataset.swTheme = theme;
    document.documentElement.dataset.swFont = fontFamily;
    document.documentElement.style.setProperty("--sw-font-scale", String(fontScale / 100));
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

async function refreshPromptInjection(customQuery = "", options = {}) {
    const ctx = getSTContext();
    const settings = getSettings();
    if (typeof ctx.setExtensionPrompt !== "function") return;

    if (!settings.enabled) {
        lastMemoryPromptTokens = 0;
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
        || (memoryData.stateLedger?.todosAndPromises || []).some(todo => !todo?.completed);
    if (!hasMemory) {
        lastMemoryPromptTokens = 0;
        ctx.setExtensionPrompt(PROMPT_KEY, "", numOr(settings.injectionPosition, 1), numOr(settings.injectionDepth, 4));
        updateFloatingWidgetUI();
        return;
    }
    const queryText = customQuery || buildRecentContextQuery(ctx.chat || [], settings.targetContentTags, settings.customStripTags);

    let retrieved = [];
    if (settings.enableRetrieval && queryText && !options.skipRetrieval) {
        retrieved = await retrieveRelevantArchivedMemories(settings, memoryData, queryText);
    }
    if (!isCurrentChat(chatKey)) return;

    const chat = ctx.chat || [];
    let latestAiIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isAiReplyMessage(chat[i], settings.includeNativeHidden)) {
            latestAiIndex = i;
            break;
        }
    }
    const currentRound = latestAiIndex >= 0
        ? calculateRoundForMessageIndex(chat, latestAiIndex, settings.includeNativeHidden)
        : 0;
    const promptText = buildInjectedMemoryPrompt(
        memoryData,
        retrieved,
        ctx.name1 || "",
        5000,
        {
            recentRawRounds: settings.autoHideOldMessages
                ? Math.max(1, numOr(settings.keepRecentRoundsCount, 5))
                : 0,
            currentRound,
        },
    );
    lastMemoryPromptTokens = estimatePromptTokens(promptText);
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

function clonePlainData(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildTurnSummaryInput(chat, msgIdx, settings, ctx, precomputedTurn = null) {
    const targetMsg = chat[msgIdx];
    if (!isAiReplyMessage(targetMsg, settings.includeNativeHidden)) return null;
    const roundWindow = precomputedTurn?.window
        || getRoundMessageWindow(chat, msgIdx, settings.includeNativeHidden);
    if (!roundWindow) return null;
    const userName = ctx.name1 || "User";
    const charName = targetMsg.name || ctx.name2 || "Character";
    const lines = [];
    if (roundWindow.openingMessageIndex >= 0) {
        const openingMsg = chat[roundWindow.openingMessageIndex];
        const openingText = cleanMessageText(openingMsg.mes, settings.targetContentTags, settings.customStripTags);
        if (openingText) lines.push(`【开场白·${openingMsg.name || charName}】：\n${openingText}`);
    }
    if (roundWindow.userMessageIndex >= 0) {
        const userText = cleanMessageText(chat[roundWindow.userMessageIndex].mes, settings.targetContentTags, settings.customStripTags);
        if (userText) lines.push(`【${userName}】：\n${userText}`);
    }
    const aiText = cleanMessageText(targetMsg.mes, settings.targetContentTags, settings.customStripTags);
    if (aiText) lines.push(`【${charName}】：\n${aiText}`);
    if (lines.length === 0) return null;
    return {
        roundNumber: roundWindow.roundNumber,
        startMessageId: roundWindow.startMessageId,
        endMessageId: roundWindow.endMessageId,
        userName,
        charName,
        dialogueText: lines.join("\n\n"),
    };
}

function replaceL0Entry(memoryData, target, replacement) {
    const targetId = target?.id || "";
    const targetStart = numOr(target?.startMessageId, -1);
    const targetEnd = numOr(target?.endMessageId, -1);
    const isTarget = item => item && item.level === 0 && (
        (targetId && item.id === targetId)
        || (targetStart >= 0 && targetEnd >= 0
            && numOr(item.startMessageId, -2) === targetStart
            && numOr(item.endMessageId, -3) === targetEnd)
    );

    memoryData.archivePool = (memoryData.archivePool || []).filter(item => !isTarget(item));
    memoryData.archivePool.push(replacement);
    memoryData.archivePool.sort((a, b) =>
        numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
        - numOr(b.startMessageId, parseRoundRange(b.roundRange).start)
    );

    const activeL0 = Array.isArray(memoryData.levels?.[0]) ? memoryData.levels[0] : [];
    const targetWasActive = activeL0.some(isTarget);
    memoryData.levels[0] = activeL0.filter(item => !isTarget(item));
    if (targetWasActive) {
        memoryData.levels[0].push(replacement);
        memoryData.levels[0].sort((a, b) =>
            numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
            - numOr(b.startMessageId, parseRoundRange(b.roundRange).start)
        );
    }
}

function refreshLedgerFromLatestL0(memoryData) {
    const latest = (memoryData.archivePool || [])
        .filter(item => item && item.level === 0)
        .sort((a, b) =>
            numOr(a.endMessageId, parseRoundRange(a.roundRange).end)
            - numOr(b.endMessageId, parseRoundRange(b.roundRange).end)
        )
        .at(-1);
    if (latest) {
        const resolved = resolveStateLedgerAfterEntry(memoryData, latest);
        if (resolved) memoryData.stateLedger = resolved;
    }
}

async function resummarizeRoundInPlace(
    settings,
    ctx,
    chat,
    msgIdx,
    memoryData,
    chatKey,
    epoch,
    signal = null,
    precomputedTurn = null,
) {
    const turn = buildTurnSummaryInput(chat, msgIdx, settings, ctx, precomputedTurn);
    if (!turn) return true;
    const target = (memoryData.archivePool || []).find(item =>
        item?.level === 0
        && numOr(item.endMessageId, parseRoundRange(item.roundRange).end) === msgIdx
    );
    const before = (memoryData.archivePool || [])
        .filter(item => item?.level === 0
            && numOr(item.endMessageId, parseRoundRange(item.roundRange).end) < turn.startMessageId)
        .sort((a, b) =>
            numOr(a.endMessageId, parseRoundRange(a.roundRange).end)
            - numOr(b.endMessageId, parseRoundRange(b.roundRange).end)
        );

    const working = createEmptyMemoryData();
    working.levels = { 0: [] };
    working.archivePool = [];
    const previousEntry = before.at(-1);
    working.stateLedger = clonePlainData(
        (previousEntry ? resolveStateLedgerAfterEntry(memoryData, previousEntry) : null)
        || createEmptyMemoryData().stateLedger
    );
    working.lastProcessedMessageId = turn.startMessageId - 1;
    working.lastProcessedRound = Math.max(0, turn.roundNumber - 1);

    const replacement = await summarizeSingleTurn(settings, working, {
        ...turn,
        shouldCommit: () =>
            isCurrentChat(chatKey)
            && epoch === summaryEpoch
            && !signal?.aborted
            && chat[msgIdx] && memoryData === getChatMemory(),
        signal,
    });
    if (!replacement) return false;
    replaceL0Entry(memoryData, target, replacement);
    refreshLedgerFromLatestL0(memoryData);
    return true;
}

function runStoryResummarize(turns, { button = null, requireConfirm = true, title = "重新总结" } = {}) {
    if (!Array.isArray(turns) || turns.length === 0) {
        updateStatusBar("⚠️ 没有可重新总结的剧情轮次", true);
        return null;
    }
    if (isBackfilling) {
        updateStatusBar("⏸️ 历史扫描进行中，请等待扫描完成后再重新总结", true);
        return null;
    }
    const chatKey = getChatKey();
    if (activeSummaryChats.has(chatKey) || pendingHierarchyEdits.has(chatKey)) {
        updateStatusBar("⏳ 当前存档正在总结，请稍后再试", true);
        return null;
    }
    const fromRound = turns[0].round;
    const toRound = turns.at(-1).round;
    if (requireConfirm && !confirm(
        `将重新总结第 ${fromRound}-${toRound} 轮，共 ${turns.length} 轮。\n` +
        "会调用独立总结 API，并重建受影响的高层摘要。确定继续吗？"
    )) return null;

    const ctx = getSTContext();
    const chat = ctx.chat || [];
    const memoryData = getChatMemory();
    const epoch = summaryEpoch;
    storyViewRange = null;
    storyPage = 0;
    renderStoryTimeline();
    if (button) button.disabled = true;
    activeSummaryChats.add(chatKey);
    updateFloatingWidgetUI();

    let task = null;
    let signal = null;
    let cancelled = false;
    let completedRounds = 0;
    let rebuiltSuccessfully = false;
    const job = enqueueBackgroundSummary(async () => {
        task = await acquireSummaryTask({
            label: title,
            total: turns.length,
            canCancel: true,
        }, () => isCurrentChat(chatKey) && epoch === summaryEpoch);
        if (!task) return;
        signal = task.controller.signal;
        updateFloatingWidgetUI();
        try {
            for (let i = 0; i < turns.length; i++) {
                if (isSummaryTaskCancelled(task)) {
                    cancelled = true;
                    break;
                }
                if (!isCurrentChat(chatKey) || epoch !== summaryEpoch) return;
                const turn = turns[i];
                if (chat[turn.idx] !== turn.msg) continue;
                updateSummaryTask(task, {
                    current: i + 1,
                    roundNumber: turn.round,
                    detail: `正在重新总结第 ${turn.round} 轮`,
                });
                try {
                    const ok = await resummarizeRoundInPlace(
                        getSettings(),
                        ctx,
                        chat,
                        turn.idx,
                        memoryData,
                        chatKey,
                        epoch,
                        signal,
                        turn,
                    );
                    if (!ok) {
                        if (isSummaryTaskCancelled(task)) cancelled = true;
                        break;
                    }
                    completedRounds++;
                } catch (error) {
                    if (signal.aborted || error?.name === "AbortError") {
                        cancelled = true;
                        break;
                    }
                    throw error;
                }
                if (isSummaryTaskCancelled(task)) {
                    cancelled = true;
                    break;
                }
            }
            if (cancelled) return;
            if (!isCurrentChat(chatKey) || epoch !== summaryEpoch || memoryData !== getChatMemory()) return;
            updateSummaryTask(task, {
                detail: "正在重建高层剧情摘要",
                canCancel: true,
            });
            const rebuilt = await rebuildMemoryHierarchy(
                getSettings(),
                memoryData,
                () => isCurrentChat(chatKey) && epoch === summaryEpoch && memoryData === getChatMemory(),
                { signal },
            );
            if (!rebuilt) {
                if (isSummaryTaskCancelled(task)) cancelled = true;
                return;
            }
            rebuiltSuccessfully = true;
            memoryData.lastSummaryError = null;
            await saveChatMemory();
            await refreshPromptInjection();
            updateFloatingWidgetUI();
            renderStoryTimeline();
            updateStatusBar(`✅ 已重新总结第 ${fromRound}-${toRound} 轮`);
        } catch (error) {
            if (signal.aborted || error?.name === "AbortError") {
                cancelled = true;
            } else {
                throw error;
            }
        } finally {
            const partial = completedRounds > 0 && !rebuiltSuccessfully;
            const stillCurrent = isCurrentChat(chatKey) && epoch === summaryEpoch;
            if (partial) {
                invalidateDerivedSummariesInRange(memoryData, fromRound, toRound);
            }
            if (stillCurrent && (cancelled || partial)) {
                await saveChatMemory().catch(() => {});
                await refreshPromptInjection().catch(() => {});
                updateFloatingWidgetUI();
                renderStoryTimeline();
                updateStatusBar(
                    cancelled
                        ? `⏸️ 已停止重新总结：完成 ${completedRounds}/${turns.length} 轮；未完成轮次保留原摘要`
                        : `⚠️ 重新总结未完成：完成 ${completedRounds}/${turns.length} 轮；已移除受影响的高层摘要`,
                    !cancelled,
                );
            }
        }
    }, title);
    job.finally(() => {
        activeSummaryChats.delete(chatKey);
        if (button) button.disabled = false;
        if (task) finishSummaryTask(task);
        updateFloatingWidgetUI();
    });
    return job;
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
    const keepRounds = Math.max(1, numOr(settings.keepRecentRoundsCount, 5));

    // 只隐藏已经归档的轮次。首次安装、清空记忆或重建期间，原文必须继续发送。
    const cutoffIndex = shouldHide
        ? computeHiddenMessageCutoff(
            chat,
            keepRounds,
            memoryData.lastProcessedMessageId,
            settings.includeNativeHidden,
        )
        : 0;

    let restoredCount = 0;
    let changed = false;
    const domChangedIndexes = [];

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;

        if (i < cutoffIndex) {
            if (!msg.is_system && !msg.extra?.tiandao_hidden) {
                msg.is_system = true;
                msg.extra = msg.extra || {};
                msg.extra.tiandao_hidden = true;
                changed = true;
                domChangedIndexes.push(i);
            }
        } else {
            if (msg.is_system && msg.extra?.tiandao_hidden) {
                msg.is_system = false;
                delete msg.extra.tiandao_hidden;
                restoredCount++;
                changed = true;
                domChangedIndexes.push(i);
            }
        }
    }
    if (changed) {
        invalidateRoundIndexCache(chat);
        for (const index of domChangedIndexes) {
            const msgBlock = document.querySelector(`.mes[mesid="${index}"]`);
            if (msgBlock) {
                msgBlock.setAttribute("is_system", String(Boolean(chat[index]?.is_system)));
            }
        }
        refreshChatFingerprint(chat);
        scheduleChatSave();
        try {
            ctx.refresh?.();
        } catch (_) { /* 忽略旧版本兼容问题 */ }
    }
    return restoredCount;
}

/**
 * 总结指定的一问一答轮次
 */
async function processSingleAiTurn(targetMessageId, isManual = false, options = {}) {
    const settings = getSettings();
    if (!settings.enabled && !isManual) return false;

    const ctx = options.ctx || getSTContext();
    if (!isActiveChatContext(ctx)) return false;
    const chat = options.chat || ctx.chat || [];
    const chatKey = options.chatKey || getChatKey();
    const epoch = options.epoch ?? summaryEpoch;
    if (isBackfilling && activeBackfillChatKey === chatKey) return false;
    if (chat.length === 0 || !isCurrentChat(chatKey)) return false;
    if (activeSummaryChats.has(chatKey)) return false;

    const msgIdx = typeof targetMessageId === "number" ? targetMessageId : chat.length - 1;
    const targetMsg = chat[msgIdx];
    if (!isAiReplyMessage(targetMsg, settings.includeNativeHidden)) return false;
    const roundWindow = getRoundMessageWindow(chat, msgIdx, settings.includeNativeHidden);
    if (!roundWindow) return false;

    const memoryData = options.memoryData || getChatMemory();
    const userName = ctx.name1 || "User";
    const charName = targetMsg.name || ctx.name2 || "Character";
    const roundNumber = options.roundNumber || roundWindow.roundNumber;

    const lines = [];
    if (roundWindow.openingMessageIndex >= 0) {
        const openingMsg = chat[roundWindow.openingMessageIndex];
        const openingText = cleanMessageText(openingMsg.mes, settings.targetContentTags, settings.customStripTags);
        if (openingText) {
            lines.push(`【开场白·${openingMsg.name || charName}】：\n${openingText}`);
        }
    }
    if (roundWindow.userMessageIndex >= 0) {
        const userMsg = chat[roundWindow.userMessageIndex];
        const userCleaned = cleanMessageText(userMsg.mes, settings.targetContentTags, settings.customStripTags);
        if (userCleaned) {
            lines.push(`【${userName}】：\n${userCleaned}`);
        }
    }
    const aiCleaned = cleanMessageText(targetMsg.mes, settings.targetContentTags, settings.customStripTags);
    if (aiCleaned) {
        lines.push(`【${charName}】：\n${aiCleaned}`);
    }
    if (lines.length === 0) {
        // 空回复无需调用 API，但必须推进游标，避免后台队列永远卡在同一楼。
        memoryData.lastProcessedMessageId = msgIdx;
        memoryData.lastProcessedRound = roundNumber;
        if (isCurrentChat(chatKey)) await saveChatMemory();
        return true;
    }

    activeSummaryChats.add(chatKey);
    const ownsTask = !options.summaryTask;
    const task = options.summaryTask || await acquireSummaryTask({
        label: isManual ? "补总结剧情" : "自动总结剧情",
        total: 1,
        canCancel: true,
    }, () => isCurrentChat(chatKey) && epoch === summaryEpoch);
    if (!task) {
        activeSummaryChats.delete(chatKey);
        return false;
    }
    const signal = task?.controller?.signal || null;
    updateSummaryTask(task, {
        current: 1,
        total: 1,
        roundNumber,
        detail: `正在总结第 ${roundNumber} 轮`,
    });
    updateFloatingWidgetUI();
    try {
        updateStatusBar(`⏳ 正在总结第 ${roundNumber} 轮对话并更新状态账本...`);
        const result = await summarizeSingleTurn(settings, memoryData, {
            roundNumber,
            startMessageId: roundWindow.startMessageId,
            endMessageId: msgIdx,
            userName,
            charName,
            dialogueText: lines.join("\n\n"),
            onRetry: (attempt, total, error) => {
                if (!isCurrentChat(chatKey)) return;
                updateSummaryTask(task, {
                    detail: `第 ${roundNumber} 轮解析失败，正在自动重试 (${attempt - 1}/${total - 1})`,
                });
                updateStatusBar(`⏳ 第 ${roundNumber} 轮解析失败，正在自动重试 (${attempt - 1}/${total - 1})：${String(error?.message || "等待重新解析").slice(0, 80)}`, true);
            },
            shouldCommit: () => isCurrentChat(chatKey)
                && epoch === summaryEpoch
                && (isManual || getSettings().enabled)
                && !signal?.aborted
                && getChatMemory() === memoryData
                && chat[msgIdx] === targetMsg,
            signal,
        });
        if (!result) {
            if (isCurrentChat(chatKey)) {
                updateStatusBar(signal?.aborted
                    ? "⏸️ 总结已停止"
                    : "⏸️ 归档已取消：聊天已变化或切换了存档");
            }
            return false;
        }
        pruneStaleCharacters(memoryData, roundNumber, { keepNames: [ctx.name1 || ""] });
        memoryData.lastSummaryError = null;
        memoryData.lastProcessedMessageId = msgIdx;
        memoryData.lastProcessedRound = roundNumber;
        if (!isCurrentChat(chatKey)) return false;
        await saveChatMemory();
        if (isCurrentChat(chatKey) && epoch === summaryEpoch) {
            await refreshPromptInjection(aiCleaned).catch(error => {
                console.warn("[溯微] 归档已保存，但刷新提示词注入失败:", error);
            });
            syncHiddenMessagesState();
        }
        if (isCurrentChat(chatKey)) {
            updateStatusBar(`✅ 第 ${roundNumber} 轮已归档`);
        }
        return true;
    } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") {
            if (isCurrentChat(chatKey)) updateStatusBar("⏸️ 总结已停止");
            return false;
        }
        console.error("[溯微] Summarize turn error:", err?.message || err);
        if (isCurrentChat(chatKey)) {
            memoryData.lastSummaryError = {
                message: String(err?.message || "总结失败").slice(0, 300),
                roundNumber,
                at: Date.now(),
            };
            await saveChatMemory().catch(() => {});
            updateStatusBar(`❌ 总结失败: ${err.message}`, true);
        }
        return false;
    } finally {
        activeSummaryChats.delete(chatKey);
        if (ownsTask) finishSummaryTask(task);
        updateFloatingWidgetUI();
    }
}

/**
 * 依次补齐指定位置上尚未归档的 AI 轮次。
 * 自动化与手动恢复共用同一条队列，失败时停止，确保不会跨过缺口。
 */
function enqueuePendingAiTurns(chat, upToIndex, options = {}) {
    const ctx = options.ctx || getSTContext();
    if (!isActiveChatContext(ctx)) return null;
    const chatKey = options.chatKey || getChatKey();
    const epoch = options.epoch ?? summaryEpoch;
    const memoryData = options.memoryData || getChatMemory();
    const pending = collectPendingAiTurns(
        chat,
        memoryData.lastProcessedMessageId,
        upToIndex,
        getSettings().includeNativeHidden,
    );
    if (pending.length === 0) return null;

    const label = options.label || "补齐待归档轮次";
    const isManual = Boolean(options.isManual);
    let task = null;
    let stopped = false;
    let processedAny = false;
    const job = enqueueBackgroundSummary(async () => {
        task = await acquireSummaryTask({
            label,
            total: pending.length,
            canCancel: true,
        }, () => isCurrentChat(chatKey) && epoch === summaryEpoch);
        if (!task) return;
        try {
            for (let i = 0; i < pending.length; i++) {
                if (isSummaryTaskCancelled(task)) {
                    stopped = true;
                    return;
                }
                if (!isCurrentChat(chatKey) || epoch !== summaryEpoch) return;
                const pendingTurn = pending[i];
                if (chat[pendingTurn.idx] !== pendingTurn.msg) continue;
                if (memoryData.lastProcessedMessageId >= pendingTurn.idx) continue;
                updateSummaryTask(task, {
                    current: i + 1,
                    roundNumber: pendingTurn.round,
                    detail: `正在总结第 ${pendingTurn.round} 轮`,
                });
                const ok = await processSingleAiTurn(pendingTurn.idx, isManual, {
                    ctx,
                    chat,
                    chatKey,
                    memoryData,
                    epoch,
                    summaryTask: task,
                });
                if (!ok) return;
                if (isSummaryTaskCancelled(task)) {
                    stopped = true;
                    return;
                }
                processedAny = true;
            }
            if (processedAny && isCurrentChat(chatKey) && typeof options.onDone === "function") {
                await options.onDone();
            }
        } finally {
            if (stopped) {
                await saveChatMemory().catch(() => {});
                updateStatusBar(`⏸️ 已停止总结，已保存前 ${memoryData.lastProcessedRound || 0} 轮进度`);
            }
            finishSummaryTask(task);
        }
    }, label);
    return job;
}

/**
 * 玩家发送下一条消息时，把上一轮已定稿的一问一答放进后台队列。
 * 主生成不再等待摘要 API。
 */
function schedulePendingTurnsBeforeGeneration(chat, generationType) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoSummarizePerTurn) return false;
    if (!shouldSettleBeforeGeneration(generationType)) return false;
    if (!isActiveChatContext(getSTContext())) return false;

    if (!Array.isArray(chat) || chat.length < 2) return false;
    const memoryData = getChatMemory();
    const chatKey = getChatKey();
    if (isBackfilling && activeBackfillChatKey === chatKey) return false;
    const epoch = summaryEpoch;

    const lastMsg = chat[chat.length - 1];
    const settledEndIdx = lastMsg?.is_user ? chat.length - 2 : chat.length - 1;
    if (settledEndIdx <= memoryData.lastProcessedMessageId) return false;

    return enqueuePendingAiTurns(chat, settledEndIdx, {
        ctx: getSTContext(),
        chatKey,
        epoch,
        memoryData,
        label: "结算上一轮",
    });
}

/**
 * 切换到已有 swipe 时不会触发 CHARACTER_MESSAGE_RENDERED。
 * 延迟一小段时间再补总结；若紧接着开始了新生成，GENERATION_STARTED 会取消它。
 */
function scheduleAfterReplySwipeRepair(chatKey) {
    clearSwipeRepairTimer();
    const settings = getSettings();
    if (!settings.enabled
        || !settings.autoSummarizePerTurn
        || settings.summarizeTiming !== "after_reply") {
        return;
    }
    swipeRepairTimer = setTimeout(() => {
        swipeRepairTimer = null;
        if (!isCurrentChat(chatKey)) return;
        const ctx = getSTContext();
        const chat = ctx.chat || [];
        if (!Array.isArray(chat) || chat.length === 0) return;
        const lastMsg = chat[chat.length - 1];
        const upToIndex = lastMsg?.is_user ? chat.length - 2 : chat.length - 1;
        const memoryData = getChatMemory();
        if (upToIndex <= memoryData.lastProcessedMessageId) return;
        const pending = collectPendingAiTurns(
            chat,
            memoryData.lastProcessedMessageId,
            upToIndex,
            getSettings().includeNativeHidden,
        );
        if (pending.length === 0) return;
        enqueuePendingAiTurns(chat, upToIndex, {
            ctx,
            chatKey,
            epoch: summaryEpoch,
            memoryData,
            label: "补总结当前 swipe",
        });
    }, 700);
}

/**
 * 供界面显示的“历史欠账”：默认不把最新一条 AI 回复算作异常待补，
 * 因为 on_next_send 模式下它本来就要等玩家发送下一条时才结算。
 */
function getPendingBacklog(chat, memoryData) {
    if (!isActiveChatContext(getSTContext())) return [];
    if (!Array.isArray(chat) || chat.length === 0) return [];
    let upToIndex = chat.length - 1;
    const settings = getSettings();
    if (!settings.autoSummarizePerTurn && !memoryData.lastSummaryError) return [];
    const lastMsg = chat[chat.length - 1];
    if (settings.summarizeTiming === "on_next_send"
        && lastMsg
        && !lastMsg.is_user
        && !memoryData.lastSummaryError) {
        upToIndex = chat.length - 2;
    }
    return collectPendingAiTurns(
        chat,
        memoryData.lastProcessedMessageId,
        upToIndex,
        settings.includeNativeHidden,
        getCachedRoundIndex(chat, settings.includeNativeHidden),
    );
}

function renderStoryRecoveryState(memoryData = getChatMemory(), pendingOverride = null) {
    const box = document.getElementById("tiandao_story_error_box");
    const messageEl = document.getElementById("tiandao_story_error_message");
    const recoverBtn = document.getElementById("tiandao_story_recover_btn");
    if (!box || !messageEl) return;

    const activeChat = isActiveChatContext(getSTContext());
    const pending = activeChat
        ? (pendingOverride || getPendingBacklog(getSTContext().chat || [], memoryData))
        : [];
    const error = activeChat ? memoryData.lastSummaryError : null;
    if (pending.length === 0 && !error) {
        box.style.display = "none";
        return;
    }

    const errorText = error
        ? `第 ${error.roundNumber || "?"} 轮总结失败：${String(error.message || "未知错误").slice(0, 120)}`
        : "有历史轮次尚未归档。";
    messageEl.textContent = pending.length > 0
        ? `${errorText} 待补 ${pending.length} 轮。`
        : errorText;
    box.style.display = "flex";
    if (recoverBtn) {
        recoverBtn.disabled = pending.length === 0;
        recoverBtn.style.display = pending.length > 0 ? "inline-flex" : "none";
    }
}

function recoverPendingSummaries() {
    const ctx = getSTContext();
    const chat = ctx.chat || [];
    const memoryData = getChatMemory();
    const pending = getPendingBacklog(chat, memoryData);
    if (pending.length === 0) {
        updateStatusBar("✅ 当前没有待补的历史轮次");
        renderStoryRecoveryState(memoryData);
        return;
    }
    const upToIndex = pending[pending.length - 1].idx;
    const chatKey = getChatKey();
    const epoch = summaryEpoch;
    const btn = document.getElementById("tiandao_story_recover_btn");
    const job = enqueuePendingAiTurns(chat, upToIndex, {
        ctx,
        chatKey,
        epoch,
        memoryData,
        isManual: true,
        label: "手动补齐待归档轮次",
        onDone: async () => {
            memoryData.lastSummaryError = null;
            await saveChatMemory().catch(() => {});
            updateFloatingWidgetUI();
            updateStatusBar(`✅ 已补齐 ${pending.length} 轮待归档历史`);
        },
    });
    if (btn && job) {
        btn.disabled = true;
        job.finally(() => { btn.disabled = false; });
    }
}

/**
 * 「剧情」页的总结范围：按轮次选取并重整该区间。
 * fill=只补缺失（非破坏性）| view=仅筛选展示 | rebuild=从起点重做到最新
 */
function resummarizeStoryRange() {
    const ctx = getSTContext();
    const settings = getSettings();
    const chat = ctx.chat || [];
    if (chat.length === 0) {
        updateStatusBar("⚠️ 当前没有可总结的历史对话", true);
        return;
    }

    const aiTurns = buildRoundMessageIndex(chat, settings.includeNativeHidden).aiTurns
        .map(({ idx, round, msg, window }) => ({ idx, round, msg, window }));
    if (aiTurns.length === 0) {
        updateStatusBar("⚠️ 当前没有可总结的 AI 回复", true);
        return;
    }

    const latestRound = aiTurns[aiTurns.length - 1].round;
    const fromEl = document.getElementById("tiandao_story_range_from");
    const toEl = document.getElementById("tiandao_story_range_to");
    const rawFrom = String(fromEl?.value ?? "").trim();
    const rawTo = String(toEl?.value ?? "").trim();
    let fromRound = rawFrom === "" ? 1 : Math.max(1, Math.floor(Number(rawFrom)));
    let toRound = rawTo === "" ? latestRound : Math.max(1, Math.floor(Number(rawTo)));
    if (!Number.isFinite(fromRound) || !Number.isFinite(toRound)) {
        updateStatusBar("⚠️ 请输入有效的起始与结束轮次", true);
        return;
    }
    if (fromRound > toRound) {
        [fromRound, toRound] = [toRound, fromRound];
    }

    const mode = document.getElementById("tiandao_story_range_mode")?.value || "fill";
    if (mode === "view") {
        storyViewRange = (rawFrom === "" && rawTo === "") ? null : { from: fromRound, to: toRound };
        storyPage = 0;
        renderStoryTimeline();
        updateStatusBar(storyViewRange
            ? `👁️ 正在显示第 ${fromRound}-${toRound} 轮的总结`
            : "👁️ 已显示全部剧情总结");
        return;
    }

    const memoryData = getChatMemory();
    const chatKey = getChatKey();
    const epoch = summaryEpoch;
    const btn = document.getElementById("tiandao_story_range_btn");

    if (mode === "fill") {
        storyViewRange = null;
        renderStoryTimeline();
        const pendingThroughRange = collectPendingAiTurns(
            chat,
            memoryData.lastProcessedMessageId,
            Infinity,
            settings.includeNativeHidden,
        )
            .filter(turn => turn.round <= toRound);
        const pendingInRange = pendingThroughRange
            .filter(turn => turn.round >= fromRound);
        if (pendingInRange.length === 0) {
            updateStatusBar(`✅ 第 ${fromRound}-${toRound} 轮没有缺失的总结`);
            return;
        }
        const prerequisiteCount = pendingThroughRange
            .filter(turn => turn.round < fromRound).length;
        const upToIndex = pendingThroughRange[pendingThroughRange.length - 1].idx;
        if (prerequisiteCount > 0) {
            updateStatusBar(
                `⏳ 第 ${fromRound}-${toRound} 轮缺少 ${pendingInRange.length} 轮总结；将先补齐范围前 ${prerequisiteCount} 轮前置缺口`,
            );
        }
        const job = enqueuePendingAiTurns(chat, upToIndex, {
            ctx,
            chatKey,
            epoch,
            memoryData,
            isManual: true,
            label: prerequisiteCount > 0 ? "补齐范围及前置缺口" : "补齐范围缺失总结",
            onDone: async () => {
                memoryData.lastSummaryError = null;
                await saveChatMemory().catch(() => {});
                updateFloatingWidgetUI();
                updateStatusBar(
                    prerequisiteCount > 0
                        ? `✅ 第 ${fromRound}-${toRound} 轮缺失已补齐，并补齐范围前 ${prerequisiteCount} 轮前置缺口`
                        : `✅ 第 ${fromRound}-${toRound} 轮缺失总结已补齐`,
                );
            },
        });
        if (btn && job) {
            btn.disabled = true;
            job.finally(() => { btn.disabled = false; });
        }
        return;
    }

    const rebuildTurns = aiTurns.filter(turn => turn.round >= fromRound && turn.round <= toRound);
    if (rebuildTurns.length === 0) {
        updateStatusBar(`⚠️ 第 ${fromRound}-${toRound} 轮没有可重新总结的 AI 回复`, true);
        return;
    }
    runStoryResummarize(rebuildTurns, { button: btn, title: "重新总结范围" });
}

function rebuildAllStorySummaries() {
    const chat = getSTContext().chat || [];
    const settings = getSettings();
    const aiTurns = buildRoundMessageIndex(chat, settings.includeNativeHidden).aiTurns
        .map(({ idx, round, msg, window }) => ({ idx, round, msg, window }));
    const btn = document.getElementById("tiandao_story_rebuild_all_btn");
    runStoryResummarize(aiTurns, { button: btn, title: "重新总结全部" });
}

function resummarizeStoryEntry(lvl, idx, button = null) {
    const item = getChatMemory()?.levels?.[lvl]?.[idx];
    if (!item) {
        updateStatusBar("⚠️ 该剧情条目已不存在，请刷新后重试", true);
        return;
    }
    const range = parseRoundRange(item.roundRange);
    const chat = getSTContext().chat || [];
    const settings = getSettings();
    const turns = buildRoundMessageIndex(chat, settings.includeNativeHidden).aiTurns
        .filter(turn => turn.round >= range.start && turn.round <= range.end)
        .map(({ idx, round, msg, window }) => ({ idx, round, msg, window }));
    if (turns.length === 0) {
        updateStatusBar(`⚠️ 第 ${item.roundRange} 轮没有可重新总结的剧情原文`, true);
        return;
    }
    runStoryResummarize(turns, {
        button,
        requireConfirm: turns.length > 1,
        title: `重新总结第 ${item.roundRange} 轮`,
    });
}

window.tiandaoResummarizeStoryEntry = (lvl, idx) => {
    const entry = document.querySelector(
        `.tiandao-story-entry[data-lvl="${lvl}"][data-idx="${idx}"]`
    );
    const button = entry?.querySelector(".tiandao-entry-resummarize-btn") || null;
    resummarizeStoryEntry(lvl, idx, button);
};

// ==================== 🌌 “溯微” 实时记忆悬浮窗 (Floating Widget) ====================
let isWidgetExpanded = false;
const MOBILE_WIDGET_MEDIA = "(max-width: 600px)";

function isMobileWidgetViewport() {
    return typeof window.matchMedia === "function"
        ? window.matchMedia(MOBILE_WIDGET_MEDIA).matches
        : window.innerWidth <= 600;
}

function ensureChoiceMenu(menuId, ariaLabel) {
    let menu = document.getElementById(menuId);
    if (menu) return menu;
    menu = document.createElement("div");
    menu.id = menuId;
    menu.className = "tiandao-model-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", ariaLabel);
    menu.hidden = true;
    document.body.appendChild(menu);
    return menu;
}

function closeChoiceMenu(menuId, inputId, toggleId) {
    const menu = document.getElementById(menuId);
    if (menu) menu.hidden = true;
    const input = document.getElementById(inputId);
    input?.setAttribute("aria-expanded", "false");
    const toggle = document.getElementById(toggleId);
    if (toggle) {
        toggle.setAttribute("aria-expanded", "false");
        toggle.querySelector("i")?.classList.replace("fa-chevron-up", "fa-chevron-down");
    }
}

function positionChoiceMenu(menu, input) {
    const rect = input.getBoundingClientRect();
    const width = Math.max(180, rect.width);
    const margin = 8;
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openAbove = spaceBelow < 140 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(280, openAbove ? spaceAbove : spaceBelow));
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    if (openAbove) {
        menu.style.top = "auto";
        menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.bottom = "auto";
    }
    menu.scrollTop = 0;
}

function fillChoiceMenu(menu, {
    names,
    current,
    manualLabel,
    onManual,
    onChoose,
    onEscape,
}) {
    menu.replaceChildren();
    if (manualLabel) {
        const manualOption = document.createElement("button");
        manualOption.type = "button";
        manualOption.className = "tiandao-model-option tiandao-model-manual";
        manualOption.setAttribute("role", "option");
        manualOption.textContent = manualLabel;
        manualOption.addEventListener("click", onManual);
        menu.appendChild(manualOption);
    }
    for (const name of names) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = `tiandao-model-option${name === current ? " selected" : ""}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", name === current ? "true" : "false");
        option.textContent = name;
        option.title = name;
        option.addEventListener("click", () => onChoose(name));
        option.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onEscape();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                const options = [...menu.querySelectorAll(".tiandao-model-option")];
                const index = options.indexOf(option);
                options[(index + delta + options.length) % options.length]?.focus();
            }
        });
        menu.appendChild(option);
    }
}

function ensureModelMenu() {
    return ensureChoiceMenu("tiandao_model_menu", "可用模型");
}

function closeModelMenu() {
    closeChoiceMenu("tiandao_model_menu", "tiandao_model", "tiandao_model_toggle_btn");
}

function openModelMenu() {
    const input = document.getElementById("tiandao_model");
    const menu = ensureModelMenu();
    if (!input || fetchedModelNames.length === 0) {
        closeModelMenu();
        return;
    }
    const current = input.value.trim();
    fillChoiceMenu(menu, {
        names: fetchedModelNames,
        current,
        manualLabel: "手动输入模型名称",
        onManual: () => {
            closeModelMenu();
            input.focus();
        },
        onChoose: (name) => {
            input.value = name;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            closeModelMenu();
            if (!isMobileWidgetViewport()) input.focus();
        },
        onEscape: () => {
            closeModelMenu();
            input.focus();
        },
    });

    menu.hidden = false;
    positionChoiceMenu(menu, input);

    input.setAttribute("aria-expanded", "true");
    const toggle = document.getElementById("tiandao_model_toggle_btn");
    if (toggle) {
        toggle.setAttribute("aria-expanded", "true");
        toggle.querySelector("i")?.classList.replace("fa-chevron-down", "fa-chevron-up");
    }
}

function setFetchedModelNames(names) {
    fetchedModelNames = [...new Set((Array.isArray(names) ? names : [])
        .map(name => String(name || "").trim())
        .filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const datalist = document.getElementById("tiandao_model_datalist");
    if (datalist) {
        const frag = document.createDocumentFragment();
        for (const name of fetchedModelNames) {
            const option = document.createElement("option");
            option.value = name;
            frag.appendChild(option);
        }
        datalist.replaceChildren(frag);
    }
    const toggle = document.getElementById("tiandao_model_toggle_btn");
    if (toggle) toggle.disabled = fetchedModelNames.length === 0;
    if (fetchedModelNames.length === 0) closeModelMenu();
}

function getModelsEndpoint(baseUrl) {
    const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (normalized.endsWith("/models")) return normalized;
    if (normalized.endsWith("/chat/completions")) {
        return `${normalized.slice(0, -"/chat/completions".length)}/models`;
    }
    if (normalized.endsWith("/embeddings")) {
        return `${normalized.slice(0, -"/embeddings".length)}/models`;
    }
    return `${normalized}/models`;
}

function isEmbeddingModelName(name) {
    return /(?:embed|bge|m3e|(?:^|[/_.:-])e5(?:[-/_.:]|$)|gte-|jina|nomic|voyage|mxbai)/i
        .test(String(name || ""));
}

function getVisibleEmbeddingModelNames() {
    const onlyEmbedding = getSettings().embeddingModelFilterOnly !== false;
    return onlyEmbedding
        ? fetchedEmbeddingModelNames.filter(isEmbeddingModelName)
        : fetchedEmbeddingModelNames.slice();
}

function refreshEmbeddingModelOptions() {
    const visibleNames = getVisibleEmbeddingModelNames();
    const datalist = document.getElementById("tiandao_emb_model_datalist");
    if (datalist) {
        const frag = document.createDocumentFragment();
        for (const name of visibleNames) {
            const option = document.createElement("option");
            option.value = name;
            frag.appendChild(option);
        }
        datalist.replaceChildren(frag);
    }
    const toggle = document.getElementById("tiandao_emb_model_toggle_btn");
    if (toggle) toggle.disabled = visibleNames.length === 0;
    if (visibleNames.length === 0) closeEmbeddingModelMenu();
    return visibleNames;
}

function ensureEmbeddingModelMenu() {
    return ensureChoiceMenu("tiandao_emb_model_menu", "可用向量模型");
}

function closeEmbeddingModelMenu() {
    closeChoiceMenu(
        "tiandao_emb_model_menu",
        "tiandao_emb_model",
        "tiandao_emb_model_toggle_btn",
    );
}

function openEmbeddingModelMenu() {
    const input = document.getElementById("tiandao_emb_model");
    const menu = ensureEmbeddingModelMenu();
    const names = getVisibleEmbeddingModelNames();
    if (!input || names.length === 0) {
        closeEmbeddingModelMenu();
        return;
    }
    const current = input.value.trim();
    fillChoiceMenu(menu, {
        names,
        current,
        manualLabel: "手动输入向量模型名称",
        onManual: () => {
            closeEmbeddingModelMenu();
            input.focus();
        },
        onChoose: (name) => {
            input.value = name;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            closeEmbeddingModelMenu();
            if (!isMobileWidgetViewport()) input.focus();
        },
        onEscape: () => {
            closeEmbeddingModelMenu();
            input.focus();
        },
    });
    menu.hidden = false;
    positionChoiceMenu(menu, input);

    input.setAttribute("aria-expanded", "true");
    const toggle = document.getElementById("tiandao_emb_model_toggle_btn");
    if (toggle) {
        toggle.setAttribute("aria-expanded", "true");
        toggle.querySelector("i")?.classList.replace("fa-chevron-down", "fa-chevron-up");
    }
}

function setFetchedEmbeddingModelNames(names) {
    fetchedEmbeddingModelNames = [...new Set((Array.isArray(names) ? names : [])
        .map(name => String(name || "").trim())
        .filter(Boolean))].sort((a, b) => a.localeCompare(b));
    refreshEmbeddingModelOptions();
}

function initFloatingWidget() {
    let widget = document.getElementById("tiandao_floating_widget");
    if (widget) {
        ensureModelMenu();
        ensureEmbeddingModelMenu();
        return;
    }

    applyWidgetAppearance();

    widget = document.createElement("div");
    widget.id = "tiandao_floating_widget";
    widget.innerHTML = `
        <div id="tiandao_widget_pill" class="tiandao-widget-pill" role="button" tabindex="0" aria-expanded="false" aria-controls="tiandao_widget_card" title="溯微长线记忆引擎 (点击展开/折叠，可任意拖拽)">
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

            <div id="tiandao_status_bar" class="tiandao-status-bar" style="display:none;">
                <i class="fa-solid fa-circle-dot" style="font-size:0.75em; opacity:0.8;"></i> <span class="tiandao-status-text">当前状态：就绪</span>
            </div>

            <div id="tiandao_summary_progress" class="tiandao-summary-progress" style="display:none;" role="status" aria-live="polite">
                <div class="tiandao-summary-progress-head">
                    <div class="tiandao-summary-progress-copy">
                        <div id="tiandao_summary_progress_title" class="tiandao-summary-progress-title">正在总结</div>
                        <div id="tiandao_summary_progress_detail" class="tiandao-summary-progress-detail">准备开始</div>
                    </div>
                    <div class="tiandao-summary-progress-actions">
                        <span id="tiandao_summary_progress_counter" class="tiandao-summary-progress-counter"></span>
                        <button type="button" id="tiandao_summary_progress_stop" class="tiandao-summary-progress-stop">
                            <i class="fa-solid fa-stop"></i><span>停止</span>
                        </button>
                    </div>
                </div>
                <div class="tiandao-summary-progress-track" aria-hidden="true">
                    <div id="tiandao_summary_progress_bar" class="tiandao-summary-progress-bar"></div>
                </div>
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
                    <div id="tiandao_story_error_box" class="tiandao-story-error-box" style="display:none;">
                        <div class="tiandao-story-error-text">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            <span id="tiandao_story_error_message"></span>
                        </div>
                        <button type="button" id="tiandao_story_recover_btn" class="tiandao-btn tiandao-btn-sm">
                            <i class="fa-solid fa-rotate-right"></i> 立即补总结
                        </button>
                    </div>
                    <div class="tiandao-story-range-bar">
                        <span class="tiandao-story-range-label">轮次</span>
                        <input id="tiandao_story_range_from" type="number" min="1" class="tiandao-input tiandao-input-sm" placeholder="起始" aria-label="起始轮次" />
                        <span class="tiandao-story-range-dash">-</span>
                        <input id="tiandao_story_range_to" type="number" min="1" class="tiandao-input tiandao-input-sm" placeholder="结束" aria-label="结束轮次" />
                        <select id="tiandao_story_range_mode" class="tiandao-select tiandao-story-range-mode" aria-label="总结范围操作">
                            <option value="fill">补缺失+前置</option>
                            <option value="view">仅筛选查看</option>
                            <option value="rebuild">重新总结</option>
                        </select>
                        <button type="button" id="tiandao_story_range_btn" class="tiandao-btn tiandao-btn-sm" title="重新总结所选轮次范围">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 执行
                        </button>
                    </div>
                    <div class="tiandao-story-bulk-bar">
                        <label class="tiandao-story-sort-control" title="切换时间线排序方向">
                            <span>排序</span>
                            <select id="tiandao_story_sort_order" class="tiandao-select tiandao-story-sort-select" aria-label="时间线排序方向">
                                <option value="desc" selected>倒序</option>
                                <option value="asc">正序</option>
                            </select>
                        </label>
                        <button type="button" id="tiandao_story_rebuild_all_btn" class="tiandao-btn tiandao-btn-sm">
                            <i class="fa-solid fa-arrows-rotate"></i> 重新总结全部
                        </button>
                    </div>
                    <div id="tiandao_story_page_timeline" class="tiandao-story-page"></div>
                </div>

                <!-- Tab 3: 溯微设置（二级分页：运行 / API / 数据 / 外观） -->
                <div id="tiandao_tab_settings_content" class="tiandao-tab-page" style="display: none;">
                    <div class="tiandao-subtabs">
                        <button type="button" class="tiandao-subtab active" data-page="run"><i class="fa-solid fa-sliders"></i> 运行</button>
                        <button type="button" class="tiandao-subtab" data-page="api"><i class="fa-solid fa-plug"></i> API</button>
                        <button type="button" class="tiandao-subtab" data-page="data"><i class="fa-solid fa-database"></i> 数据</button>
                        <button type="button" class="tiandao-subtab" data-page="appearance"><i class="fa-solid fa-palette"></i> 外观</button>
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
                                    <span class="tiandao-field-label">解析/请求失败自动重试次数</span>
                                    <input id="tiandao_summary_retry" type="number" class="tiandao-input tiandao-input-sm" min="0" max="5" placeholder="2" />
                                </div>
                                <div class="tiandao-form-row">
                                    <span class="tiandao-field-label">总结触发时机</span>
                                    <select id="tiandao_summarize_timing" class="tiandao-select">
                                        <option value="on_next_send">发送下一条时 (重Roll零消耗·推荐)</option>
                                        <option value="after_reply">AI 回复完成后立即总结</option>
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
                                        <input id="tiandao_keep_recent" type="number" class="tiandao-input tiandao-input-sm" min="1" max="25" placeholder="5" />
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
                                    <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:6px 8px; margin-bottom:4px;">
                                        <label class="tiandao-field-caption" style="margin:0;">Embedding 模型</label>
                                        <button type="button" id="tiandao_fetch_embedding_models_btn" class="tiandao-link-btn" title="使用上方 Embedding 地址与 Key 拉取向量模型">
                                            <i class="fa-solid fa-cloud-arrow-down"></i> 拉取向量模型
                                        </button>
                                    </div>
                                    <div class="tiandao-input-wrapper">
                                        <i class="fa-solid fa-vector-square tiandao-input-icon"></i>
                                        <input id="tiandao_emb_model" type="text" class="tiandao-input with-icon has-model-toggle" list="tiandao_emb_model_datalist" placeholder="BAAI/bge-m3" autocomplete="off" aria-haspopup="listbox" aria-expanded="false" />
                                        <button type="button" id="tiandao_emb_model_toggle_btn" class="tiandao-model-toggle" title="展开已拉取的向量模型列表" aria-label="展开已拉取的向量模型列表" disabled>
                                            <i class="fa-solid fa-chevron-down"></i>
                                        </button>
                                        <datalist id="tiandao_emb_model_datalist"></datalist>
                                    </div>
                                    <label class="tiandao-inline-check" title="关闭后会显示该渠道返回的全部模型">
                                        <input id="tiandao_emb_filter_models" type="checkbox" class="tiandao-checkbox" checked />
                                        <span>只显示向量 / Embedding 模型</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 设置分页 2 · API -->
                    <div class="tiandao-settings-page" data-page="api" style="display: none;">
                        <div class="tiandao-card-panel">
                            <div class="tiandao-panel-title">
                                <i class="fa-solid fa-bookmark"></i> API 配置档案
                            </div>
                            <div class="tiandao-api-profile-row">
                                <select id="tiandao_api_profile_select" class="tiandao-select tiandao-api-profile-select" aria-label="已保存的 API 配置"></select>
                                <button type="button" id="tiandao_api_profile_delete_btn" class="tiandao-btn tiandao-btn-sm tiandao-btn-danger" disabled>
                                    删除
                                </button>
                            </div>
                            <div class="tiandao-api-profile-save-row">
                                <input id="tiandao_api_profile_name" type="text" class="tiandao-input" maxlength="80" placeholder="配置名称，例如 DeepSeek" aria-label="API 配置名称" />
                                <button type="button" id="tiandao_api_profile_save_btn" class="tiandao-btn tiandao-btn-sm tiandao-btn-primary">
                                    保存当前
                                </button>
                            </div>
                            <div class="tiandao-field-caption tiandao-api-profile-hint">
                                保存地址、Key、模型与生成参数，切换后立即生效。
                            </div>
                        </div>

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
                                    <input id="tiandao_model" type="text" class="tiandao-input with-icon has-model-toggle" list="tiandao_model_datalist" placeholder="" autocomplete="off" aria-haspopup="listbox" aria-expanded="false" />
                                    <button type="button" id="tiandao_model_toggle_btn" class="tiandao-model-toggle" title="展开已拉取的模型列表" aria-label="展开已拉取的模型列表" disabled>
                                        <i class="fa-solid fa-chevron-down"></i>
                                    </button>
                                    <datalist id="tiandao_model_datalist"></datalist>
                                </div>
                            </div>

                            <div class="tiandao-form-row" style="margin-top: 8px;">
                                <span class="tiandao-field-label">总结温度 (Temperature)</span>
                                <input id="tiandao_temp" type="number" step="0.05" min="0" max="1.5" class="tiandao-input tiandao-input-sm" placeholder="0.2" />
                            </div>
                            <label class="tiandao-toggle-row">
                                <span class="tiandao-toggle-label">启用 JSON 模式（不支持时自动回退）</span>
                                <input id="tiandao_use_json_mode" type="checkbox" class="tiandao-checkbox" />
                            </label>

                            <div class="tiandao-input-block" style="margin-top: 8px;">
                                <label class="tiandao-field-caption">🎯 目标正文提取标签（白名单优先）</label>
                                <input id="tiandao_target_tags" type="text" class="tiandao-input" placeholder="" />
                                <div class="tiandao-field-caption" style="margin:5px 0 0;">
                                    英文逗号、中文逗号或空格均可分隔，例如 content, story, reply。标签名不必带尖括号，大小写不敏感；多个目标标签会按填写顺序尝试。
                                </div>
                            </div>

                            <div class="tiandao-input-block">
                                <label class="tiandao-field-caption">备用排除标签（黑名单）</label>
                                <input id="tiandao_strip_tags" type="text" class="tiandao-input" placeholder="" />
                                <div class="tiandao-field-caption" style="margin:5px 0 0;">
                                    同样使用英文逗号、中文逗号或空格分隔，例如 thinking, status_bar。匹配到的整个标签块会从正文中移除。两项都留空时，玩家输入与 AI 回复会完整进入单轮总结；楼层显示时间属于酒馆元数据，不等同于剧情内时间。
                                </div>
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
                            <div class="tiandao-panel-divider"></div>
                            <label class="tiandao-toggle-row">
                                <span class="tiandao-toggle-label">轮次计算与总结包含酒馆原生隐藏楼层</span>
                                <input id="tiandao_include_native_hidden" type="checkbox" class="tiandao-checkbox" />
                            </label>
                            <div class="tiandao-field-caption" style="margin:5px 0 0;">
                                影响扫描、自动归档与时序裁剪。隐藏楼层必须属于剧情正文才开启；切换后建议立即重新扫描或重建，避免新旧轮次错位。
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

                    <!-- 设置分页 4 · 外观 -->
                    <div class="tiandao-settings-page" data-page="appearance" style="display: none;">
                        <div class="tiandao-card-panel">
                            <div class="tiandao-panel-title">
                                <i class="fa-solid fa-palette"></i> 界面外观
                            </div>
                            <div class="tiandao-appearance-preview" aria-hidden="true">
                                <div class="tiandao-appearance-preview-title">溯微 · 剧情时间线</div>
                                <div class="tiandao-appearance-preview-copy">第 128 轮 · 雨夜，檐下的灯火仍然亮着。</div>
                            </div>
                            <div class="tiandao-form-row">
                                <span class="tiandao-field-label">看板主题</span>
                                <select id="tiandao_widget_theme" class="tiandao-select">
                                    <option value="porcelain">瓷白精修 · 清透纸感</option>
                                    <option value="journal">书页叙事 · 暖纸墨痕</option>
                                </select>
                            </div>
                            <div class="tiandao-form-row">
                                <span class="tiandao-field-label">界面字体</span>
                                <select id="tiandao_font_family" class="tiandao-select">
                                    <option value="inherit">跟随酒馆</option>
                                    <option value="sans">现代无衬线</option>
                                    <option value="serif">书卷宋体</option>
                                </select>
                            </div>
                            <div class="tiandao-input-block tiandao-font-scale-block">
                                <div class="tiandao-range-heading">
                                    <label class="tiandao-field-caption" for="tiandao_font_scale">字号大小</label>
                                    <output id="tiandao_font_scale_value" class="tiandao-range-value" for="tiandao_font_scale">100%</output>
                                </div>
                                <input id="tiandao_font_scale" type="range" min="85" max="130" step="5" class="tiandao-range" />
                                <div class="tiandao-range-ticks" aria-hidden="true">
                                    <span>紧凑</span>
                                    <span>默认</span>
                                    <span>宽松</span>
                                </div>
                            </div>
                            <div class="tiandao-panel-divider"></div>
                            <button type="button" id="tiandao_reset_appearance_btn" class="tiandao-btn tiandao-btn-full">
                                <i class="fa-solid fa-rotate-left"></i> 恢复默认外观
                            </button>
                            <div class="tiandao-field-caption tiandao-appearance-hint">
                                只影响溯微悬浮窗与记忆弹窗，不改变酒馆本身的显示设置。
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
            </div>
        </div>
    `;
    document.body.appendChild(widget);
    ensureModelMenu();
    ensureEmbeddingModelMenu();

    const pill = document.getElementById("tiandao_widget_pill");
    const card = document.getElementById("tiandao_widget_card");
    const closeBtn = document.getElementById("tiandao_widget_close_btn");
    const tabLedgerBtn = document.getElementById("tiandao_tab_ledger_btn");
    const tabStoryBtn = document.getElementById("tiandao_tab_story_btn");
    const tabSettingsBtn = document.getElementById("tiandao_tab_settings_btn");
    const tabLedgerContent = document.getElementById("tiandao_tab_ledger_content");
    const tabStoryContent = document.getElementById("tiandao_tab_story_content");
    const tabSettingsContent = document.getElementById("tiandao_tab_settings_content");
    document.getElementById("tiandao_summary_progress_stop")
        ?.addEventListener("click", requestSummaryTaskStop);
    const modelInput = document.getElementById("tiandao_model");
    const modelToggle = document.getElementById("tiandao_model_toggle_btn");
    modelToggle?.addEventListener("click", () => {
        const menu = document.getElementById("tiandao_model_menu");
        if (!menu || menu.hidden) openModelMenu();
        else closeModelMenu();
    });
    modelInput?.addEventListener("click", () => {
        const menu = document.getElementById("tiandao_model_menu");
        if (fetchedModelNames.length > 0 && (!menu || menu.hidden)) openModelMenu();
    });
    modelInput?.addEventListener("pointerdown", (event) => {
        if (isMobileWidgetViewport() && fetchedModelNames.length > 0) {
            event.preventDefault();
            openModelMenu();
        }
    });
    modelInput?.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" && fetchedModelNames.length > 0) {
            event.preventDefault();
            openModelMenu();
            document.querySelector("#tiandao_model_menu .tiandao-model-option")?.focus();
        } else if (event.key === "Escape") {
            closeModelMenu();
        }
    });
    const embModelInput = document.getElementById("tiandao_emb_model");
    const embModelToggle = document.getElementById("tiandao_emb_model_toggle_btn");
    embModelToggle?.addEventListener("click", () => {
        const menu = document.getElementById("tiandao_emb_model_menu");
        if (!menu || menu.hidden) openEmbeddingModelMenu();
        else closeEmbeddingModelMenu();
    });
    embModelInput?.addEventListener("click", () => {
        const menu = document.getElementById("tiandao_emb_model_menu");
        if (getVisibleEmbeddingModelNames().length > 0 && (!menu || menu.hidden)) {
            openEmbeddingModelMenu();
        }
    });
    embModelInput?.addEventListener("pointerdown", (event) => {
        if (isMobileWidgetViewport() && getVisibleEmbeddingModelNames().length > 0) {
            event.preventDefault();
            openEmbeddingModelMenu();
        }
    });
    embModelInput?.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" && getVisibleEmbeddingModelNames().length > 0) {
            event.preventDefault();
            openEmbeddingModelMenu();
            document.querySelector("#tiandao_emb_model_menu .tiandao-model-option")?.focus();
        } else if (event.key === "Escape") {
            closeEmbeddingModelMenu();
        }
    });
    document.addEventListener("pointerdown", (event) => {
        const modelMenu = document.getElementById("tiandao_model_menu");
        if (modelMenu && !modelMenu.hidden
            && !modelMenu.contains(event.target)
            && !modelInput?.contains(event.target)
            && !modelToggle?.contains(event.target)) {
            closeModelMenu();
        }
        const embeddingMenu = document.getElementById("tiandao_emb_model_menu");
        if (embeddingMenu && !embeddingMenu.hidden
            && !embeddingMenu.contains(event.target)
            && !embModelInput?.contains(event.target)
            && !embModelToggle?.contains(event.target)) {
            closeEmbeddingModelMenu();
        }
    }, true);
    window.addEventListener("resize", () => {
        closeModelMenu();
        closeEmbeddingModelMenu();
    });
    window.addEventListener("scroll", (event) => {
        const modelMenu = document.getElementById("tiandao_model_menu");
        const embeddingMenu = document.getElementById("tiandao_emb_model_menu");
        const target = event.target;
        const scrollingInsideModelMenu = modelMenu && !modelMenu.hidden
            && (target === modelMenu || modelMenu.contains(target));
        const scrollingInsideEmbeddingMenu = embeddingMenu && !embeddingMenu.hidden
            && (target === embeddingMenu || embeddingMenu.contains(target));
        if (!scrollingInsideModelMenu) closeModelMenu();
        if (!scrollingInsideEmbeddingMenu) closeEmbeddingModelMenu();
    }, true);

    // 展开/折叠：展开后用卡片头作为拖拽锚点，胶囊本体暂时隐藏。
    const setWidgetExpanded = (expanded) => {
        pill.setAttribute("aria-expanded", expanded ? "true" : "false");
        if (expanded) {
            // 先按胶囊当前位置决定展开方向，再切换到卡片锚点，避免量到卡片自身。
            isWidgetExpanded = false;
            positionFloatingWidgetCard();
            isWidgetExpanded = true;
            widget.classList.add("tiandao-widget-expanded");
            card.style.display = "flex";
            pill.style.display = "none";
            updateFloatingWidgetUI();
        } else {
            isWidgetExpanded = false;
            widget.classList.remove("tiandao-widget-expanded");
            card.style.display = "none";
            pill.style.display = "inline-flex";
        }
    };

    pill.addEventListener("click", () => setWidgetExpanded(!isWidgetExpanded));
    pill.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setWidgetExpanded(!isWidgetExpanded);
        }
    });

    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setWidgetExpanded(false);
    });

    const ledgerBody = document.getElementById("tiandao_widget_body_inner");
    if (ledgerBody) {
        ledgerBody.addEventListener("click", (event) => {
            const characterToggle = event.target.closest("[data-char-toggle]");
            if (characterToggle) {
                const card = characterToggle.closest(".tiandao-char-card");
                const body = card?.querySelector(".tiandao-char-body");
                if (!card || !body) return;
                const expand = characterToggle.getAttribute("aria-expanded") !== "true";
                const key = `${getChatKey()}::${characterToggle.dataset.charToggle || ""}`;
                characterToggle.setAttribute("aria-expanded", expand ? "true" : "false");
                card.classList.toggle("tiandao-char-expanded", expand);
                body.hidden = !expand;
                characterToggle.querySelector(".tiandao-char-chevron")?.classList.toggle("expanded", expand);
                if (expand) expandedCharacterCards.add(key);
                else expandedCharacterCards.delete(key);
                return;
            }

            const itemToggle = event.target.closest("[data-item-toggle]");
            if (itemToggle) {
                const section = itemToggle.closest(".tiandao-char-item-section");
                const list = section?.querySelector(".tiandao-item-list");
                if (!section || !list) return;
                const expand = itemToggle.getAttribute("aria-expanded") !== "true";
                const key = `${getChatKey()}::${itemToggle.dataset.itemToggle || ""}`;
                itemToggle.setAttribute("aria-expanded", expand ? "true" : "false");
                list.hidden = !expand;
                itemToggle.querySelector(".tiandao-item-chevron")?.classList.toggle("expanded", expand);
                if (expand) expandedInventoryCards.add(key);
                else expandedInventoryCards.delete(key);
                return;
            }

            const deleteButton = event.target.closest("[data-delete-item]");
            if (deleteButton) {
                deleteLedgerItem(
                    deleteButton.dataset.charName || "",
                    deleteButton.dataset.deleteItem || "",
                    Number(deleteButton.dataset.itemIndex),
                    deleteButton,
                );
            }
        });
        ledgerBody.addEventListener("change", (event) => {
            const checkbox = event.target.closest(".tiandao-todo-check");
            if (!checkbox) return;
            updateTodoCompletion(checkbox.dataset.todoId, checkbox.checked);
        });
    }

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
        renderStoryRecoveryState();
    });

    const storyRangeBtn = document.getElementById("tiandao_story_range_btn");
    if (storyRangeBtn) storyRangeBtn.addEventListener("click", resummarizeStoryRange);
    const storyRebuildAllBtn = document.getElementById("tiandao_story_rebuild_all_btn");
    if (storyRebuildAllBtn) storyRebuildAllBtn.addEventListener("click", rebuildAllStorySummaries);
    const storyRangeMode = document.getElementById("tiandao_story_range_mode");
    const syncStoryRangeModeUi = () => {
        if (!storyRangeBtn || !storyRangeMode) return;
        const mode = storyRangeMode.value;
        const config = {
            fill: { text: "补齐", title: "补齐所选范围内的缺失；若范围内前面有断档，会先补齐前置轮次" },
            view: { text: "筛选", title: "只筛选时间线显示，不调用总结 API" },
            rebuild: { text: "总结", title: "从起始轮重新总结到结束轮" },
        }[mode] || { text: "执行", title: "执行范围操作" };
        storyRangeBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> ${config.text}`;
        storyRangeBtn.title = config.title;
    };
    if (storyRangeMode) storyRangeMode.addEventListener("change", syncStoryRangeModeUi);
    syncStoryRangeModeUi();
    const storySortSelect = document.getElementById("tiandao_story_sort_order");
    if (storySortSelect) {
        storySortSelect.addEventListener("change", () => {
            if (storyEditingKey) {
                storySortSelect.value = storySortOrder;
                updateStatusBar("⚠️ 请先保存或取消正在编辑的剧情总结", true);
                return;
            }
            storySortOrder = storySortSelect.value === "asc" ? "asc" : "desc";
            storyPage = 0;
            renderStoryTimeline();
            const body = document.getElementById("tiandao_widget_body");
            if (body) body.scrollTop = 0;
        });
    }
    const storyRecoverBtn = document.getElementById("tiandao_story_recover_btn");
    if (storyRecoverBtn) storyRecoverBtn.addEventListener("click", recoverPendingSummaries);
    tabStoryContent.addEventListener("click", (event) => {
        const button = event.target.closest("[data-story-page]");
        if (!button || button.disabled) return;
        if (storyEditingKey) {
            updateStatusBar("⚠️ 请先保存或取消正在编辑的剧情总结", true);
            return;
        }
        const pageKey = button.dataset.storyPage;
        if (storySortOrder === "desc") {
            storyPage += pageKey === "older" ? 1 : -1;
        } else {
            storyPage += pageKey === "older" ? -1 : 1;
        }
        storyPage = Math.max(0, storyPage);
        renderStoryTimeline();
        const body = document.getElementById("tiandao_widget_body");
        if (body) body.scrollTop = 0;
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
                const endpoint = getModelsEndpoint(baseUrl);
                const headers = {};
                if (settings.apiKey && settings.apiKey.trim()) {
                    headers["Authorization"] = `Bearer ${settings.apiKey.trim()}`;
                }
                const res = await fetchWithTimeout(endpoint, { method: "GET", headers }, 20_000);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const responseText = await readResponseText(res, 20_000);
                const data = JSON.parse(responseText);
                const raw = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
                const names = raw
                    .map(x => (typeof x === "string" ? x : (x?.id || x?.name || "")))
                    .filter(Boolean);
                setFetchedModelNames(names);
                if (fetchedModelNames.length > 0) {
                    updateStatusBar(`✅ 已拉取 ${fetchedModelNames.length} 个模型，点击模型输入框或右侧箭头即可选择`);
                    openModelMenu();
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

    const fetchEmbeddingModelsBtn = document.getElementById("tiandao_fetch_embedding_models_btn");
    if (fetchEmbeddingModelsBtn) {
        fetchEmbeddingModelsBtn.addEventListener("click", async () => {
            flushSettingInputs();
            const settings = getSettings();
            const baseUrl = (settings.embeddingApiUrl || "").trim().replace(/\/+$/, "");
            if (!baseUrl) {
                updateStatusBar("❌ 请先填写 Embedding URL", true);
                return;
            }
            try {
                updateStatusBar("⏳ 正在获取向量模型列表...");
                fetchEmbeddingModelsBtn.disabled = true;
                const endpoint = getModelsEndpoint(baseUrl);
                const headers = {};
                if (settings.embeddingApiKey && settings.embeddingApiKey.trim()) {
                    headers["Authorization"] = `Bearer ${settings.embeddingApiKey.trim()}`;
                }
                const res = await fetchWithTimeout(endpoint, { method: "GET", headers }, 20_000);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const responseText = await readResponseText(res, 20_000);
                const data = JSON.parse(responseText);
                const raw = Array.isArray(data?.data)
                    ? data.data
                    : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
                const names = raw
                    .map(x => (typeof x === "string" ? x : (x?.id || x?.name || "")))
                    .filter(Boolean);
                setFetchedEmbeddingModelNames(names);
                const visibleNames = getVisibleEmbeddingModelNames();
                if (visibleNames.length > 0) {
                    updateStatusBar(`✅ 已拉取 ${visibleNames.length} 个向量模型，点击输入框或右侧箭头即可选择`);
                    openEmbeddingModelMenu();
                } else if (fetchedEmbeddingModelNames.length > 0) {
                    updateStatusBar(
                        `⚠️ 已拉取 ${fetchedEmbeddingModelNames.length} 个模型，但未识别出向量模型；可关闭筛选后手动选择`,
                        true,
                    );
                } else {
                    updateStatusBar("⚠️ 渠道未返回模型列表，请手动输入向量模型名称", true);
                }
            } catch (err) {
                updateStatusBar(`❌ 拉取向量模型失败: ${String(err.message || err).slice(0, 160)}`, true);
            } finally {
                fetchEmbeddingModelsBtn.disabled = false;
            }
        });
    }

    makeDraggable(widget, pill, { onDragMove: positionFloatingWidgetCard });
    // 卡片头部空白处也可拖拽（按钮与输入框不受影响）；移动端展开后固定在视口中央。
    const cardHeaderEl = card.querySelector(".tiandao-card-header");
    if (cardHeaderEl) {
        makeDraggable(widget, cardHeaderEl, {
            onDragMove: positionFloatingWidgetCard,
            canDrag: () => !(isWidgetExpanded && isMobileWidgetViewport()),
        });
    }
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

    if (isMobileWidgetViewport()) {
        card.classList.remove("tiandao-open-leftward", "tiandao-open-rightward", "tiandao-open-upward");
        if (isWidgetExpanded) {
            // 移动端展开面板由铺满视口的外层容器居中，清掉桌面端遗留的内联几何值。
            ["left", "right", "top", "bottom", "width", "height", "max-height"]
                .forEach(prop => card.style.removeProperty(prop));
        }
        return;
    }

    if (isWidgetExpanded) return;

    const rect = widget.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const desiredWidth = Math.min(vw <= 600 ? 345 : 372, vw - 20);

    // 按左右两侧真正剩余的空间换向。右上角的胶囊右侧空间通常不足，
    // 必须向左展开；不能只看胶囊到屏幕左边缘的距离。
    const spaceRight = Math.max(0, vw - rect.left - 10);
    const spaceLeft = Math.max(0, rect.right - 10);
    const openRightward = spaceRight >= desiredWidth
        && (spaceRight >= spaceLeft || spaceLeft < desiredWidth);
    const spaceBelow = vh - rect.bottom - 10;
    const spaceAbove = rect.top - 10;
    const openUpward = spaceBelow < Math.min(340, vh * 0.55) && spaceAbove > spaceBelow;

    card.classList.toggle("tiandao-open-leftward", !openRightward);
    card.classList.toggle("tiandao-open-rightward", openRightward);
    card.classList.toggle("tiandao-open-upward", openUpward);
    card.style.width = desiredWidth + "px";

    // 拖到屏幕中部时两侧都不足以完整容纳卡片，向可用的一侧回拉。
    const proposedLeft = openRightward ? rect.left : rect.right - desiredWidth;
    const maxLeft = Math.max(10, vw - desiredWidth - 10);
    const clampedLeft = Math.min(Math.max(10, proposedLeft), maxLeft);
    const horizontalShift = clampedLeft - proposedLeft;
    if (openRightward) {
        card.style.left = horizontalShift + "px";
        card.style.right = "";
    } else {
        card.style.left = "";
        card.style.right = (-horizontalShift) + "px";
    }

    const viewportCap = vw <= 600 ? vh * 0.78 : vh;
    const fixedHeight = Math.max(200, Math.min(610, viewportCap, openUpward ? spaceAbove : spaceBelow));
    card.style.height = fixedHeight + "px";
    card.style.maxHeight = fixedHeight + "px";

    const proposedTop = openUpward ? rect.bottom - fixedHeight : rect.top;
    const maxTop = Math.max(10, vh - fixedHeight - 10);
    const clampedTop = Math.min(Math.max(10, proposedTop), maxTop);
    const verticalShift = clampedTop - proposedTop;
    if (openUpward) {
        card.style.top = "";
        card.style.bottom = (-verticalShift) + "px";
    } else {
        card.style.top = verticalShift + "px";
        card.style.bottom = "";
    }
}

function makeDraggable(element, handle, { onDragMove = null, canDrag = null } = {}) {
    let pointerId = null;
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
    let moved = false;

    handle.style.touchAction = "none";

    const isInteractive = (target) =>
        target.closest("button, input, select, textarea, .tiandao-chip, summary, a");

    handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || isInteractive(e.target) || (canDrag && !canDrag(e))) return;
        pointerId = e.pointerId;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const cardSurface = handle.closest(".tiandao-widget-card");
        const dragSurface = cardSurface || element;
        const rect = dragSurface.getBoundingClientRect();
        const opensRightward = Boolean(cardSurface?.classList.contains("tiandao-open-rightward"));
        const opensUpward = Boolean(cardSurface?.classList.contains("tiandao-open-upward"));
        baseLeft = cardSurface && !opensRightward ? rect.right : rect.left;
        baseTop = cardSurface && opensUpward ? rect.bottom : rect.top;
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
        const dragSurface = handle.closest(".tiandao-widget-card") || element;
        const width = dragSurface.offsetWidth || 120;
        const height = dragSurface.offsetHeight || 40;
        const minLeft = 8;
        const minTop = 8;
        const maxLeft = Math.max(minLeft, window.innerWidth - width - minLeft);
        const maxTop = Math.max(minTop, window.innerHeight - height - minTop);
        const nextLeft = Math.min(Math.max(minLeft, baseLeft + dx), maxLeft);
        const nextTop = Math.min(Math.max(minTop, baseTop + dy), maxTop);
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

function updateFloatingWidgetUI({ forceLedger = false } = {}) {
    if (!document.getElementById("tiandao_floating_widget")) return;
    if (forceLedger) pendingLedgerRender.force = true;
    if (floatingUiFrame !== null) return;
    const schedule = typeof window.requestAnimationFrame === "function"
        ? callback => window.requestAnimationFrame(callback)
        : callback => setTimeout(callback, 0);
    floatingUiFrame = schedule(() => {
        floatingUiFrame = null;
        const options = { forceLedger: pendingLedgerRender.force };
        pendingLedgerRender.force = false;
        renderFloatingWidgetUI(options);
    });
}

function renderFloatingWidgetUI({ forceLedger = false } = {}) {
    const settings = getSettings();
    const widget = document.getElementById("tiandao_floating_widget");
    if (!widget) return;

    applyWidgetAppearance();

    // 悬浮窗同时是唯一设置入口。暂停引擎时保留入口，避免用户无法再次开启。
    widget.style.display = "block";
    positionFloatingWidgetCard();
    renderSummaryProgress();

    const memoryData = getChatMemory();
    const pill = document.getElementById("tiandao_widget_pill");
    const badge = document.getElementById("tiandao_widget_badge");
    const bodyInner = document.getElementById("tiandao_widget_body_inner");
    const summaryInfo = document.getElementById("tiandao_widget_summary_info");

    const l0Count = (memoryData.levels?.[0] || []).length;
    const l1Count = (memoryData.levels?.[1] || []).length;
    const l2Count = (memoryData.levels?.[2] || []).length;
    const l3Count = (memoryData.levels?.[3] || []).length;
    const pendingBacklog = getPendingBacklog(getSTContext().chat || [], memoryData);
    const pendingBacklogCount = pendingBacklog.length;
    const summaryError = isActiveChatContext(getSTContext()) ? memoryData.lastSummaryError : null;

    if (badge) {
        const badgeText = !settings.enabled
            ? "已暂停"
            : (isBackfilling && activeBackfillChatKey === getChatKey()
                ? "回溯中"
                : (activeSummaryChats.has(getChatKey())
                    ? "整理中"
                    : (pendingBacklogCount > 0
                        ? `待补 ${pendingBacklogCount}`
                        : (summaryError
                            ? "需检查"
                            : (memoryData.lastProcessedRound > 0 ? `第${memoryData.lastProcessedRound}轮` : "就绪")))));
        badge.textContent = badgeText;
    }
    if (pill) {
        pill.classList.toggle("tiandao-pill-paused", !settings.enabled);
        pill.title = settings.enabled
            ? "溯微长线记忆引擎 (点击展开/折叠，可任意拖拽)"
            : "溯微已暂停。点击展开设置，勾选“启用溯微记忆引擎”即可恢复。";
    }

    if (summaryInfo) {
        const tokenText = lastMemoryPromptTokens > 0
            ? ` · 注入~${lastMemoryPromptTokens}tk`
            : "";
        const fadedCount = numOr(memoryData.fadedHistory?.count, 0);
        const fadedText = fadedCount > 0 ? ` · 远史:${fadedCount}` : "";
        summaryInfo.textContent = `L0(${l0Count}) L1(${l1Count}) L2(${l2Count}) L3(${l3Count}) · 回溯池:${memoryData.archivePool?.length || 0}${fadedText}${tokenText}`;
    }

    if (!bodyInner) return;
    const memoryBusy = activeSummaryChats.has(getChatKey())
        || (isBackfilling && activeBackfillChatKey === getChatKey());
    const ledgerRenderKey = `${getChatKey()}|${getSTContext().name1 || ""}|${memoryBusy ? 1 : 0}|${JSON.stringify(memoryData.stateLedger || {})}`;
    if (forceLedger || ledgerRenderKey !== lastLedgerRenderKey) {
        bodyInner.innerHTML = buildLedgerHtml(memoryData);
        lastLedgerRenderKey = ledgerRenderKey;
    }

    // 时间线较重，只在剧情页可见时重建，避免每轮总结都刷新隐藏页签。
    const storyVisible = document.getElementById("tiandao_tab_story_content")?.style.display !== "none";
    if (storyVisible) {
        renderStoryTimeline();
        renderStoryRecoveryState(memoryData, pendingBacklog);
    }
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
    const ctx = getSTContext();
    const chatKey = getChatKey();
    const memoryBusy = activeSummaryChats.has(chatKey)
        || (isBackfilling && activeBackfillChatKey === chatKey);
    const userNames = new Set(
        [ctx.name1, ...(Array.isArray(ctx.chat) ? ctx.chat.filter(msg => msg?.is_user).map(msg => msg?.name) : [])]
            .map(name => String(name || "").trim())
            .filter(Boolean)
    );

    const entries = Object.entries(chars);
    entries.sort(([nameA], [nameB]) => {
        const aIsUser = userNames.has(nameA);
        const bIsUser = userNames.has(nameB);
        if (aIsUser !== bIsUser) return aIsUser ? -1 : 1;
        const aPresent = chars[nameA]?.present === false ? 0 : 1;
        const bPresent = chars[nameB]?.present === false ? 0 : 1;
        if (aPresent !== bPresent) return bPresent - aPresent;
        const aSeen = numOr(chars[nameA]?.lastSeenRound, 0);
        const bSeen = numOr(chars[nameB]?.lastSeenRound, 0);
        if (aSeen !== bSeen) return bSeen - aSeen;
        return 0;
    });

    for (const [name, info] of entries) {
        if (!info) continue;
        // 已摘除的饰品并入随身道具展示（标注“已摘下”），不再单列一行
        const inventoryItems = Array.isArray(info.inventory) ? info.inventory : [];
        const removedItems = Array.isArray(info.removedItemsLock) ? info.removedItemsLock : [];
        const itemEntries = [
            ...inventoryItems.map((text, index) => ({
                text,
                kind: "inventory",
                index,
                removed: false,
            })),
            ...removedItems.map((text, index) => ({
                text,
                kind: "removed",
                index,
                removed: true,
            })),
        ];
        const removedCount = removedItems.length;
        const itemListId = `tiandao-char-items-${charCards.length}`;
        const itemHtml = itemEntries.length > 0
            ? (() => {
                const inventoryExpanded = expandedInventoryCards.has(`${chatKey}::${name}`);
                const chips = itemEntries.map(({ text, kind, index, removed }) => {
                    const rawText = String(text);
                    const label = removed && !/已摘|未佩戴|已脱/.test(rawText)
                        ? `${rawText}（已摘下）`
                        : rawText;
                    const deleteTitle = memoryBusy
                        ? "总结进行中，完成后再删除物品"
                        : (kind === "removed"
                            ? "从当前状态账本删除这条已摘下记录"
                            : "从当前状态账本删除这件随身道具");
                    return `<span class="tiandao-item-chip${removed ? " tiandao-item-off" : ""}">
                        <span class="tiandao-item-text">${escapeHTML(label)}</span>
                        <button type="button"
                            class="tiandao-item-delete"
                            data-char-name="${escapeHTML(name)}"
                            data-delete-item="${kind}"
                            data-item-index="${index}"
                            title="${deleteTitle}"
                            aria-label="删除物品：${escapeHTML(rawText)}"
                            ${memoryBusy ? "disabled" : ""}>
                            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        </button>
                    </span>`;
                }).join("");
                return `<div class="tiandao-char-item-section">
                    <button type="button"
                        class="tiandao-item-toggle"
                        data-item-toggle="${escapeHTML(name)}"
                        aria-expanded="${inventoryExpanded ? "true" : "false"}"
                        aria-controls="${itemListId}">
                        <span class="tiandao-item-heading">
                            <i class="fa-solid fa-box-archive"></i>
                            <b>随身道具</b>
                            <span class="tiandao-item-count">${itemEntries.length}件${removedCount > 0 ? ` · ${removedCount}已摘下` : ""}</span>
                        </span>
                        <i class="fa-solid fa-chevron-down tiandao-item-chevron${inventoryExpanded ? " expanded" : ""}" aria-hidden="true"></i>
                    </button>
                    <div id="${itemListId}" class="tiandao-item-list" ${inventoryExpanded ? "" : "hidden"}>${chips}</div>
                </div>`;
            })()
            : "";
        const aliasHtml = (Array.isArray(info.aliases) && info.aliases.length > 0)
            ? `<div class="tiandao-char-alias">别名/称号: ${info.aliases.map(escapeHTML).join("，")}</div>`
            : "";
        const away = info.present === false;
        const initial = escapeHTML(Array.from(String(name || "?"))[0] || "?");
        const characterExpanded = expandedCharacterCards.has(`${chatKey}::${name}`);
        const bodyId = `tiandao-char-body-${charCards.length}`;

        charCards.push(`
            <div class="tiandao-char-card${away ? " tiandao-char-away" : ""}${characterExpanded ? " tiandao-char-expanded" : ""}">
                <button type="button"
                    class="tiandao-char-card-header"
                    data-char-toggle="${escapeHTML(name)}"
                    aria-expanded="${characterExpanded ? "true" : "false"}"
                    aria-controls="${bodyId}">
                    <span class="tiandao-char-person">
                        <span class="tiandao-char-avatar" aria-hidden="true">${initial}</span>
                        <span class="tiandao-char-name">${escapeHTML(name)}</span>
                    </span>
                    <span class="tiandao-char-header-tail">
                        <span class="tiandao-char-loc">${away ? '<i class="fa-solid fa-person-walking-arrow-right"></i> 暂离场 · ' : '<i class="fa-solid fa-location-dot"></i> '}${escapeHTML(info.location || "未知位置")}</span>
                        <i class="fa-solid fa-chevron-down tiandao-char-chevron${characterExpanded ? " expanded" : ""}" aria-hidden="true"></i>
                    </span>
                </button>
                <div id="${bodyId}" class="tiandao-char-body" ${characterExpanded ? "" : "hidden"}>
                    ${aliasHtml}
                    <div class="tiandao-char-prop"><b>状态行动</b>: ${escapeHTML(info.statusAndAction || "平静")}</div>
                    <div class="tiandao-char-prop"><b>当前衣着</b>: ${escapeHTML(info.wear || "常规穿戴")}</div>
                    ${itemHtml}
                </div>
            </div>
        `);
    }

    const todos = (Array.isArray(ledger.todosAndPromises) ? ledger.todosAndPromises : [])
        .filter(todo => todo && typeof todo === "object")
        .slice()
        .sort((a, b) => Number(Boolean(a.completed)) - Number(Boolean(b.completed)));
    const openTodoCount = todos.filter(todo => !todo.completed).length;
    const todoHtml = todos.length > 0
        ? todos.map(todo => {
            const completed = todo.completed === true;
            const title = memoryBusy
                ? "总结进行中，完成后再修改待办状态"
                : (completed ? "下一轮总结后自动移除；取消勾选可恢复" : "勾选后自动保存");
            return `<label class="tiandao-todo-item${completed ? " tiandao-todo-done" : ""}" title="${title}">
                <input type="checkbox" class="tiandao-todo-check" data-todo-id="${escapeHTML(todo.id)}" ${completed ? "checked" : ""} ${memoryBusy ? "disabled" : ""} />
                <span class="tiandao-todo-text">${escapeHTML(todo.text)}</span>
                ${completed ? '<span class="tiandao-todo-status">已完成</span>' : ""}
            </label>`;
        }).join("")
        : "<div class='tiandao-empty-hint'>暂无未完成的约定与待办</div>";

    return `
        <div class="tiandao-time-banner">
            <span class="tiandao-time-label"><i class="fa-regular fa-clock"></i> 故事时间</span>
            <span class="tiandao-time-val">${escapeHTML(ledger.time || "未知时间")}</span>
        </div>
        ${charCards.length > 0 ? charCards.join("") : "<div class='tiandao-empty-hint'>暂无在场个体状态</div>"}
        <div class="tiandao-todo-box">
            <div class="tiandao-todo-title" title="勾选后自动保存，已完成条目会在下一轮总结后移除">
                <i class="fa-solid fa-list-check"></i> 待办与约定追踪
                <span class="tiandao-todo-count">${openTodoCount} 未完成</span>
            </div>
            <div class="tiandao-todo-list">${todoHtml}</div>
        </div>
    `;
}

async function deleteLedgerItem(characterName, itemKind, itemIndex, button = null) {
    const chatKey = getChatKey();
    if (pendingHierarchyEdits.has(chatKey)
        || activeSummaryChats.has(chatKey)
        || (isBackfilling && activeBackfillChatKey === chatKey)) {
        updateFloatingWidgetUI();
        updateStatusBar("⏳ 总结进行中，请等当前任务结束后再删除物品", true);
        return;
    }

    const memoryData = getChatMemory();
    const info = memoryData.stateLedger?.characters?.[characterName];
    const field = itemKind === "removed"
        ? "removedItemsLock"
        : (itemKind === "inventory" ? "inventory" : "");
    if (!info || !field || !Number.isInteger(itemIndex)) {
        updateFloatingWidgetUI();
        updateStatusBar("⚠️ 该人物的状态记录已变化，请刷新后重试", true);
        return;
    }
    const list = Array.isArray(info[field]) ? info[field] : [];
    const itemText = list[itemIndex];
    if (typeof itemText !== "string") {
        updateFloatingWidgetUI();
        updateStatusBar("⚠️ 该物品已不存在，请刷新后重试", true);
        return;
    }

    const fieldLabel = itemKind === "removed" ? "已摘下记录" : "随身道具";
    const confirmed = confirm(
        `确定从「${characterName}」的${fieldLabel}中删除「${itemText}」吗？\n\n`
        + "只会修改当前状态账本，不会改动历史剧情。",
    );
    if (!confirmed) return;

    const previousList = list.slice();
    const stateStorageCapture = captureLatestL0StateStorage(memoryData);
    button?.setAttribute("disabled", "");
    list.splice(itemIndex, 1);
    stampLatestL0StateSnapshot(memoryData);
    try {
        await saveChatMemory();
    } catch (error) {
        info[field] = previousList;
        restoreLatestL0StateStorage(stateStorageCapture);
        await saveChatMemory().catch(() => {});
        button?.removeAttribute("disabled");
        updateFloatingWidgetUI({ forceLedger: true });
        updateStatusBar(`❌ 删除物品失败：${String(error?.message || error).slice(0, 160)}`, true);
        return;
    }

    try {
        await refreshPromptInjection("", { skipRetrieval: true });
    } catch (error) {
        updateFloatingWidgetUI();
        updateStatusBar(`⚠️ 物品已删除，但刷新注入失败：${String(error?.message || error).slice(0, 160)}`, true);
        return;
    }
    updateFloatingWidgetUI();
    updateStatusBar(`🗑️ 已从「${characterName}」的状态账本删除「${itemText}」`);
}

async function updateTodoCompletion(todoId, completed) {
    const chatKey = getChatKey();
    if (activeSummaryChats.has(chatKey)
        || pendingHierarchyEdits.has(chatKey)
        || (isBackfilling && activeBackfillChatKey === chatKey)) {
        updateFloatingWidgetUI();
        updateStatusBar("⏳ 总结进行中，请等当前任务结束后再修改待办状态", true);
        return;
    }
    const memoryData = getChatMemory();
    const todos = Array.isArray(memoryData.stateLedger?.todosAndPromises)
        ? memoryData.stateLedger.todosAndPromises
        : [];
    const todo = todos.find(item => item?.id === todoId);
    if (!todo) {
        updateFloatingWidgetUI();
        updateStatusBar("⚠️ 该待办已不存在，请刷新后重试", true);
        return;
    }

    const previousCompletion = {
        completed: todo.completed === true,
        completedRound: numOr(todo.completedRound, 0),
        completedBy: todo.completedBy || "",
    };
    const stateStorageCapture = captureLatestL0StateStorage(memoryData);
    todo.completed = Boolean(completed);
    todo.completedRound = completed ? Math.max(0, numOr(memoryData.lastProcessedRound, 0)) : 0;
    todo.completedBy = completed ? "player" : "";
    stampLatestL0StateSnapshot(memoryData);
    try {
        await saveChatMemory();
    } catch (error) {
        Object.assign(todo, previousCompletion);
        restoreLatestL0StateStorage(stateStorageCapture);
        await saveChatMemory().catch(() => {});
        updateFloatingWidgetUI({ forceLedger: true });
        updateStatusBar(`❌ 保存待办状态失败：${String(error?.message || error).slice(0, 160)}`, true);
        return;
    }
    try {
        await refreshPromptInjection("", { skipRetrieval: true });
    } catch (error) {
        updateFloatingWidgetUI();
        updateStatusBar(`⚠️ 待办状态已保存，但刷新注入失败：${String(error?.message || error).slice(0, 160)}`, true);
        return;
    }
    updateFloatingWidgetUI();
    updateStatusBar(completed
        ? "✅ 已勾选为完成，下一轮总结后自动移除"
        : "↩️ 已恢复为未完成");
}

/**
 * 剧情时间线：各轮总结按层级（L2 大阶段 → L1 阶段 → L0 单轮）汇总，
 * 支持正序/倒序展示，每条总结带编辑按钮，可内联修改剧情文本
 */
let storyViewRange = null;
const STORY_PAGE_SIZE = 20;
let storyPage = 0;
let storySortOrder = "desc";

function buildTimelineHtml(memoryData) {
    const entries = [];
    const levels = memoryData.levels || {};
    const settings = getSettings();
    const chat = getSTContext().chat || [];
    let latestAiIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isAiReplyMessage(chat[i], settings.includeNativeHidden)) {
            latestAiIndex = i;
            break;
        }
    }
    const currentRound = latestAiIndex >= 0
        ? calculateRoundForMessageIndex(chat, latestAiIndex, settings.includeNativeHidden)
        : 0;
    const rawKeep = settings.autoHideOldMessages
        ? Math.max(1, numOr(settings.keepRecentRoundsCount, 5))
        : 0;
    const rawWindowStart = currentRound > 0 ? currentRound - rawKeep + 1 : Infinity;
    const maxLvl = Math.max(...Object.keys(levels).map(Number), 1);
    const inViewRange = (item) => {
        if (!storyViewRange) return true;
        const range = parseRoundRange(item?.roundRange);
        return range.end >= storyViewRange.from && range.start <= storyViewRange.to;
    };

    const pushEntry = (lvl, item, idx) => {
        entries.push({ kind: "entry", lvl, item, idx });
    };

    const renderEntry = ({ kind, lvl, item, idx }) => {
        if (kind === "far") {
            return `<div class="tiandao-story-entry strong">
                <div class="tiandao-entry-meta">
                    <span class="tiandao-lvl tiandao-lvl-2">远史</span>
                    <span class="tiandao-round">按剧情内时间整理</span>
                </div>
                <div class="tiandao-entry-text">${escapeHTML(item)}</div>
            </div>`;
        }
        const badgeClass = lvl >= 2 ? "tiandao-lvl-2" : (lvl === 1 ? "tiandao-lvl-1" : "tiandao-lvl-0");
        const kindText = lvl >= 2 ? "大阶段脉络" : (lvl === 1 ? "阶段脉络" : "单轮微摘要");
        return `
            <div class="tiandao-story-entry${lvl >= 2 ? " strong" : ""}" data-lvl="${lvl}" data-idx="${idx}">
                <div class="tiandao-entry-meta">
                    <span class="tiandao-lvl ${badgeClass}">L${lvl}</span>
                    <span class="tiandao-round">第 ${escapeHTML(item.roundRange)} 轮 · ${kindText}</span>
                    <button type="button" class="tiandao-entry-edit-btn" title="编辑这条剧情总结" onclick="window.tiandaoEditStoryEntry(${lvl}, ${idx})">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button type="button" class="tiandao-entry-resummarize-btn" title="只重新总结这条对应的轮次" onclick="window.tiandaoResummarizeStoryEntry(${lvl}, ${idx})">
                        <i class="fa-solid fa-arrows-rotate"></i>
                    </button>
                </div>
                <div class="tiandao-entry-text">${escapeHTML(item.text)}</div>
            </div>`;
    };

    const farHistoryText = String(memoryData.farHistory?.text || "").trim();
    if (farHistoryText && !storyViewRange) {
        entries.push({ kind: "far", item: farHistoryText });
    }
    for (let lvl = maxLvl; lvl >= 1; lvl--) {
        (levels[lvl] || []).forEach((it, idx) => {
            if (inViewRange(it)) pushEntry(lvl, it, idx);
        });
    }
    (levels[0] || []).forEach((it, idx) => {
        const range = parseRoundRange(it?.roundRange);
        if (rawKeep > 0 && rawWindowStart !== Infinity
            && range.end >= rawWindowStart && range.start <= currentRound) {
            return;
        }
        if (inViewRange(it)) pushEntry(0, it, idx);
    });

    const displayEntries = storySortOrder === "desc"
        ? entries.slice().reverse()
        : entries;
    const totalPages = Math.max(1, Math.ceil(displayEntries.length / STORY_PAGE_SIZE));
    storyPage = Math.min(Math.max(0, storyPage), totalPages - 1);
    const pageStart = storyPage * STORY_PAGE_SIZE;
    const pageEnd = Math.min(displayEntries.length, pageStart + STORY_PAGE_SIZE);
    const pageEntries = displayEntries.slice(pageStart, pageEnd);
    const body = pageEntries.length > 0
        ? pageEntries.map(renderEntry).join("")
        : `<div class='tiandao-empty-hint'>${storyViewRange ? "所选范围暂无剧情总结" : "暂无剧情总结 · 开启自动总结后，这里会按轮次逐步填充"}</div>`;
    const pageRanges = pageEntries
        .filter(entry => entry.kind === "entry")
        .map(entry => parseRoundRange(entry.item.roundRange));
    const pageRangeText = pageRanges.length > 0
        ? (() => {
            const first = Math.min(...pageRanges.map(range => range.start));
            const last = Math.max(...pageRanges.map(range => range.end));
            return first === last ? `第 ${first} 轮` : `第 ${first}-${last} 轮`;
        })()
        : "远史归档";
    const olderDisabled = storySortOrder === "desc"
        ? storyPage >= totalPages - 1
        : storyPage <= 0;
    const newerDisabled = storySortOrder === "desc"
        ? storyPage <= 0
        : storyPage >= totalPages - 1;
    const pager = displayEntries.length > STORY_PAGE_SIZE
        ? `<div class="tiandao-story-pager">
                <button type="button" class="tiandao-story-page-btn" data-story-page="older" title="较早的 20 条" ${olderDisabled ? "disabled" : ""}>
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <span class="tiandao-story-page-info">第 ${storyPage + 1}/${totalPages} 页 · ${pageRangeText}</span>
                <button type="button" class="tiandao-story-page-btn" data-story-page="newer" title="较新的 20 条" ${newerDisabled ? "disabled" : ""}>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>`
        : "";

    return `
        <div class="tiandao-pagehead">
            <span class="tiandao-pagecap">剧情时间线（${storySortOrder === "desc" ? "由近及远" : "由远及近"}）</span>
            <span class="tiandao-pagehint">${storyViewRange ? `显示第 ${storyViewRange.from}-${storyViewRange.to} 轮` : "点击 ✏ 可修改每条剧情总结"}</span>
        </div>
        ${pager}
        ${body}`;
}

/**
 * 「剧情」Tab：各轮总结时间线（L2 大阶段 → L1 阶段 → L0 单轮，可切换排序）
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
    const chatKey = getChatKey();
    if (activeSummaryChats.has(chatKey)
        || (isBackfilling && activeBackfillChatKey === chatKey)) {
        updateStatusBar("⏳ 当前存档正在整理记忆，请稍后再编辑剧情总结", true);
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
    const resummarizeBtn = entry.querySelector(".tiandao-entry-resummarize-btn");
    if (resummarizeBtn) resummarizeBtn.style.display = "none";

    const ta = editor.querySelector("textarea");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
};

window.tiandaoCancelStoryEntry = () => {
    storyEditingKey = null;
    storyEditingId = null;
    renderStoryTimeline();
};

function hierarchyIdKey(level, item) {
    return item?.id ? `${level}:id:${item.id}` : "";
}

function hierarchyRangeKey(level, item) {
    const range = parseRoundRange(item?.roundRange);
    return `${level}:range:${range.start}-${range.end}`;
}

function setHierarchyTextOverride(overrides, level, item, text) {
    const idKey = hierarchyIdKey(level, item);
    if (idKey) overrides.set(idKey, text);
    overrides.set(hierarchyRangeKey(level, item), text);
}

function getHierarchyTextOverride(overrides, level, item) {
    return overrides.get(hierarchyIdKey(level, item))
        ?? overrides.get(hierarchyRangeKey(level, item))
        ?? null;
}

function buildHierarchySignature(levels) {
    return JSON.stringify(
        Object.entries(levels || {}).map(([level, entries]) => [
            level,
            (Array.isArray(entries) ? entries : []).map(entry => [
                entry?.id || "",
                entry?.roundRange || "",
                entry?.startMessageId ?? "",
                entry?.endMessageId ?? "",
                entry?.text || "",
            ]),
        ]),
    );
}

function findHierarchyEditSource(levels, level, item) {
    const maxSourceLevel = Math.max(0, Number(level) - 1);
    const targetRange = parseRoundRange(item?.roundRange);
    for (let sourceLevel = maxSourceLevel; sourceLevel >= 0; sourceLevel--) {
        const source = (levels?.[sourceLevel] || []).find(candidate => {
            const range = parseRoundRange(candidate?.roundRange);
            return range.start === targetRange.start && range.end === targetRange.end;
        });
        if (source) return { level: sourceLevel, item: source };
    }
    return null;
}

async function rebuildHierarchyLevelsFromL0(settings, memoryData, textOverrides, signal) {
    const l0Entries = (memoryData.archivePool || [])
        .filter(entry => entry && entry.level === 0)
        .sort((a, b) =>
            numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
            - numOr(b.startMessageId, parseRoundRange(b.roundRange).start)
        )
        .map(entry => {
            const copy = clonePlainData(entry);
            const override = getHierarchyTextOverride(textOverrides, 0, copy);
            if (override !== null) {
                copy.text = override;
                copy.embedding = null;
            }
            return copy;
        });
    if (l0Entries.length === 0) return null;

    const working = createEmptyMemoryData();
    working.stateLedger = clonePlainData(memoryData.stateLedger);
    working.levels = { 0: l0Entries };
    working.archivePool = l0Entries;
    await checkAndCascadeMerge(settings, working, { signal });

    const rebuilt = {};
    const maxLevel = Math.max(
        3,
        ...Object.keys(working.levels || {}).map(Number).filter(Number.isFinite),
    );
    for (let level = 0; level <= maxLevel; level++) {
        rebuilt[level] = (working.levels?.[level] || []).map(entry => {
            const copy = clonePlainData(entry);
            if (level > 0) {
                const override = getHierarchyTextOverride(textOverrides, level, copy);
                if (override !== null) copy.text = override;
            }
            return copy;
        });
    }
    return {
        levels: rebuilt,
        farHistory: clonePlainData(working.farHistory),
        pendingFarHistory: clonePlainData(working.pendingFarHistory),
        fadedHistory: clonePlainData(working.fadedHistory),
    };
}

function restoreHierarchyEditFallback(memoryData, fallbackHierarchy, archiveRestore) {
    memoryData.levels = clonePlainData(fallbackHierarchy.levels || {});
    memoryData.farHistory = clonePlainData(fallbackHierarchy.farHistory || {});
    memoryData.pendingFarHistory = clonePlainData(fallbackHierarchy.pendingFarHistory || []);
    memoryData.fadedHistory = clonePlainData(fallbackHierarchy.fadedHistory || {});
    if (archiveRestore?.entry) {
        archiveRestore.entry.text = archiveRestore.text;
        archiveRestore.entry.embedding = archiveRestore.embedding;
    }
}

function startHierarchyRebuildTransaction({
    memoryData,
    chatKey,
    epoch,
    intermediateLevels,
    fallbackHierarchy,
    archiveRestore,
    textOverrides,
    targetLevel,
    roundRange,
}) {
    memoryData.levels = clonePlainData(intermediateLevels);
    const stagedLevelsSignature = buildHierarchySignature(memoryData.levels);
    pendingHierarchyEdits.add(chatKey);
    updateFloatingWidgetUI();
    updateStatusBar(`✅ 已修改第 ${roundRange} 轮，正在重建高层摘要...`);

    const restoreStagedIfNeeded = async () => {
        if (!isCurrentChat(chatKey)
            || getChatMemory() !== memoryData
            || buildHierarchySignature(memoryData.levels) !== stagedLevelsSignature) {
            return false;
        }
        restoreHierarchyEditFallback(memoryData, fallbackHierarchy, archiveRestore);
        await saveChatMemory().catch(() => {});
        await refreshPromptInjection().catch(() => {});
        updateFloatingWidgetUI();
        return true;
    };

    const job = enqueueBackgroundSummary(async () => {
        if (!isCurrentChat(chatKey)) return;
        if (epoch !== summaryEpoch) {
            await restoreStagedIfNeeded();
            return;
        }
        const task = await acquireSummaryTask({
            label: "重建高层记忆",
            total: 1,
            canCancel: true,
        }, () => isCurrentChat(chatKey) && epoch === summaryEpoch);
        if (!task) return;
        const signal = task.controller.signal;
        try {
            updateSummaryTask(task, {
                current: 0,
                detail: "正在从单轮摘要重建 L1～L3 与远史",
            });

            let rebuiltLevels = null;
            try {
                rebuiltLevels = await rebuildHierarchyLevelsFromL0(
                    getSettings(),
                    memoryData,
                    textOverrides,
                    signal,
                );
            } catch (error) {
                if (signal.aborted || error?.name === "AbortError") throw error;
                if (await restoreStagedIfNeeded()) {
                    updateStatusBar(
                        `❌ 高层摘要重建失败，本次修改未保存：${String(error?.message || error).slice(0, 140)}`,
                        true,
                    );
                }
                return;
            }

            if (!rebuiltLevels) {
                if (await restoreStagedIfNeeded()) {
                    updateStatusBar("⚠️ 没有足够的单轮摘要可供重建，本次修改未保存", true);
                }
                return;
            }
            if (targetLevel > 0) {
                const targetRange = parseRoundRange(roundRange);
                const targetStillExists = (rebuiltLevels.levels?.[targetLevel] || [])
                    .some(entry => {
                        const range = parseRoundRange(entry?.roundRange);
                        return range.start === targetRange.start && range.end === targetRange.end;
                    });
                if (!targetStillExists) {
                    if (await restoreStagedIfNeeded()) {
                        updateStatusBar(
                            "⚠️ 重建后的层级无法定位所选阶段，本次修改未保存",
                            true,
                        );
                    }
                    return;
                }
            }
            if (!isCurrentChat(chatKey)
                || epoch !== summaryEpoch
                || getChatMemory() !== memoryData
                || signal.aborted) {
                await restoreStagedIfNeeded();
                return;
            }

            memoryData.levels = rebuiltLevels.levels;
            memoryData.farHistory = rebuiltLevels.farHistory;
            memoryData.pendingFarHistory = rebuiltLevels.pendingFarHistory;
            memoryData.fadedHistory = rebuiltLevels.fadedHistory;
            try {
                await saveChatMemory();
            } catch (error) {
                restoreHierarchyEditFallback(memoryData, fallbackHierarchy, archiveRestore);
                await saveChatMemory().catch(() => {});
                updateFloatingWidgetUI();
                updateStatusBar(
                    `❌ 保存重建结果失败，已恢复原摘要：${String(error?.message || error).slice(0, 140)}`,
                    true,
                );
                return;
            }

            await refreshPromptInjection().catch(() => {});
            updateFloatingWidgetUI();
            updateStatusBar(`✅ 已修改第 ${roundRange} 轮，并重建高层摘要`);
        } catch (error) {
            if (signal.aborted || error?.name === "AbortError") {
                if (await restoreStagedIfNeeded()) {
                    updateStatusBar("⏸️ 已停止重建高层摘要，本次修改未保存");
                }
                return;
            }
            await restoreStagedIfNeeded();
            throw error;
        } finally {
            finishSummaryTask(task);
        }
    }, "重建记忆层级");
    job.finally(() => {
        pendingHierarchyEdits.delete(chatKey);
        updateFloatingWidgetUI();
    });
    return job;
}

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
    const numericLevel = Number(lvl);
    const archiveEntry = numericLevel === 0 && Array.isArray(memoryData.archivePool)
        ? memoryData.archivePool.find(entry =>
            entry
            && entry.level === 0
            && ((item.id && entry.id === item.id)
                || (numOr(entry.startMessageId, -2) === numOr(item.startMessageId, -3)
                    && numOr(entry.endMessageId, -4) === numOr(item.endMessageId, -5)))
        )
        : null;
    const archiveRestore = archiveEntry
        ? {
            entry: archiveEntry,
            text: archiveEntry.text,
            embedding: archiveEntry.embedding,
        }
        : null;
    const fallbackHierarchy = {
        levels: clonePlainData(memoryData.levels || {}),
        farHistory: clonePlainData(memoryData.farHistory || {}),
        pendingFarHistory: clonePlainData(memoryData.pendingFarHistory || []),
        fadedHistory: clonePlainData(memoryData.fadedHistory || {}),
    };
    summaryEpoch++;
    const chatKey = getChatKey();
    const epoch = summaryEpoch;
    item.text = newText;
    item.embedding = null; // 文本已变化，旧向量不再可信；召回会回退到本地词法检索。
    if (archiveEntry) {
        archiveEntry.text = newText;
        archiveEntry.embedding = null;
    }
    storyEditingKey = null;

    const textOverrides = new Map();
    if (numericLevel === 0) {
        setHierarchyTextOverride(textOverrides, 0, item, newText);
    } else {
        const source = findHierarchyEditSource(memoryData.levels, numericLevel, item);
        if (source) {
            setHierarchyTextOverride(textOverrides, source.level, source.item, newText);
        }
        setHierarchyTextOverride(textOverrides, numericLevel, item, newText);
    }

    const l0Entries = (memoryData.archivePool || [])
        .filter(entry => entry && entry.level === 0)
        .sort((a, b) =>
            numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
            - numOr(b.startMessageId, parseRoundRange(b.roundRange).start)
        )
        .map(entry => {
            const copy = clonePlainData(entry);
            const override = getHierarchyTextOverride(textOverrides, 0, copy);
            if (override !== null) {
                copy.text = override;
                copy.embedding = null;
            }
            return copy;
        });

    if (l0Entries.length === 0) {
        try {
            await saveChatMemory();
        } catch (error) {
            restoreHierarchyEditFallback(memoryData, fallbackHierarchy, archiveRestore);
            await saveChatMemory().catch(() => {});
            updateFloatingWidgetUI();
            updateStatusBar(`❌ 保存剧情总结失败：${String(error?.message || error).slice(0, 160)}`, true);
            storyEditingId = null;
            return;
        }
        await refreshPromptInjection().catch(() => {});
        renderStoryTimeline();
        updateFloatingWidgetUI();
        updateStatusBar(`✅ 已修改第 ${item.roundRange} 轮的剧情总结`);
        storyEditingId = null;
        return;
    }

    const intermediateLevels = clonePlainData(memoryData.levels || {});
    if (numericLevel === 0) {
        intermediateLevels[0] = l0Entries;
    }
    renderStoryTimeline();
    startHierarchyRebuildTransaction({
        memoryData,
        chatKey,
        epoch,
        intermediateLevels,
        fallbackHierarchy,
        archiveRestore,
        textOverrides,
        targetLevel: numericLevel,
        roundRange: item.roundRange,
    });
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
            if (activeSummaryTask) requestSummaryTaskStop();
            storyEditingKey = null;
            storyEditingId = null;
            storyViewRange = null;
            storyPage = 0;
            const normalizedImport = normalizeMemoryData(imported);
            const merged = normalizeMemoryData(mergeEditedMemoryWithEmbeddings(getChatMemory(), normalizedImport));
            const ctx = getSTContext();
            const metadata = ctx.chatMetadata || window.chat_metadata;
            if (metadata) {
                invalidateRoundIndexCache(ctx.chat || []);
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
    bindInput("tiandao_summary_retry", "summaryRetryCount", true);
    bindInput("tiandao_summarize_timing", "summarizeTiming");
    bindInput("tiandao_widget_theme", "widgetTheme", false, () => applyWidgetAppearance());
    bindInput("tiandao_font_family", "widgetFontFamily", false, () => applyWidgetAppearance());
    const fontScaleInput = document.getElementById("tiandao_font_scale");
    const fontScaleValue = document.getElementById("tiandao_font_scale_value");
    const syncFontScalePreview = (value = fontScaleInput?.value) => {
        const scale = Math.min(130, Math.max(85, numOr(value, 100)));
        if (fontScaleValue) fontScaleValue.textContent = `${Math.round(scale)}%`;
        if (fontScaleInput) fontScaleInput.value = String(scale);
        document.documentElement.style.setProperty("--sw-font-scale", String(scale / 100));
    };
    bindInput("tiandao_font_scale", "widgetFontScale", true, (value) => {
        syncFontScalePreview(value);
        applyWidgetAppearance();
    });
    if (fontScaleInput) {
        syncFontScalePreview();
        fontScaleInput.addEventListener("input", () => syncFontScalePreview());
    }
    bindCheck("tiandao_use_json_mode", "useJsonMode");
    bindCheck("tiandao_include_native_hidden", "includeNativeHidden", () => {
        summaryEpoch++;
        syncHiddenMessagesState();
        refreshPromptInjection().catch(() => {});
        updateFloatingWidgetUI();
        updateStatusBar("⚠️ 已更改隐藏楼层轮次规则；如旧存档出现轮次错位，请重新扫描或重建剧情总结", true);
    });

    bindCheck("tiandao_auto_hide", "autoHideOldMessages", (checked) => {
        const count = syncHiddenMessagesState(!checked);
        if (!checked) {
            updateStatusBar(`👁️ 已关闭自动隐藏，恢复显示 ${count} 条历史原文`);
        } else {
            updateStatusBar(`🙈 已开启原文裁剪：仅发送最近 ${numOr(settings.keepRecentRoundsCount, 5)} 轮一问一答原文`);
        }
        updateFloatingWidgetUI();
    });
    bindInput("tiandao_keep_recent", "keepRecentRoundsCount", true, (val) => {
        syncHiddenMessagesState();
        if (settings.autoHideOldMessages) {
            updateStatusBar(`📏 已更新保留轮数：当前仅发送最近 ${numOr(val, 5)} 轮一问一答原文`);
        }
        updateFloatingWidgetUI();
    });

    bindInput("tiandao_api_url", "apiUrl", false, () => setFetchedModelNames([]));
    bindInput("tiandao_api_key", "apiKey");
    bindInput("tiandao_model", "model");
    bindInput("tiandao_temp", "temperature", true);
    bindInput("tiandao_target_tags", "targetContentTags");
    bindInput("tiandao_strip_tags", "customStripTags");
    const apiProfileSelect = document.getElementById("tiandao_api_profile_select");
    if (apiProfileSelect) apiProfileSelect.addEventListener("change", loadSelectedApiProfile);
    const apiProfileSaveBtn = document.getElementById("tiandao_api_profile_save_btn");
    if (apiProfileSaveBtn) apiProfileSaveBtn.addEventListener("click", saveCurrentApiProfile);
    const apiProfileDeleteBtn = document.getElementById("tiandao_api_profile_delete_btn");
    if (apiProfileDeleteBtn) apiProfileDeleteBtn.addEventListener("click", deleteSelectedApiProfile);
    refreshApiProfileSelect();

    bindInput("tiandao_merge_chunk", "mergeChunkSize", true);
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
    bindInput("tiandao_emb_url", "embeddingApiUrl", false, () => setFetchedEmbeddingModelNames([]));
    bindInput("tiandao_emb_key", "embeddingApiKey");
    bindInput("tiandao_emb_model", "embeddingModel");
    bindCheck("tiandao_emb_filter_models", "embeddingModelFilterOnly", () => {
        const visibleNames = refreshEmbeddingModelOptions();
        if (visibleNames.length > 0) {
            updateStatusBar(`已显示 ${visibleNames.length} 个可选向量模型`);
        }
    });

    const testBtn = document.getElementById("tiandao_test_api_btn");
    if (testBtn) testBtn.addEventListener("click", async () => {
        flushSettingInputs();
        try {
            updateStatusBar("⏳ 正在测试独立 API 连接...");
            const reply = await callIndependentLLM(
                getSettings(),
                [{ role: "user", content: "请仅回复“连接成功”四个字。" }],
                { jsonMode: false },
            );
            updateStatusBar(`✅ API 测试通过！模型回复: ${reply.slice(0, 30)}`);
        } catch (e) {
            updateStatusBar(`❌ API 连接失败: ${e.message}`, true);
        }
    });

    const resetAppearanceBtn = document.getElementById("tiandao_reset_appearance_btn");
    if (resetAppearanceBtn) resetAppearanceBtn.addEventListener("click", () => {
        const current = getSettings();
        current.widgetTheme = DEFAULT_SETTINGS.widgetTheme;
        current.widgetFontScale = DEFAULT_SETTINGS.widgetFontScale;
        current.widgetFontFamily = DEFAULT_SETTINGS.widgetFontFamily;
        for (const [id, key] of [
            ["tiandao_widget_theme", "widgetTheme"],
            ["tiandao_font_family", "widgetFontFamily"],
            ["tiandao_font_scale", "widgetFontScale"],
        ]) {
            const el = document.getElementById(id);
            if (el) el.value = String(current[key]);
        }
        syncFontScalePreview(current.widgetFontScale);
        applyWidgetAppearance();
        saveSettings();
        updateStatusBar("✅ 已恢复默认外观");
    });

    const backfillBtn = document.getElementById("tiandao_backfill_btn");
    if (backfillBtn) backfillBtn.addEventListener("click", async () => {
        if (isBackfilling) {
            abortBackfillFlag = true;
            requestSummaryTaskStop();
            updateStatusBar("⏸️ 正在安全停止历史回溯...");
            return;
        }
        if (activeSummaryTask || activeSummaryChats.size > 0 || pendingHierarchyEdits.size > 0) {
            updateStatusBar("⏳ 已有总结任务正在进行，请先等待或点击停止", true);
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
        const task = beginSummaryTask({
            label: "补总结旧历史",
            total: 1,
            canCancel: true,
        });
        const signal = task?.controller?.signal || null;
        backfillBtn.innerHTML = `<i class="fa-solid fa-stop"></i> 暂停扫描`;
        try {
            const userName = ctx.name1 || "User";
            const charName = ctx.name2 || "Character";
            const result = await backfillExistingChatHistory(getSettings(), memoryData, chat, userName, charName, {
                onProgress: (cur, total, roundNumber) => {
                    updateSummaryTask(task, {
                        current: cur,
                        total,
                        roundNumber,
                        detail: `正在总结第 ${roundNumber} 轮`,
                    });
                    updateStatusBar(`⏳ 扫描旧历史 (${cur}/${total}) · 第 ${roundNumber} 轮...`);
                },
                onRetry: (attempt, total, error, roundNumber) => {
                    updateSummaryTask(task, {
                        detail: `第 ${roundNumber} 轮解析失败，正在自动重试 (${attempt - 1}/${total - 1})`,
                    });
                    updateStatusBar(
                        `⏳ 第 ${roundNumber} 轮解析失败，自动重试 (${attempt - 1}/${total - 1})：${String(error?.message || "等待重新解析").slice(0, 80)}`,
                        true,
                    );
                },
                onChunkSaved: async () => {
                    if (!isCurrentChat(backfillChatKey)) return;
                    await saveChatMemory();
                    await refreshPromptInjection();
                },
                shouldAbort: () => abortBackfillFlag
                    || isSummaryTaskCancelled(task)
                    || !isCurrentChat(backfillChatKey),
                shouldCommitTurn: () => isCurrentChat(backfillChatKey),
                signal,
            });
            if (!isCurrentChat(backfillChatKey)) return;
            memoryData.lastSummaryError = null;
            syncHiddenMessagesState();
            updateFloatingWidgetUI();
            updateStatusBar(result.aborted
                ? `⏸️ 已暂停，当前已处理 ${result.processedCount} 轮；再次点击可继续。`
                : `✅ 存量历史按轮次扫描构建完成！`);
        } catch (e) {
            if (signal?.aborted || e?.name === "AbortError") {
                memoryData.lastSummaryError = null;
                await saveChatMemory().catch(() => {});
                updateStatusBar(`⏸️ 已停止历史回溯，已保存进度。`);
                return;
            }
            memoryData.lastSummaryError = {
                message: String(e?.message || "历史回溯中断").slice(0, 300),
                roundNumber: numOr(memoryData.lastProcessedRound, 0) + 1,
                at: Date.now(),
            };
            await saveChatMemory().catch(() => {});
            updateFloatingWidgetUI();
            updateStatusBar(`❌ 历史回溯中断: ${e.message}`, true);
        }
        finally {
            isBackfilling = false;
            activeBackfillChatKey = null;
            backfillBtn.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> 一键扫描旧历史`;
            finishSummaryTask(task);
        }
    });

    const restoreHiddenBtn = document.getElementById("tiandao_restore_hidden_btn");
    if (restoreHiddenBtn) restoreHiddenBtn.addEventListener("click", () => {
        syncHiddenMessagesState(true);
        settings.autoHideOldMessages = false;
        const autoHideEl = document.getElementById("tiandao_auto_hide");
        if (autoHideEl) autoHideEl.checked = false;
        saveSettings();
        updateFloatingWidgetUI();
        updateStatusBar(`👁️ 已恢复显示所有历史原文。`);
    });

    const clearBtn = document.getElementById("tiandao_clear_memory_btn");
    if (clearBtn) clearBtn.addEventListener("click", async () => {
        if (!confirm("确定要清空当前聊天存档的所有记忆与状态账本吗？")) return;
        const ctx = getSTContext();
        const metadata = ctx.chatMetadata || window.chat_metadata;
        if (metadata) {
            summaryEpoch++;
            if (activeSummaryTask) requestSummaryTaskStop();
            storyEditingKey = null;
            storyEditingId = null;
            storyViewRange = null;
            storyPage = 0;
            syncHiddenMessagesState(true);
            invalidateRoundIndexCache(ctx.chat || []);
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

}

(async function initTiandaoMemoryExtension() {
    try {
        initFloatingWidget();
        const repositionFloatingWidget = () => requestAnimationFrame(positionFloatingWidgetCard);
        window.addEventListener("resize", repositionFloatingWidget);
        window.addEventListener("orientationchange", repositionFloatingWidget);
        window.visualViewport?.addEventListener("resize", repositionFloatingWidget);

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
                pendingHierarchyEdits.clear();
                clearSwipeRepairTimer();
                if (activeSummaryTask) requestSummaryTaskStop();
                if (isBackfilling) abortBackfillFlag = true;
                storyEditingKey = null;
                storyEditingId = null;
                storyViewRange = null;
                storyPage = 0;
                expandedCharacterCards.clear();
                expandedInventoryCards.clear();
                refreshChatFingerprint(getSTContext().chat || []);
                await refreshPromptInjection(); syncHiddenMessagesState(); updateFloatingWidgetUI();
            });
            if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, async (type, _options, dryRun) => {
                const settings = getSettings();
                clearSwipeRepairTimer();
                // 正常生成由 generate_interceptor 统一处理；dryRun 不会运行拦截器，
                // 这里只刷新提示词，不触发摘要，避免预览时消耗 API。
                if (!dryRun) return;
                syncHiddenMessagesState();
                const currentChat = getSTContext().chat || [];
                await refreshPromptInjection(buildRecentContextQuery(currentChat, settings.targetContentTags, settings.customStripTags));
            });
            if (eventTypes.CHARACTER_MESSAGE_RENDERED) eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, async (msgId) => {
                const settings = getSettings();
                clearSwipeRepairTimer();
                const currentCtx = getSTContext();
                const chat = currentCtx.chat || [];
                invalidateRoundIndexCache(chat);
                refreshChatFingerprint(chat);
                syncHiddenMessagesState(); updateFloatingWidgetUI();
                if (settings.autoSummarizePerTurn && settings.summarizeTiming === "after_reply") {
                    const chatKey = getChatKey();
                    const epoch = summaryEpoch;
                    enqueuePendingAiTurns(chat, msgId, {
                        ctx: currentCtx,
                        chatKey,
                        epoch,
                        label: "即时归档",
                    });
                }
            });
            if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, async (newLength) => {
                clearSwipeRepairTimer();
                const chat = getSTContext().chat || [];
                invalidateRoundIndexCache(chat);
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
                        memoryData.lastSummaryError = null;
                        await saveChatMemory();
                        await refreshPromptInjection();
                    }
                }
                syncHiddenMessagesState(); updateFloatingWidgetUI();
            });
            if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, async (idx) => {
                clearSwipeRepairTimer();
                summaryEpoch++;
                const currentCtx = getSTContext();
                const chat = currentCtx.chat || [];
                invalidateRoundIndexCache(chat);
                refreshChatFingerprint(chat);
                const memoryData = getChatMemory();
                if (memoryData.lastProcessedMessageId >= idx) {
                    rollbackMemoryFromMessageIndex(memoryData, idx);
                    memoryData.lastSummaryError = null;
                    await saveChatMemory();
                    syncHiddenMessagesState();
                }
                const targetMsg = chat[idx];
                const settings = getSettings();
                if (settings.enabled
                    && settings.autoSummarizePerTurn
                    && settings.summarizeTiming === "after_reply") {
                    const chatKey = getChatKey();
                    const epoch = summaryEpoch;
                    enqueuePendingAiTurns(chat, chat.length - 1, {
                        ctx: currentCtx,
                        chatKey,
                        epoch,
                        label: "编辑后重建",
                    });
                } else if (targetMsg && !targetMsg.is_user && settings.enabled && settings.autoSummarizePerTurn) {
                    const chatKey = getChatKey();
                    const epoch = summaryEpoch;
                    enqueueBackgroundSummary(async () => {
                        if (!isCurrentChat(chatKey) || epoch !== summaryEpoch || chat[idx] !== targetMsg) return;
                        await processSingleAiTurn(idx, false, { ctx: currentCtx, chat, chatKey, epoch });
                    }, "编辑后重建");
                } else {
                    await refreshPromptInjection().catch(() => {});
                }
                updateFloatingWidgetUI();
            });
            if (eventTypes.MESSAGE_SWIPED) eventSource.on(eventTypes.MESSAGE_SWIPED, async (idx) => {
                clearSwipeRepairTimer();
                summaryEpoch++;
                const chat = getSTContext().chat || [];
                invalidateRoundIndexCache(chat);
                refreshChatFingerprint(chat);
                const memoryData = getChatMemory();
                const startFloor = idx > 0 && chat[idx - 1]?.is_user ? idx - 1 : idx;
                if (memoryData.lastProcessedMessageId >= startFloor) {
                    rollbackMemoryFromMessageIndex(memoryData, startFloor);
                    memoryData.lastSummaryError = null;
                    await saveChatMemory();
                    syncHiddenMessagesState();
                    await refreshPromptInjection().catch(() => {});
                    updateFloatingWidgetUI();
                    scheduleAfterReplySwipeRepair(getChatKey());
                }
            });
            if (eventTypes.MESSAGE_UPDATED) eventSource.on(eventTypes.MESSAGE_UPDATED, () => {
                const chat = getSTContext().chat || [];
                invalidateRoundIndexCache(chat);
                refreshChatFingerprint(chat);
            });
        }
        updateFloatingWidgetUI();
        console.log("[溯微] v1.13.2 (回滚一致性·事务重建·队列停止) 加载完毕！");
    } catch (err) { console.error("[溯微] 初始化异常:", err); }
})();
