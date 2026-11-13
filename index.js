import {
    DEFAULT_SETTINGS,
    createEmptyMemoryData,
    cleanMessageText,
    callIndependentLLM,
    summarizeSingleTurn,
    rollbackMemoryFromMessageIndex,
    calculateRoundForMessageIndex,
    retrieveRelevantArchivedMemories,
    buildInjectedMemoryPrompt,
    buildNarrativeStoryView,
    createEditableMemoryCopy,
    mergeEditedMemoryWithEmbeddings,
    backfillExistingChatHistory,
} from "./memory-engine.js";

const EXTENSION_NAME = "tiandao-memory-engine";
const PROMPT_KEY = "tiandao_memory_prompt";

// 运行时状态控制
let isSummarizingTurn = false;
let isBackfilling = false;
let abortBackfillFlag = false;

function getSTContext() {
    if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
        return SillyTavern.getContext();
    }
    return window;
}

function getSettings() {
    const ctx = getSTContext();
    const extSettings = ctx.extensionSettings || window.extension_settings || {};
    if (!extSettings[EXTENSION_NAME]) {
        extSettings[EXTENSION_NAME] = Object.assign({}, DEFAULT_SETTINGS);
    }
    // 兼容旧配置项迁移
    if (extSettings[EXTENSION_NAME].keepRecentRoundsCount === undefined) {
        const oldMessagesCount = extSettings[EXTENSION_NAME].keepRecentMessagesCount;
        extSettings[EXTENSION_NAME].keepRecentRoundsCount = oldMessagesCount ? Math.max(1, Math.round(oldMessagesCount / 2)) : 3;
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (extSettings[EXTENSION_NAME][k] === undefined) {
            extSettings[EXTENSION_NAME][k] = v;
        }
    }
    return extSettings[EXTENSION_NAME];
}

function saveSettings() {
    const ctx = getSTContext();
    if (typeof ctx.saveSettingsDebounced === "function") {
        ctx.saveSettingsDebounced();
    }
}

function getChatMemory() {
    const ctx = getSTContext();
    const metadata = ctx.chatMetadata || window.chat_metadata;
    if (!metadata) return createEmptyMemoryData();
    if (!metadata.tiandao_memory) {
        metadata.tiandao_memory = createEmptyMemoryData();
    }
    return metadata.tiandao_memory;
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
    if (el) {
        el.textContent = text;
        el.style.color = isError ? "#ff8080" : "#a8d8b9";
    }
}

function buildRecentContextQuery(chat, targetContentTags, customStripTags) {
    if (!Array.isArray(chat) || chat.length === 0) return "";
    const snippets = [];
    for (let i = chat.length - 1; i >= 0 && snippets.length < 2; i--) {
        const msg = chat[i];
        if (!msg || (msg.is_system && !msg.extra?.tiandao_hidden)) continue;
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
        ctx.setExtensionPrompt(PROMPT_KEY, "", settings.injectionPosition, settings.injectionDepth);
        return;
    }

    const memoryData = getChatMemory();
    const queryText = customQuery || buildRecentContextQuery(ctx.chat || [], settings.targetContentTags, settings.customStripTags);

    let retrieved = [];
    if (settings.enableRetrieval && queryText) {
        retrieved = await retrieveRelevantArchivedMemories(settings, memoryData, queryText);
    }

    const promptText = buildInjectedMemoryPrompt(memoryData, retrieved);
    ctx.setExtensionPrompt(
        PROMPT_KEY,
        promptText,
        Number(settings.injectionPosition ?? 1),
        Number(settings.injectionDepth ?? 4),
        false,
        Number(settings.injectionRole ?? 0)
    );

    updateFloatingWidgetUI();
}

globalThis.tiandaoMemoryInterceptor = async function (chat, _contextSize, _abort, type) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        if (settings.summarizeTiming === "on_next_send") {
            await settlePendingConfirmedTurnsBeforeGeneration(chat, type);
        }

        syncHiddenMessagesState();
        const query = buildRecentContextQuery(chat, settings.targetContentTags, settings.customStripTags);
        await refreshPromptInjection(query);
    } catch (e) {
        console.warn("[溯微] Interceptor refresh error:", e);
    }
};

/**
 * 严格按照一问一答“轮数 (Round)”来裁剪隐藏历史：
 * 保留最近 keepRecentRoundsCount 轮完整一问一答（即最近 N 个有效 AI 消息及其配对的 User 输入），更早的旧轮次自动隐藏
 */
