import {
    DEFAULT_SETTINGS,
    createEmptyMemoryData,
    cleanMessageText,
    callIndependentLLM,
    summarizeSingleTurn,
    rollbackMemoryFromFloor,
    retrieveRelevantArchivedMemories,
    buildInjectedMemoryPrompt,
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

    // 实时更新悬浮窗内容
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
        console.warn("[Tiandao Memory] Interceptor refresh error:", e);
    }
};

function syncHiddenMessagesState(forceRestoreAll = false) {
    const settings = getSettings();
    const ctx = getSTContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) return 0;

    const shouldHide = settings.enabled && settings.autoHideOldMessages && !forceRestoreAll;
    const keepCount = Math.max(1, Number(settings.keepRecentMessagesCount || 6));
    const cutoffIndex = shouldHide ? Math.max(0, chat.length - keepCount) : 0;

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

    const lines = [];
    let startFloor = msgIdx;
    if (msgIdx > 0 && chat[msgIdx - 1] && chat[msgIdx - 1].is_user) {
        startFloor = msgIdx - 1;
        const userCleaned = cleanMessageText(chat[msgIdx - 1].mes, settings.targetContentTags, settings.customStripTags);
        if (userCleaned) {
            lines.push(`【第${msgIdx - 1}楼 · ${userName}】：\n${userCleaned}`);
        }
    }
    const aiCleaned = cleanMessageText(targetMsg.mes, settings.targetContentTags, settings.customStripTags);
    if (aiCleaned) {
        lines.push(`【第${msgIdx}楼 · ${charName}】：\n${aiCleaned}`);
    }
    if (lines.length === 0) return;

    const floorRange = startFloor === msgIdx ? `${msgIdx}` : `${startFloor}-${msgIdx}`;
    
    isSummarizingTurn = true;
    try {
        updateStatusBar(`⏳ 正在总结第 ${floorRange} 楼并更新状态账本...`);
        await summarizeSingleTurn(settings, memoryData, {
            floorRange,
            userName,
            charName,
            dialogueText: lines.join("\n\n"),
        });
        memoryData.lastProcessedMessageId = msgIdx;
        await saveChatMemory();
        await refreshPromptInjection(aiCleaned);
        syncHiddenMessagesState();
        updateStatusBar(`✅ 第 ${floorRange} 楼已归档`);
    } catch (err) {
        console.error("[Tiandao Memory] Summarize turn error:", err);
        updateStatusBar(`❌ 总结失败: ${err.message}`, true);
    } finally {
        isSummarizingTurn = false;
        renderRecentTurnsList();
        updateFloatingWidgetUI();
    }
}

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

function renderRecentTurnsList() {
    const list = document.getElementById("tiandao_turns_list");
    if (!list) return;
    const ctx = getSTContext();
    const chat = ctx.chat || [];
    const html = [];
    
    let count = 0;
    for (let i = chat.length - 1; i >= 0 && count < 10; i--) {
        const msg = chat[i];
        if (msg && !msg.is_user) {
            html.push(`
            <div class="tiandao-turn-item">
                <span>第 ${i} 楼: ${msg.name || "AI"}</span>
                <span class="tiandao-turn-btn" onclick="window.tiandaoProcessTurn(${i})">🔄 重新总结</span>
            </div>`);
            count++;
        }
    }
    list.innerHTML = html.join("");
}

window.tiandaoProcessTurn = async (idx) => {
    await processSingleAiTurn(idx, true);
};

// ==================== 🌌 实时记忆悬浮窗 (Floating Widget) 模块 ====================
let isWidgetExpanded = false;