function syncHiddenMessagesState(forceRestoreAll = false) {
    const settings = getSettings();
    const ctx = getSTContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) return 0;

    const shouldHide = settings.enabled && settings.autoHideOldMessages && !forceRestoreAll;
    const keepRounds = Math.max(1, Number(settings.keepRecentRoundsCount || 3));

    // 计算分界点：从后往前找第 keepRounds 个 AI 回复的起始索引
    let aiCount = 0;
    let cutoffIndex = 0;

    if (shouldHide) {
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg && !msg.is_user && (!msg.is_system || msg.extra?.tiandao_hidden)) {
                aiCount++;
                if (aiCount === keepRounds) {
                    // 若前一条是配对的 user 消息，保留该 user 消息
                    cutoffIndex = (i > 0 && chat[i - 1]?.is_user) ? i - 1 : i;
                    break;
                }
            }
        }
    }

    let restoredCount = 0;

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;

        if (i < cutoffIndex) {
            if (!msg.is_system) {
                msg.is_system = true;
                msg.extra = msg.extra || {};
                msg.extra.tiandao_hidden = true;
            }
            const msgBlock = document.querySelector(`.mes[mesid="${i}"]`);
            if (msgBlock) msgBlock.setAttribute("is_system", "true");
        } else {
            if (msg.is_system && msg.extra?.tiandao_hidden) {
                msg.is_system = false;
                delete msg.extra.tiandao_hidden;
                restoredCount++;
                const msgBlock = document.querySelector(`.mes[mesid="${i}"]`);
                if (msgBlock) msgBlock.setAttribute("is_system", "false");
            }
        }
    }
    renderRecentTurnsList();
    updateFloatingWidgetUI();
    return restoredCount;
}

/**
 * 总结指定的一问一答轮次
 */
async function processSingleAiTurn(targetMessageId, isManual = false) {
    const settings = getSettings();
    if (!settings.enabled && !isManual) return;
    if (isSummarizingTurn || isBackfilling) return;

    const ctx = getSTContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) return;

    const msgIdx = typeof targetMessageId === "number" ? targetMessageId : chat.length - 1;
    const targetMsg = chat[msgIdx];
    if (!targetMsg || targetMsg.is_user || (targetMsg.is_system && !targetMsg.extra?.tiandao_hidden)) return;

    const memoryData = getChatMemory();
    const userName = ctx.name1 || "User";
    const charName = ctx.name2 || targetMsg.name || "Character";
    const roundNumber = calculateRoundForMessageIndex(chat, msgIdx);

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
    if (lines.length === 0) return;

    isSummarizingTurn = true;
    try {
        updateStatusBar(`⏳ 正在总结第 ${roundNumber} 轮对话并更新状态账本...`);
        await summarizeSingleTurn(settings, memoryData, {
            roundNumber,
            startMessageId: startFloor,
            endMessageId: msgIdx,
            userName,
            charName,
            dialogueText: lines.join("\n\n"),
        });
        memoryData.lastProcessedMessageId = msgIdx;
        memoryData.lastProcessedRound = roundNumber;
        await saveChatMemory();
        await refreshPromptInjection(aiCleaned);
        syncHiddenMessagesState();
        updateStatusBar(`✅ 第 ${roundNumber} 轮已归档`);
    } catch (err) {
        console.error("[溯微] Summarize turn error:", err);
        updateStatusBar(`❌ 总结失败: ${err.message}`, true);
    } finally {
        isSummarizingTurn = false;
        renderRecentTurnsList();
        updateFloatingWidgetUI();
    }
}

/**
 * 玩家发送下一条消息时，结算上一轮已定稿的一问一答
 */
async function settlePendingConfirmedTurnsBeforeGeneration(chat, generationType) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoSummarizePerTurn) return;
    if (isSummarizingTurn || isBackfilling) return;
    if (generationType === "swipe" || generationType === "regenerate") return;

    if (!Array.isArray(chat) || chat.length < 2) return;
    const memoryData = getChatMemory();

    const lastMsg = chat[chat.length - 1];
    const settledEndIdx = lastMsg?.is_user ? chat.length - 2 : chat.length - 1;
    if (settledEndIdx <= memoryData.lastProcessedMessageId) return;

    for (let idx = Math.max(0, memoryData.lastProcessedMessageId + 1); idx <= settledEndIdx; idx++) {
        const msg = chat[idx];
        if (!msg || msg.is_user || (msg.is_system && !msg.extra?.tiandao_hidden)) continue;
        await processSingleAiTurn(idx, false);
    }
}

/**
 * 渲染最近对话轮次列表（按一问一答轮数清晰排布）
 */
function renderRecentTurnsList() {
    const list = document.getElementById("tiandao_turns_list");
    if (!list) return;
    const ctx = getSTContext();
    const chat = ctx.chat || [];
    const html = [];
    
    // 找出所有有效 AI 消息
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (msg && !msg.is_user && (!msg.is_system || msg.extra?.tiandao_hidden)) {
            turns.push({
                round: turns.length + 1,
                msgIdx: i,
                name: msg.name || ctx.name2 || "AI",
            });
        }
    }

    // 只展示最近 10 轮
    const recentTurns = turns.slice(-10).reverse();

    for (const t of recentTurns) {
        html.push(`
        <div class="tiandao-turn-item">
            <span><b>第 ${t.round} 轮</b> (${t.name})</span>
            <span class="tiandao-turn-btn" onclick="window.tiandaoProcessTurn(${t.msgIdx})">🔄 重新总结本轮</span>
        </div>`);
    }

    list.innerHTML = html.length > 0 ? html.join("") : "<div style='opacity:0.6; padding:4px;'>暂无已完成的对话轮次</div>";
}