function initFloatingWidget() {
    let widget = document.getElementById("tiandao_floating_widget");
    if (widget) return;

    widget = document.createElement("div");
    widget.id = "tiandao_floating_widget";
    widget.innerHTML = `
        <div id="tiandao_widget_pill" class="tiandao-widget-pill" title="天道·溯微长线记忆看板 (点击展开/折叠，可按住拖拽)">
            <span>🌌 天道记忆</span>
            <span id="tiandao_widget_badge" class="tiandao-pill-badge">就绪</span>
        </div>
        <div id="tiandao_widget_card" class="tiandao-widget-card" style="display: none;">
            <div class="tiandao-card-header">
                <span>🌌 溯微实时状态账本</span>
                <span id="tiandao_widget_close_btn" style="cursor: pointer; opacity: 0.8; font-size: 1.1em;" title="折叠看板">&times;</span>
            </div>
            <div id="tiandao_widget_body" class="tiandao-card-body">
                <!-- 动态内容 -->
            </div>
            <div class="tiandao-card-footer">
                <span style="opacity: 0.7;" id="tiandao_widget_summary_info">L0: 0 | L1: 0 | L2: 0</span>
                <div style="display: flex; gap: 6px;">
                    <button id="tiandao_widget_refresh_last_btn" class="menu_button" style="padding: 2px 8px; font-size: 0.85em; width: auto;"><i class="fa-solid fa-rotate"></i> 重整本轮</button>
                    <button id="tiandao_widget_full_view_btn" class="menu_button" style="padding: 2px 8px; font-size: 0.85em; width: auto;"><i class="fa-solid fa-book-open"></i> 账本</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(widget);

    const pill = document.getElementById("tiandao_widget_pill");
    const card = document.getElementById("tiandao_widget_card");
    const closeBtn = document.getElementById("tiandao_widget_close_btn");
    const fullViewBtn = document.getElementById("tiandao_widget_full_view_btn");
    const refreshLastBtn = document.getElementById("tiandao_widget_refresh_last_btn");

    pill.addEventListener("click", () => {
        isWidgetExpanded = !isWidgetExpanded;
        card.style.display = isWidgetExpanded ? "flex" : "none";
        if (isWidgetExpanded) updateFloatingWidgetUI();
    });

    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        isWidgetExpanded = false;
        card.style.display = "none";
    });

    if (fullViewBtn) fullViewBtn.addEventListener("click", () => openMemoryViewerModal());
    if (refreshLastBtn) refreshLastBtn.addEventListener("click", async () => {
        const ctx = getSTContext();
        const chat = ctx.chat || [];
        if (chat.length > 0) await processSingleAiTurn(chat.length - 1, true);
    });

    // 支持自由拖拽悬浮窗
    makeDraggable(widget, pill);
    updateFloatingWidgetUI();
}

function makeDraggable(element, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    let isDragging = false;

    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        if (e.target.closest("#tiandao_widget_close_btn")) return;
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
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
        element.style.right = "auto";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }
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
    const body = document.getElementById("tiandao_widget_body");
    const summaryInfo = document.getElementById("tiandao_widget_summary_info");

    const l0Count = (memoryData.levels?.[0] || []).length;
    const l1Count = (memoryData.levels?.[1] || []).length;
    const l2Count = (memoryData.levels?.[2] || []).length;

    if (badge) {
        const lastFloor = memoryData.lastProcessedMessageId >= 0 ? `第${memoryData.lastProcessedMessageId}楼` : "未开始";
        badge.textContent = lastFloor;
    }

    if (summaryInfo) {
        summaryInfo.textContent = `L0(${l0Count}) L1(${l1Count}) L2(${l2Count}) | 池:${memoryData.archivePool?.length || 0}`;
    }

    if (!body) return;

    const wearHtml = Object.entries(ledger.characterWear || {})
        .map(([k, v]) => `<div><b>${k}</b>: ${v}</div>`)
        .join("") || "暂无记录";

    const removedHtml = (ledger.removedItemsLock || []).length > 0
        ? ledger.removedItemsLock.map(x => `<div style="color: #fca5a5;">⚠️ ${x}</div>`).join("")
        : "<div style='opacity:0.6;'>无摘除/脱下饰品</div>";

    const propHtml = (ledger.inventoryAndProps || []).length > 0
        ? ledger.inventoryAndProps.map(x => `<div>📦 ${x}</div>`).join("")
        : "<div style='opacity:0.6;'>无重要道具</div>";

    const todoHtml = (ledger.todosAndPromises || []).length > 0
        ? ledger.todosAndPromises.map(x => `<div>📌 ${x}</div>`).join("")
        : "<div style='opacity:0.6;'>暂无待办约定</div>";

    body.innerHTML = `
        <div class="tiandao-card-block">
            <div class="tiandao-block-title"><i class="fa-solid fa-clock"></i> 时空地点</div>
            <div class="tiandao-block-content" style="color:#f3d48d;">${ledger.timeAndPlace || "未知"}</div>
        </div>
        <div class="tiandao-card-block">
            <div class="tiandao-block-title"><i class="fa-solid fa-shirt"></i> 当前人物穿戴</div>
            <div class="tiandao-block-content">${wearHtml}</div>
        </div>
        <div class="tiandao-card-block" style="border-color: rgba(248, 113, 113, 0.25);">
            <div class="tiandao-block-title" style="color: #fca5a5;"><i class="fa-solid fa-lock"></i> 已摘除饰品锁 (防初始回滚)</div>
            <div class="tiandao-block-content">${removedHtml}</div>
        </div>
        <div class="tiandao-card-block">
            <div class="tiandao-block-title"><i class="fa-solid fa-box"></i> 关键物品与随身道具</div>
            <div class="tiandao-block-content">${propHtml}</div>
        </div>
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
    const previewPrompt = buildInjectedMemoryPrompt(memoryData, []);

    const html = `
    <div class="tiandao-modal-container">
        <h3 style="margin-top:0; color:#e0c280;">🌌 天道·溯微 当前注入预览与状态账本编辑</h3>
        <p style="font-size:0.85em; opacity:0.85; margin-bottom:8px;">
            下方展示当前实时注入给主模型的提示词预览，以及可手动修改的底层 JSON 账本（已自动隐藏冗长的 Embedding 向量数据，修改饰品锁、衣着、待办或各级摘要后点击<b>保存修改</b>即可无损合并生效）：
        </p>
        <div class="tiandao-btn-row" style="margin-bottom:10px;">
            <div id="tiandao_export_json_btn" class="menu_button" style="width:auto; padding:4px 10px;">
                <i class="fa-solid fa-file-export"></i> 导出记忆备份 (.json)
            </div>
            <label class="menu_button" style="width:auto; padding:4px 10px; cursor:pointer; margin:0;">
                <i class="fa-solid fa-file-import"></i> 导入记忆备份
                <input id="tiandao_import_json_input" type="file" accept=".json" style="display:none;" />
            </label>
        </div>
        <div style="margin-bottom:10px;">
            <b>【当前实际注入上下文预览】：</b>
            <textarea readonly style="min-height:170px; opacity:0.9;">${previewPrompt.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>
        </div>
        <div>
            <b>【底层记忆树与状态账本数据 (可直接编辑保存)】：</b>
            <textarea id="tiandao_json_editor" style="min-height:260px;">${jsonPretty.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>
        </div>
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
                    a.download = `tiandao_memory_${ctx.name2 || "chat"}_${Date.now()}.json`;
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
    bindCheck("tiandao_show_widget", "showFloatingWidget", () => updateFloatingWidgetUI());

    bindCheck("tiandao_auto_hide", "autoHideOldMessages", (checked) => {
        const count = syncHiddenMessagesState(!checked);
        if (!checked) {
            updateStatusBar(`👁️ 已关闭自动隐藏，恢复显示 ${count} 层旧楼层原文`);
        } else {
            updateStatusBar(`🙈 已开启原文楼层裁剪：仅发送最近 ${settings.keepRecentMessagesCount} 层原文`);
        }
    });
    bindInput("tiandao_keep_recent", "keepRecentMessagesCount", true, (val) => {
        syncHiddenMessagesState();
        if (settings.autoHideOldMessages) {
            updateStatusBar(`📏 已更新原文保留层数：当前仅发送最近 ${val} 层原文`);
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
            if (nextStart >= chat.length) return updateStatusBar("✅ 所有历史楼层均已在记忆树中。");
            if (!confirm(`确定要从第 ${nextStart} 楼开始扫描存量历史消息？`)) return;
            isBackfilling = true;
            abortBackfillFlag = false;
            backfillBtn.innerHTML = `<i class="fa-solid fa-stop"></i> 暂停历史回溯扫描`;
            try {
                const userName = ctx.name1 || "User";
                const charName = ctx.name2 || "Character";
                await backfillExistingChatHistory(settings, memoryData, chat, userName, charName, {
                    onProgress: (cur, total, floorRange) => updateStatusBar(`⏳ 扫描旧历史 (${cur}/${total}) · 第 ${floorRange} 楼...`),
                    onChunkSaved: async () => { await saveChatMemory(); await refreshPromptInjection(); },
                    shouldAbort: () => abortBackfillFlag,
                });
                syncHiddenMessagesState();
                updateStatusBar(`✅ 存量历史扫描构建完成！`);
            } catch (e) { updateStatusBar(`❌ 历史回溯中断: ${e.message}`, true); }
            finally { isBackfilling = false; backfillBtn.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> 一键扫描旧历史构建记忆树`; }
        });

    const restoreHiddenBtn = document.getElementById("tiandao_restore_hidden_btn");
    if (restoreHiddenBtn) restoreHiddenBtn.addEventListener("click", () => {
            syncHiddenMessagesState(true);
            settings.autoHideOldMessages = false;
            document.getElementById("tiandao_auto_hide").checked = false;
            saveSettings();
            updateStatusBar(`👁️ 已恢复显示所有历史楼层原文。`);
        });

    const clearBtn = document.getElementById("tiandao_clear_memory_btn");
    if (clearBtn) clearBtn.addEventListener("click", async () => {
            if (!confirm("确定要清空当前聊天存档的所有天道记忆树与状态账本吗？")) return;
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
        const scriptUrl = import.meta.url;
        const basePath = scriptUrl.substring(0, scriptUrl.lastIndexOf("/"));
        const res = await fetch(`${basePath}/settings.html`);
        if (res.ok) {
            const html = await res.text();
            const container = document.getElementById("extensions_settings2") || document.getElementById("extensions_settings");
            if (container) {
                container.insertAdjacentHTML("beforeend", html);
                bindSettingsUI();
            }
        }
        
        // 初始化悬浮窗
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
                    if (rollbackMemoryFromFloor(memoryData, chat.length)) { await saveChatMemory(); await refreshPromptInjection(); }
                }
                syncHiddenMessagesState(); renderRecentTurnsList(); updateFloatingWidgetUI();
            });
            if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, async (idx) => {
                const memoryData = getChatMemory();
                if (memoryData.lastProcessedMessageId >= idx) {
                    rollbackMemoryFromFloor(memoryData, idx);
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
                    rollbackMemoryFromFloor(memoryData, startFloor);
                    await saveChatMemory();
                    await refreshPromptInjection();
                    renderRecentTurnsList();
                    updateFloatingWidgetUI();
                }
            });
        }
        console.log("[Tiandao Memory Engine] v1.4.0 (悬浮窗看板 + 白名单标签抓取) 加载完毕！");
    } catch (err) { console.error("[Tiandao Memory Engine] 初始化异常:", err); }
})();