window.tiandaoProcessTurn = async (idx) => {
    await processSingleAiTurn(idx, true);
};

// ==================== 🌌 “溯微” 实时记忆悬浮窗 (Floating Widget) ====================
let isWidgetExpanded = false;

function initFloatingWidget() {
    let widget = document.getElementById("tiandao_floating_widget");
    if (widget) return;

    widget = document.createElement("div");
    widget.id = "tiandao_floating_widget";
    widget.innerHTML = `
        <div id="tiandao_widget_pill" class="tiandao-widget-pill" title="溯微记忆引擎 (点击展开/折叠，长按可拖拽)">
            <span>🌌 溯微</span>
            <span id="tiandao_widget_badge" class="tiandao-pill-badge">就绪</span>
        </div>
        <div id="tiandao_widget_card" class="tiandao-widget-card" style="display: none;">
            <div class="tiandao-card-header">
                <div class="tiandao-card-tabs">
                    <button type="button" id="tiandao_tab_ledger_btn" class="tiandao-tab-btn active"><i class="fa-solid fa-book-bookmark"></i> 状态看板</button>
                    <button type="button" id="tiandao_tab_settings_btn" class="tiandao-tab-btn"><i class="fa-solid fa-sliders"></i> 溯微设置</button>
                </div>
                <span id="tiandao_widget_close_btn" class="tiandao-close-btn" title="折叠看板">&times;</span>
            </div>
            <div id="tiandao_status_bar" class="tiandao-status-bar">当前状态：就绪</div>
            <div id="tiandao_widget_body" class="tiandao-card-body">
                <!-- Tab 1: 状态看板 -->
                <div id="tiandao_tab_ledger_content" class="tiandao-tab-page">
                    <div id="tiandao_widget_body_inner" class="tiandao-ledger-list">
                        <!-- 动态内容 -->
                    </div>
                </div>

                <!-- Tab 2: 完整设置与管理 -->
                <div id="tiandao_tab_settings_content" class="tiandao-tab-page" style="display: none;">
                    <!-- 核心运行与轮次裁剪 -->
                    <div class="tiandao-section">
                        <div class="tiandao-section-title">⚙️ 核心运行与轮次裁剪</div>
                        <label class="tiandao-switch-label">
                            <input id="tiandao_enabled" type="checkbox" />
                            <span>启用溯微记忆引擎（注入状态账本与时间线）</span>
                        </label>
                        <label class="tiandao-switch-label">
                            <input id="tiandao_auto_summarize" type="checkbox" />
                            <span>自动调用独立 API 总结每轮对话</span>
                        </label>
                        <div class="tiandao-row">
                            <span>总结触发时机：</span>
                            <select id="tiandao_summarize_timing" class="tiandao-select">
                                <option value="on_next_send">玩家发送下一条时 (重Roll零消耗·推荐)</option>
                                <option value="after_reply">AI 回复后立即总结</option>
                            </select>
                        </div>
                        <hr class="tiandao-divider" />
                        <label class="tiandao-switch-label">
                            <input id="tiandao_auto_hide" type="checkbox" />
                            <span><b>自动隐藏超出轮次原文</b>（只发最近 N 轮）</span>
                        </label>
                        <div class="tiandao-row">
                            <span>保留最近几轮一问一答：</span>
                            <div style="display:flex; align-items:center; gap:6px;">
                                <input id="tiandao_keep_recent" type="number" class="tiandao-input" min="1" max="25" style="width: 55px; text-align: center;" />
                                <button type="button" id="tiandao_restore_hidden_btn" class="tiandao-btn tiandao-btn-sm" title="恢复所有被溯微隐藏的历史轮次">
                                    <i class="fa-solid fa-eye"></i> 恢复全部
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- 独立总结 API 设置 -->
                    <div class="tiandao-section">
                        <div class="tiandao-section-title">🔌 独立总结 API 设置 (OpenAI 兼容)</div>
                        <div class="tiandao-field">
                            <label>API 地址 (Base URL)</label>
                            <input id="tiandao_api_url" type="text" class="tiandao-input" placeholder="https://api.deepseek.com/v1" />
                        </div>
                        <div class="tiandao-field">
                            <label>API Key</label>
                            <input id="tiandao_api_key" type="password" class="tiandao-input" placeholder="sk-..." />
                        </div>
                        <div class="tiandao-row" style="gap:8px;">
                            <div style="flex: 1.4;">
                                <label style="font-size:0.8em; opacity:0.85; display:block; margin-bottom:2px;">总结模型 (Model)</label>
                                <input id="tiandao_model" type="text" class="tiandao-input" placeholder="deepseek-chat" />
                            </div>
                            <div style="flex: 0.8;">
                                <label style="font-size:0.8em; opacity:0.85; display:block; margin-bottom:2px;">温度 (Temp)</label>
                                <input id="tiandao_temp" type="number" step="0.1" min="0" max="1.5" class="tiandao-input" />
                            </div>
                        </div>
                        <div class="tiandao-field" style="margin-top:6px;">
                            <label>🎯 目标正文标签（白名单优先，逗号分隔）</label>
                            <input id="tiandao_target_tags" type="text" class="tiandao-input" placeholder="content,story,reply" />
                        </div>
                        <div class="tiandao-field">
                            <label>备用排除标签（黑名单）</label>
                            <input id="tiandao_strip_tags" type="text" class="tiandao-input" placeholder="thinking,think,report,options_engine" />
                        </div>
                        <div style="margin-top: 6px;">
                            <button type="button" id="tiandao_test_api_btn" class="tiandao-btn tiandao-btn-full"><i class="fa-solid fa-plug"></i> 测试独立 API 连接</button>
                        </div>
                    </div>

                    <!-- 记忆金字塔与注入设置 -->
                    <details class="tiandao-details">
                        <summary><i class="fa-solid fa-tree"></i> 记忆金字塔与提示词注入设置</summary>
                        <div class="tiandao-section-sub">
                            <div class="tiandao-row">
                                <span>向上合并步长 (满 K 条合并为 1 条)：</span>
                                <input id="tiandao_merge_chunk" type="number" class="tiandao-input" min="2" max="15" style="width: 55px; text-align: center;" />
                            </div>
                            <div class="tiandao-row">
                                <span>最大递归层级数 (L0 ~ L_max)：</span>
                                <input id="tiandao_max_level" type="number" class="tiandao-input" min="2" max="5" style="width: 55px; text-align: center;" />
                            </div>
                            <div class="tiandao-row">
                                <span>提示词注入位置：</span>
                                <select id="tiandao_inject_pos" class="tiandao-select">
                                    <option value="1">聊天历史中 (@ Depth)</option>
                                    <option value="0">聊天历史之后</option>
                                    <option value="2">主提示词之前</option>
                                </select>
                            </div>
                            <div class="tiandao-row">
                                <span>提示词注入深度 (Depth)：</span>
                                <input id="tiandao_inject_depth" type="number" class="tiandao-input" min="0" max="20" style="width: 55px; text-align: center;" />
                            </div>
                            <div class="tiandao-row">
                                <span>提示词注入角色 (Role)：</span>
                                <select id="tiandao_inject_role" class="tiandao-select">
                                    <option value="0">System (系统)</option>
                                    <option value="1">User (用户·高兼容)</option>
                                    <option value="2">Assistant (AI助手)</option>
                                </select>
                            </div>
                        </div>
                    </details>

                    <!-- 向量与关键词混合检索设置 -->
                    <details class="tiandao-details">
                        <summary><i class="fa-solid fa-magnifying-glass"></i> 陈年小事按需唤醒 (混合检索)</summary>
                        <div class="tiandao-section-sub">
                            <label class="tiandao-switch-label">
                                <input id="tiandao_enable_retrieval" type="checkbox" />
                                <span>开启历史微摘要按需唤醒 (聊到旧事自动召回)</span>
                            </label>
                            <div class="tiandao-row">
                                <span>最多唤醒历史小事条数 (Top-K)：</span>
                                <input id="tiandao_retrieval_topk" type="number" class="tiandao-input" min="1" max="10" style="width: 55px; text-align: center;" />
                            </div>
                            <label class="tiandao-switch-label" style="margin-top: 6px;">
                                <input id="tiandao_use_embedding" type="checkbox" />
                                <span>启用外部 Embedding 向量 API（默认本地双字分词）</span>
                            </label>
                            <div id="tiandao_embedding_box" style="display: none; margin-top: 6px;">
                                <div class="tiandao-field">
                                    <label>Embedding URL</label>
                                    <input id="tiandao_emb_url" type="text" class="tiandao-input" placeholder="https://api.siliconflow.cn/v1" />
                                </div>
                                <div class="tiandao-field">
                                    <label>Embedding API Key</label>
                                    <input id="tiandao_emb_key" type="password" class="tiandao-input" placeholder="sk-..." />
                                </div>
                                <div class="tiandao-field">
                                    <label>Embedding 模型</label>
                                    <input id="tiandao_emb_model" type="text" class="tiandao-input" placeholder="BAAI/bge-m3" />
                                </div>
                            </div>
                        </div>
                    </details>

                    <!-- 记忆维护与数据操作 -->
                    <div class="tiandao-section">
                        <div class="tiandao-section-title">🛠️ 记忆维护与数据操作</div>
                        <div class="tiandao-btn-grid">
                            <button type="button" id="tiandao_open_viewer_btn" class="tiandao-btn"><i class="fa-solid fa-book-open"></i> 时间线总览与备份</button>
                            <button type="button" id="tiandao_Summarize_last_btn" class="tiandao-btn"><i class="fa-solid fa-rotate"></i> 手动总结最新一轮</button>
                            <button type="button" id="tiandao_backfill_btn" class="tiandao-btn"><i class="fa-solid fa-clock-rotate-left"></i> 一键扫描旧历史</button>
                            <button type="button" id="tiandao_clear_memory_btn" class="tiandao-btn tiandao-btn-danger"><i class="fa-solid fa-trash"></i> 清空本存档记忆</button>
                        </div>
                    </div>

                    <!-- 最近对话轮次管理 -->
                    <div class="tiandao-section">
                        <div class="tiandao-section-title">🕒 最近对话轮次重整</div>
                        <div id="tiandao_turns_list" class="tiandao-turns-list">
                            <!-- 动态渲染最近一问一答轮次 -->
                        </div>
                    </div>
                </div>
            </div>

            <!-- 卡片底部状态与快捷操作 -->
            <div class="tiandao-card-footer">
                <span style="opacity: 0.8;" id="tiandao_widget_summary_info">L0: 0 | L1: 0 | L2: 0</span>
                <div style="display: flex; gap: 6px;">
                    <button type="button" id="tiandao_widget_refresh_last_btn" class="tiandao-btn tiandao-btn-sm" title="重整当前最新一问一答轮次"><i class="fa-solid fa-rotate"></i> 重整本轮</button>
                    <button type="button" id="tiandao_widget_full_view_btn" class="tiandao-btn tiandao-btn-sm" title="查看完整叙事时间线与备份"><i class="fa-solid fa-book-open"></i> 账本</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(widget);

    const pill = document.getElementById("tiandao_widget_pill");
    const card = document.getElementById("tiandao_widget_card");
    const closeBtn = document.getElementById("tiandao_widget_close_btn");
    const tabLedgerBtn = document.getElementById("tiandao_tab_ledger_btn");
    const tabSettingsBtn = document.getElementById("tiandao_tab_settings_btn");
    const tabLedgerContent = document.getElementById("tiandao_tab_ledger_content");
    const tabSettingsContent = document.getElementById("tiandao_tab_settings_content");
    const fullViewBtn = document.getElementById("tiandao_widget_full_view_btn");
    const refreshLastBtn = document.getElementById("tiandao_widget_refresh_last_btn");

    // 展开/折叠
    pill.addEventListener("click", () => {
        isWidgetExpanded = !isWidgetExpanded;
        card.style.display = isWidgetExpanded ? "flex" : "none";
        if (isWidgetExpanded) {
            updateFloatingWidgetUI();
        }
    });

    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        isWidgetExpanded = false;
        card.style.display = "none";
    });

    // Tab 切换
    tabLedgerBtn.addEventListener("click", () => {
        tabLedgerBtn.classList.add("active");
        tabSettingsBtn.classList.remove("active");
        tabLedgerContent.style.display = "block";
        tabSettingsContent.style.display = "none";
    });

    tabSettingsBtn.addEventListener("click", () => {
        tabSettingsBtn.classList.add("active");
        tabLedgerBtn.classList.remove("active");
        tabLedgerContent.style.display = "none";
        tabSettingsContent.style.display = "block";
        renderRecentTurnsList();
    });

    if (fullViewBtn) fullViewBtn.addEventListener("click", () => openMemoryViewerModal());
    if (refreshLastBtn) refreshLastBtn.addEventListener("click", async () => {
        const ctx = getSTContext();
        const chat = ctx.chat || [];
        if (chat.length > 0) await processSingleAiTurn(chat.length - 1, true);
    });

    makeDraggable(widget, pill);
    bindSettingsUI();
    updateFloatingWidgetUI();
}

function makeDraggable(element, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    let isDragging = false;

    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        if (e.target.closest("#tiandao_widget_close_btn, button, input, select, textarea")) return;
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        isDragging = false;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e.preventDefault();
        isDragging = true;
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        element.style.top = Math.max(10, Math.min(window.innerHeight - 50, element.offsetTop - pos2)) + "px";
        element.style.left = Math.max(10, Math.min(window.innerWidth - 100, element.offsetLeft - pos1)) + "px";
        element.style.right = "auto";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }

    handle.ontouchstart = function(e) {
        if (e.target.closest("#tiandao_widget_close_btn, button, input, select, textarea")) return;
        const touch = e.touches[0];
        pos3 = touch.clientX;
        pos4 = touch.clientY;
        isDragging = false;

        document.ontouchend = function() {
            document.ontouchend = null;
            document.ontouchmove = null;
        };

        document.ontouchmove = function(ev) {
            const t = ev.touches[0];
            isDragging = true;
            pos1 = pos3 - t.clientX;
            pos2 = pos4 - t.clientY;
            pos3 = t.clientX;
            pos4 = t.clientY;
            element.style.top = Math.max(10, Math.min(window.innerHeight - 50, element.offsetTop - pos2)) + "px";
            element.style.left = Math.max(10, Math.min(window.innerWidth - 100, element.offsetLeft - pos1)) + "px";
            element.style.right = "auto";
        };
    };
}

function updateFloatingWidgetUI() {
    const settings = getSettings();
    const widget = document.getElementById("tiandao_floating_widget");
    if (!widget) return;

    if (!settings.enabled || !settings.showFloatingWidget) {
        widget.style.display = "none";
        return;
    }
    widget.style.display = "block";

    const memoryData = getChatMemory();
    const ledger = memoryData.stateLedger || {};
    const badge = document.getElementById("tiandao_widget_badge");
    const bodyInner = document.getElementById("tiandao_widget_body_inner");
    const summaryInfo = document.getElementById("tiandao_widget_summary_info");

    const l0Count = (memoryData.levels?.[0] || []).length;
    const l1Count = (memoryData.levels?.[1] || []).length;
    const l2Count = (memoryData.levels?.[2] || []).length;

    if (badge) {
        const lastRound = memoryData.lastProcessedRound > 0 ? `第${memoryData.lastProcessedRound}轮` : "就绪";
        badge.textContent = lastRound;
    }

    if (summaryInfo) {
        summaryInfo.textContent = `L0(${l0Count}) L1(${l1Count}) L2(${l2Count}) | 池:${memoryData.archivePool?.length || 0}`;
    }

    if (!bodyInner) return;

    const chars = ledger.characters || {};
    const charCards = [];

    for (const [name, info] of Object.entries(chars)) {
        if (!info) continue;
        const removed = (info.removedItemsLock || []).length > 0
            ? `<div style="color: #fca5a5; margin-top:2px;">⚠️ <b>摘除饰品锁</b>: ${info.removedItemsLock.join(", ")}</div>`
            : "";
        const inv = (info.inventory || []).length > 0
            ? `<div style="color: #93c5fd; margin-top:2px;">📦 <b>随身道具</b>: ${info.inventory.join(", ")}</div>`
            : "";

        charCards.push(`
            <div class="tiandao-card-block" style="border-left: 3px solid #e0c280;">
                <div class="tiandao-block-title">
                    <span>👤 ${name}</span>
                    <span style="font-size:0.8em; opacity:0.8; font-weight:normal;">📍 ${info.location || "未知位置"}</span>
                </div>
                <div class="tiandao-block-content">
                    <div><b>状态行动</b>: ${info.statusAndAction || "平静"}</div>
                    <div><b>当前衣着</b>: ${info.wear || "常规穿戴"}</div>
                    ${removed}
                    ${inv}
                </div>
            </div>
        `);
    }

    const todoHtml = (ledger.todosAndPromises || []).length > 0
        ? ledger.todosAndPromises.map(x => `<div>📌 ${x}</div>`).join("")
        : "<div style='opacity:0.6;'>暂无待办约定</div>";

    bodyInner.innerHTML = `
        <div class="tiandao-card-block" style="background: rgba(224, 194, 128, 0.08);">
            <div class="tiandao-block-title"><i class="fa-solid fa-clock"></i> 故事时间</div>
            <div class="tiandao-block-content" style="color:#f3d48d; font-weight:bold;">${ledger.time || "未知时间"}</div>
        </div>
        ${charCards.length > 0 ? charCards.join("") : "<div style='opacity:0.6; padding:6px;'>暂无在场人物</div>"}
        <div class="tiandao-card-block">
            <div class="tiandao-block-title"><i class="fa-solid fa-list-check"></i> 待办与约定追踪</div>
            <div class="tiandao-block-content">${todoHtml}</div>
        </div>
    `;
}

function openMemoryViewerModal() {
    const ctx = getSTContext();
    const memoryData = getChatMemory();
    const editableCopy = createEditableMemoryCopy(memoryData);
    const jsonPretty = JSON.stringify(editableCopy, null, 2);
    const narrativeStoryText = buildNarrativeStoryView(memoryData);

    const html = `
    <div class="tiandao-modal-container">
        <h3 style="margin-top:0; color:#e0c280;">🌌 溯微 剧情时间线总览与人物账本</h3>
        <p style="font-size:0.85em; opacity:0.85; margin-bottom:8px;">
            按一问一答轮数清晰呈现的故事时间线与在场各人物状态。纯叙事文本展示，无杂乱代码：
        </p>
        <div class="tiandao-btn-row" style="margin-bottom:10px;">
            <div id="tiandao_export_json_btn" class="tiandao-btn" style="width:auto; padding:5px 12px;">
                <i class="fa-solid fa-file-export"></i> 导出记忆备份 (.json)
            </div>
            <label class="tiandao-btn" style="width:auto; padding:5px 12px; cursor:pointer; margin:0;">
                <i class="fa-solid fa-file-import"></i> 导入记忆备份
                <input id="tiandao_import_json_input" type="file" accept=".json" style="display:none;" />
            </label>
        </div>
        <div style="margin-bottom:12px;">
            <b style="color: #f3d48d;"><i class="fa-solid fa-book-bookmark"></i>【纯故事时间线总览】：</b>
            <textarea readonly style="min-height:230px; line-height: 1.6; font-family: inherit; font-size: 0.9em; background: rgba(0,0,0,0.45);">${narrativeStoryText.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>
        </div>
        <details style="margin-top: 8px;">
            <summary style="cursor:pointer; color:#a8d8b9; font-size:0.88em; padding:4px 0;"><i class="fa-solid fa-code"></i> 点击展开高级底层数据编辑器 (JSON)</summary>
            <div style="margin-top: 6px;">
                <textarea id="tiandao_json_editor" style="min-height:220px; font-family: monospace;">${jsonPretty.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>
            </div>
        </details>
    </div>`;

    if (typeof ctx.callGenericPopup === "function" || typeof window.callPopup === "function") {
        const popupFn = ctx.callGenericPopup || window.callPopup;
        setTimeout(() => {
            const exportBtn = document.getElementById("tiandao_export_json_btn");
            if (exportBtn) {
                exportBtn.addEventListener("click", () => {
                    const blob = new Blob([JSON.stringify(getChatMemory(), null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `suwei_memory_${ctx.name2 || "chat"}_${Date.now()}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                });
            }
            const importInput = document.getElementById("tiandao_import_json_input");
            if (importInput) {
                importInput.addEventListener("change", (ev) => {
                    const file = ev.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                        try {
                            const imported = JSON.parse(String(reader.result));
                            const editor = document.getElementById("tiandao_json_editor");
                            if (editor) {
                                editor.value = JSON.stringify(createEditableMemoryCopy(imported), null, 2);
                            }
                            const metadata = ctx.chatMetadata || window.chat_metadata;
                            if (metadata) {
                                metadata.tiandao_memory = imported;
                            }
                            updateStatusBar("📥 记忆备份已载入编辑器，点击【保存修改】即可持久化生效！");
                        } catch (err) {
                            alert("导入 JSON 文件格式无效: " + err.message);
                        }
                    };
                    reader.readAsText(file);
                });
            }
        }, 120);

        popupFn(html, "text", "", { okButton: "保存修改", cancelButton: "关闭" }).then(async (res) => {
            if (res) {
                const editor = document.getElementById("tiandao_json_editor");
                if (editor) {
                    try {
                        const editedObj = JSON.parse(editor.value);
                        const merged = mergeEditedMemoryWithEmbeddings(getChatMemory(), editedObj);
                        const metadata = ctx.chatMetadata || window.chat_metadata;
                        if (metadata) {
                            metadata.tiandao_memory = merged;
                            await saveChatMemory();
                            await refreshPromptInjection();
                            updateStatusBar("✅ 手动修改记忆账本已保存并生效！");
                        }
                    } catch (e) {
                        alert("JSON 格式有误，保存失败: " + e.message);
                    }
                }
            }
        });
    }
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

    const bindInput = (id, key, isNum = false, onChange = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = settings[key] ?? "";
        el.addEventListener("change", () => {
            settings[key] = isNum ? Number(el.value) : el.value.trim();
            saveSettings();
            if (onChange) onChange(settings[key]);
        });
    };

    bindCheck("tiandao_enabled", "enabled", () => {
        refreshPromptInjection();
        syncHiddenMessagesState();
        updateFloatingWidgetUI();
    });
    bindCheck("tiandao_auto_summarize", "autoSummarizePerTurn");
    bindInput("tiandao_summarize_timing", "summarizeTiming");

    bindCheck("tiandao_auto_hide", "autoHideOldMessages", (checked) => {
        const count = syncHiddenMessagesState(!checked);
        if (!checked) {
            updateStatusBar(`👁️ 已关闭自动隐藏，恢复显示 ${count} 条历史原文`);
        } else {
            updateStatusBar(`🙈 已开启原文裁剪：仅发送最近 ${settings.keepRecentRoundsCount} 轮完整一问一答原文`);
        }
    });
    bindInput("tiandao_keep_recent", "keepRecentRoundsCount", true, (val) => {
        syncHiddenMessagesState();
        if (settings.autoHideOldMessages) {
            updateStatusBar(`📏 已更新保留轮数：当前仅发送最近 ${val} 轮一问一答原文`);
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

    const embBox = document.getElementById("tiandao_embedding_box");
    if (embBox) embBox.style.display = settings.useEmbeddingApi ? "block" : "none";
    bindCheck("tiandao_use_embedding", "useEmbeddingApi", (checked) => {
        if (embBox) embBox.style.display = checked ? "block" : "none";
    });
    bindInput("tiandao_emb_url", "embeddingApiUrl");
    bindInput("tiandao_emb_key", "embeddingApiKey");
    bindInput("tiandao_emb_model", "embeddingModel");

    const testBtn = document.getElementById("tiandao_test_api_btn");
    if (testBtn) testBtn.addEventListener("click", async () => {
        try {
            updateStatusBar("⏳ 正在测试独立 API 连接...");
            const reply = await callIndependentLLM(settings, [{ role: "user", content: "请仅回复“连接成功”四个字。" }]);
            updateStatusBar(`✅ API 测试通过！模型回复: ${reply.slice(0, 30)}`);
        } catch (e) {
            updateStatusBar(`❌ API 连接失败: ${e.message}`, true);
        }
    });

    const viewerBtn = document.getElementById("tiandao_open_viewer_btn");
    if (viewerBtn) viewerBtn.addEventListener("click", () => openMemoryViewerModal());

    const sumLastBtn = document.getElementById("tiandao_Summarize_last_btn");
    if (sumLastBtn) sumLastBtn.addEventListener("click", async () => {
        const ctx = getSTContext();
        const chat = ctx.chat || [];
        if (chat.length === 0) return updateStatusBar("当前无聊天消息", true);
        await processSingleAiTurn(chat.length - 1, true);
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
        backfillBtn.innerHTML = `<i class="fa-solid fa-stop"></i> 暂停扫描`;
        try {
            const userName = ctx.name1 || "User";
            const charName = ctx.name2 || "Character";
            await backfillExistingChatHistory(settings, memoryData, chat, userName, charName, {
                onProgress: (cur, total, roundNumber) => updateStatusBar(`⏳ 扫描旧历史 (${cur}/${total}) · 第 ${roundNumber} 轮...`),
                onChunkSaved: async () => { await saveChatMemory(); await refreshPromptInjection(); },
                shouldAbort: () => abortBackfillFlag,
            });
            syncHiddenMessagesState();
            updateStatusBar(`✅ 存量历史按轮次扫描构建完成！`);
        } catch (e) { updateStatusBar(`❌ 历史回溯中断: ${e.message}`, true); }
        finally { isBackfilling = false; backfillBtn.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> 一键扫描旧历史`; }
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
            metadata.tiandao_memory = createEmptyMemoryData();
            await saveChatMemory();
            await refreshPromptInjection();
            updateStatusBar("🗑️ 已清空本存档记忆账本");
            updateFloatingWidgetUI();
        }
    });
}

(async function initTiandaoMemoryExtension() {
    try {
        // 直接初始化悬浮窗（所有设置与状态看板均已收敛在悬浮窗内）
        initFloatingWidget();

        const ctx = getSTContext();
        const eventSource = ctx.eventSource || window.eventSource;
        const eventTypes = ctx.event_types || window.event_types || {};

        if (eventSource && eventTypes) {
            if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, async () => {
                await refreshPromptInjection(); syncHiddenMessagesState(); renderRecentTurnsList(); updateFloatingWidgetUI();
            });
            if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, async (type) => {
                const settings = getSettings();
                if (settings.summarizeTiming === "on_next_send") await settlePendingConfirmedTurnsBeforeGeneration(ctx.chat || [], type);
                syncHiddenMessagesState();
                await refreshPromptInjection(buildRecentContextQuery(ctx.chat || [], settings.targetContentTags, settings.customStripTags));
            });
            if (eventTypes.CHARACTER_MESSAGE_RENDERED) eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, async (msgId) => {
                const settings = getSettings();
                syncHiddenMessagesState(); renderRecentTurnsList(); updateFloatingWidgetUI();
                if (settings.autoSummarizePerTurn && settings.summarizeTiming === "after_reply") await processSingleAiTurn(msgId);
            });
            if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, async () => {
                const chat = ctx.chat || [];
                const memoryData = getChatMemory();
                if (memoryData.lastProcessedMessageId >= chat.length) {
                    if (rollbackMemoryFromMessageIndex(memoryData, chat.length)) { await saveChatMemory(); await refreshPromptInjection(); }
                }
                syncHiddenMessagesState(); renderRecentTurnsList(); updateFloatingWidgetUI();
            });
            if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, async (idx) => {
                const memoryData = getChatMemory();
                if (memoryData.lastProcessedMessageId >= idx) {
                    rollbackMemoryFromMessageIndex(memoryData, idx);
                    await saveChatMemory();
                    await processSingleAiTurn(idx, true);
                    renderRecentTurnsList();
                    updateFloatingWidgetUI();
                }
            });
            if (eventTypes.MESSAGE_SWIPED) eventSource.on(eventTypes.MESSAGE_SWIPED, async (idx) => {
                const chat = ctx.chat || [];
                const memoryData = getChatMemory();
                const startFloor = idx > 0 && chat[idx - 1]?.is_user ? idx - 1 : idx;
                if (memoryData.lastProcessedMessageId >= startFloor) {
                    rollbackMemoryFromMessageIndex(memoryData, startFloor);
                    await saveChatMemory();
                    await refreshPromptInjection();
                    renderRecentTurnsList();
                    updateFloatingWidgetUI();
                }
            });
        }
        console.log("[溯微] v1.7.0 (纯悬浮窗架构·按轮数精准时间线与状态账本) 加载完毕！");
    } catch (err) { console.error("[溯微] 初始化异常:", err); }
})();
