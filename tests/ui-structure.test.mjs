import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const indexSource = readFileSync(join(root, "index.js"), "utf8");
const engineSource = readFileSync(join(root, "memory-engine.js"), "utf8");
const styleSource = readFileSync(join(root, "style.css"), "utf8");
const historySource = readFileSync(join(root, "history-builder.js"), "utf8");
const backupSource = readFileSync(join(root, "memory-backup.js"), "utf8");

test("dashboard is focused on story state while diagnostics have their own tab", () => {
    const dashboardStart = indexSource.indexOf('id="tiandao_tab_ledger_content"');
    const storyStart = indexSource.indexOf('id="tiandao_tab_story_content"', dashboardStart);
    const debugStart = indexSource.indexOf('id="tiandao_tab_debug_content"', storyStart);
    const settingsStart = indexSource.indexOf('id="tiandao_tab_settings_content"', debugStart);
    const dashboard = indexSource.slice(dashboardStart, storyStart);
    const debug = indexSource.slice(debugStart, settingsStart);
    assert.match(indexSource, /id="tiandao_tab_debug_btn"[^>]*aria-controls="tiandao_tab_debug_content"/);
    assert.doesNotMatch(dashboard, /tiandao_injection_preview|tiandao_runtime_stats|tiandao_debug_ledger_freshness|tiandao_widget_summary_info/);
    for (const id of ["tiandao_injection_preview", "tiandao_runtime_stats", "tiandao_debug_ledger_freshness", "tiandao_widget_summary_info"]) {
        assert.ok(debug.includes(`id="${id}"`), `${id} belongs to the debug tab`);
    }
    assert.match(indexSource, /id="tiandao_story_scope"[^>]*aria-label="记忆树范围"[\s\S]*?<option value="active">当前记忆树<\/option>/);
    assert.match(indexSource, /id="tiandao_injection_preview"/);
});

test("main navigation has four compact, accessible tabs in one row", () => {
    for (const id of ["tiandao_tab_ledger_btn", "tiandao_tab_story_btn", "tiandao_tab_debug_btn", "tiandao_tab_settings_btn"]) {
        assert.match(indexSource, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`));
    }
    assert.match(styleSource, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
});

test("story browsing controls are grouped separately from batch operations", () => {
    const storyStart = indexSource.indexOf('id="tiandao_tab_story_content"');
    const debugStart = indexSource.indexOf('id="tiandao_tab_debug_content"', storyStart);
    const story = indexSource.slice(storyStart, debugStart);
    assert.ok(story.indexOf("tiandao-story-filter-bar") < story.indexOf("tiandao-story-operations"));
    assert.match(story, /<details class="tiandao-story-operations">[\s\S]*?id="tiandao_story_range_from"[\s\S]*?id="tiandao_story_range_mode"[\s\S]*?id="tiandao_story_range_btn"[\s\S]*?id="tiandao_story_rebuild_all_btn"/);
    assert.match(styleSource, /\.tiandao-story-filter-controls\s*\{/);
    assert.match(styleSource, /\.tiandao-story-operations\s*\{/);
});

test("widget no longer renders hardcoded model shortcut chips", () => {
    assert.doesNotMatch(indexSource, /data-model="/);
    assert.doesNotMatch(indexSource, /tiandao-quick-chips/);
    assert.match(indexSource, /id="tiandao_fetch_models_btn"/);
});

test("tag inputs stay visually empty and custom strip tags have no defaults", () => {
    assert.match(indexSource, /id="tiandao_target_tags"[^>]*placeholder=""/);
    assert.match(indexSource, /id="tiandao_strip_tags"[^>]*placeholder=""/);
    assert.doesNotMatch(indexSource, /默认留空|默认内置 thinking/);
});

test("tag fields document comma, Chinese comma and whitespace separators", () => {
    assert.match(indexSource, /中英文逗号或空格分隔；按顺序尝试/);
    assert.match(indexSource, /中英文逗号或空格分隔；匹配标签块会从正文移除/);
});

test("status bar starts hidden and contains transient status logic", () => {
    assert.match(indexSource, /id="tiandao_status_bar"[^>]*style="display:none;"/);
    assert.match(indexSource, /statusBarHideTimer = setTimeout/);
});

test("summary progress is a separate persistent task panel with stop and progress", () => {
    assert.match(indexSource, /id="tiandao_summary_progress"[^>]*style="display:none;"/);
    assert.match(indexSource, /id="tiandao_summary_progress_counter"/);
    assert.match(indexSource, /id="tiandao_summary_progress_bar"/);
    assert.match(indexSource, /id="tiandao_summary_progress_stop"/);
    assert.match(indexSource, /function beginSummaryTask\(/);
    assert.match(indexSource, /function requestSummaryTaskStop\(/);
    assert.match(indexSource, /function requestSummaryTaskStop\(\) \{[\s\S]{0,260}summaryEpoch\+\+;/);
    assert.match(indexSource, /task\.controller\.abort\(\)/);
    assert.match(indexSource, /finishSummaryTask\(task\)/);
    assert.match(styleSource, /\.tiandao-summary-progress\s*\{/);
    assert.match(styleSource, /\.tiandao-summary-progress-bar\s*\{/);
});

test("editing or swiping archived rounds restores hidden raw context immediately", () => {
    assert.match(
        indexSource,
        /eventTypes\.MESSAGE_EDITED[\s\S]{0,1200}rollbackMemoryFromMessageIndex\(memoryData, idx, \{ skipNormalize: true \}\);[\s\S]{0,500}syncHiddenMessagesState\(\)/,
    );
    assert.match(
        indexSource,
        /eventTypes\.MESSAGE_SWIPED[\s\S]{0,1000}rollbackMemoryFromMessageIndex\(memoryData, startFloor, \{ skipNormalize: true \}\);[\s\S]{0,500}syncHiddenMessagesState\(\)/,
    );
});

test("existing-swipe changes get a deferred after_reply repair that generation can cancel", () => {
    assert.match(indexSource, /function scheduleAfterReplySwipeRepair\(chatKey\)/);
    assert.match(indexSource, /label: "补总结当前 swipe"/);
    assert.match(indexSource, /eventTypes\.GENERATION_STARTED[\s\S]{0,260}clearSwipeRepairTimer\(\)/);
    assert.match(indexSource, /eventTypes\.CHARACTER_MESSAGE_RENDERED[\s\S]{0,260}clearSwipeRepairTimer\(\)/);
});

test("backfill and story rebuild pass cancellation signals into summary work", () => {
    assert.match(indexSource, /backfillExistingChatHistory\([\s\S]{0,2200}shouldCommitTurn:[\s\S]{0,160}signal,/);
    assert.match(indexSource, /runStoryResummarize[\s\S]{0,2600}acquireSummaryTask/);
    assert.match(indexSource, /rebuildMemoryHierarchy\([\s\S]{0,400}\{ signal \}/);
    assert.match(indexSource, /resummarizeRoundInPlace\([\s\S]{0,500}signal/);
    assert.match(indexSource, /isSummaryTaskCancelled\(task\)/);
});

test("story range exposes fill, view and rebuild modes plus recovery entry", () => {
    assert.match(indexSource, /id="tiandao_story_range_from"/);
    assert.match(indexSource, /id="tiandao_story_range_to"/);
    assert.match(indexSource, /id="tiandao_story_range_mode"[\s\S]*?value="fill"/);
    assert.match(indexSource, /value="merge_l0">手动合 L0<\/option>/);
    assert.match(indexSource, /value="view"/);
    assert.match(indexSource, /value="rebuild"/);
    assert.match(indexSource, /id="tiandao_story_error_box"/);
    assert.match(indexSource, /id="tiandao_story_recover_btn"/);
    assert.match(styleSource, /\.tiandao-story-error-box/);
    assert.match(styleSource, /\.tiandao-story-range-mode/);
});

test("API controls expose retry and JSON mode without an output token cap", () => {
    assert.match(indexSource, /id="tiandao_summary_retry"/);
    assert.match(indexSource, /id="tiandao_use_json_mode"/);
    assert.match(indexSource, /id="tiandao_request_timeout"/);
    assert.match(indexSource, /bindInput\("tiandao_request_timeout", "requestTimeoutSeconds", true\)/);
    assert.match(indexSource, /id="tiandao_stream_mode"/);
    assert.match(indexSource, /bindInput\("tiandao_stream_mode", "streamMode"\)/);
    assert.match(engineSource, /requestTimeoutSeconds:\s*""/);
    assert.match(engineSource, /streamMode:\s*"non_stream"/);
    assert.match(engineSource, /resolveLlmRequestTimeoutMs/);
    assert.match(engineSource, /readStreamingChatCompletion/);
    assert.doesNotMatch(indexSource, /id="tiandao_max_tokens"/);
    assert.doesNotMatch(engineSource, /max_tokens:\s*numOr/);
});

test("after_reply path fills older gaps before archiving the new reply", () => {
    assert.match(indexSource, /function enqueuePendingAiTurns/);
    assert.match(indexSource, /summarizeTiming === "after_reply"[\s\S]{0,500}enqueuePendingAiTurns\(chat, msgId/);
});

test("character cards expose away state and alias styles", () => {
    assert.match(indexSource, /tiandao-char-away/);
    assert.match(indexSource, /tiandao-char-alias/);
    assert.match(indexSource, /tiandao-char-avatar/);
    assert.match(styleSource, /\.tiandao-char-card\.tiandao-char-away/);
});

test("character private views are escaped and injected as isolated data", () => {
    assert.match(indexSource, /escapeHTML\(info\.viewTarget\)/);
    assert.match(indexSource, /escapeHTML\(info\.viewSeenRound\)/);
    assert.match(engineSource, /viewTargetVisible/);
    assert.match(engineSource, /仅此角色知晓，严禁外传/);
});

test("parse failure logs no raw story excerpt", () => {
    assert.doesNotMatch(engineSource, /JSON parse failed:.*slice\(0, 300\)/);
    assert.match(engineSource, /JSON parse failed/);
});

test("widget exposes porcelain and journal themes with porcelain as default", () => {
    assert.match(engineSource, /widgetTheme: "porcelain"/);
    assert.match(indexSource, /value="porcelain">瓷白精修/);
    assert.match(indexSource, /value="journal">书页叙事/);
    assert.doesNotMatch(indexSource, /value="matcha"/);
    assert.match(styleSource, /:root\[data-sw-theme="journal"\]/);
});

test("expanded widget hides the pill and uses the card as its drag surface", () => {
    assert.match(indexSource, /pill\.style\.display = "none"/);
    assert.match(indexSource, /pill\.style\.display = "inline-flex"/);
    assert.match(indexSource, /tiandao-widget-expanded/);
    assert.match(indexSource, /handle\.closest\("\.tiandao-widget-card"\)/);
    assert.match(styleSource, /\.tiandao-widget-expanded \.tiandao-widget-card/);
});

test("floating widget opens toward the side with enough viewport space", () => {
    assert.match(indexSource, /const spaceRight = Math\.max\(0, vw - rect\.left - 10\)/);
    assert.match(indexSource, /const spaceLeft = Math\.max\(0, rect\.right - 10\)/);
    assert.match(indexSource, /const openRightward = spaceRight >= desiredWidth/);
    assert.match(indexSource, /const horizontalShift = clampedLeft - proposedLeft/);
    assert.doesNotMatch(indexSource, /const openRightward = rect\.left < desiredWidth/);
});

test("mobile expanded widget is centered in the viewport and cannot be dragged offscreen", () => {
    assert.match(indexSource, /const MOBILE_WIDGET_MEDIA = "\(max-width: 600px\)"/);
    assert.match(indexSource, /canDrag: \(\) => !\(isWidgetExpanded && isMobileWidgetViewport\(\)\)/);
    assert.match(indexSource, /const maxLeft = Math\.max\(minLeft, window\.innerWidth - width - minLeft\)/);
    assert.match(indexSource, /const maxTop = Math\.max\(minTop, window\.innerHeight - height - minTop\)/);
    assert.match(indexSource, /window\.visualViewport\?\.addEventListener\("resize", repositionFloatingWidget\)/);
    assert.match(styleSource, /#tiandao_floating_widget\.tiandao-widget-expanded\s*\{[\s\S]*?inset:\s*auto !important;[\s\S]*?top:\s*0 !important;[\s\S]*?left:\s*0 !important;[\s\S]*?width:\s*100vw !important;[\s\S]*?height:\s*100dvh !important;[\s\S]*?display:\s*flex !important;[\s\S]*?align-items:\s*center !important;[\s\S]*?justify-content:\s*center !important;/);
    assert.match(styleSource, /#tiandao_floating_widget\.tiandao-widget-expanded \.tiandao-widget-card\s*\{[\s\S]*?position:\s*relative !important;[\s\S]*?inset:\s*auto !important;[\s\S]*?height:\s*min\(610px, calc\(100dvh - 24px\)\) !important;/);
});

test("appearance settings are isolated on their own page and persist neutral defaults", () => {
    assert.match(engineSource, /widgetFontScale:\s*100/);
    assert.match(engineSource, /widgetFontFamily:\s*"inherit"/);
    assert.match(indexSource, /data-page="appearance"/);
    assert.match(indexSource, /id="tiandao_widget_theme"/);
    assert.match(indexSource, /id="tiandao_font_family"/);
    assert.match(indexSource, /id="tiandao_font_scale"/);
    assert.match(indexSource, /id="tiandao_reset_appearance_btn"/);
    assert.match(indexSource, /function applyWidgetAppearance\(\)/);
    assert.match(styleSource, /--sw-font-scale/);
    assert.match(styleSource, /:root\[data-sw-font="sans"\]/);
});

test("history position is fixed and memory has no token-budget trimming", () => {
    assert.doesNotMatch(indexSource, /id="tiandao_max_level"/);
    assert.doesNotMatch(indexSource, /id="tiandao_memory_budget"/);
    assert.match(engineSource, /const MAX_MEMORY_LEVEL = 3/);
    assert.doesNotMatch(engineSource, /tokenBudget = 5000|truncatePromptToBudget|fittedTimeline/);
    assert.doesNotMatch(indexSource, /id="tiandao_inject_(?:pos|depth|role)"/);
    assert.match(engineSource, /function capTopLevelEntries\(/);
});

test("raw recent rounds default to five and recent L0 summaries are not duplicated", () => {
    assert.match(engineSource, /keepRecentRoundsCount:\s*5/);
    assert.match(indexSource, /numOr\(settings\.keepRecentRoundsCount, 5\)/);
    assert.match(engineSource, /recentRawRounds/);
    assert.match(engineSource, /rawWindowStart/);
});

test("long-chat performance paths avoid repeated full work", () => {
    assert.match(engineSource, /saveEvery = 5/);
    assert.match(engineSource, /\(i \+ 1\) % batchSaveSize === 0/);
    assert.match(engineSource, /memorySearchTokenCache/);
    assert.match(indexSource, /const storyVisible = document\.getElementById\("tiandao_tab_story_content"\)/);
    assert.match(indexSource, /if \(storyVisible\) \{/);
    assert.match(indexSource, /label: "重建高层记忆"/);
    assert.match(indexSource, /rebuildMemoryHierarchy\([\s\S]{0,500}\{ signal \}/);
    assert.match(indexSource, /const roundIndexCache = new WeakMap\(\)/);
    assert.match(indexSource, /function getCachedRoundIndex\(chat, includeNativeHidden = false\)/);
    assert.match(indexSource, /requestAnimationFrame\(callback\)/);
    assert.match(indexSource, /ledgerRenderKey !== lastLedgerRenderKey/);
});

test("story summary edits rebuild atomically and preserve old high-level summaries on failure", () => {
    assert.match(indexSource, /function startHierarchyRebuildTransaction\(/);
    assert.match(indexSource, /async function rebuildHierarchyLevelsFromL0\(/);
    assert.match(indexSource, /Object\.assign\(draft, rebuiltLevels\);[\s\S]{0,220}await saveReplacementMemory\(checkpoint, draft\)/);
    assert.match(indexSource, /本次修改未保存/);
    assert.match(indexSource, /pendingHierarchyEdits/);
    assert.match(indexSource, /重建后的层级无法定位所选阶段/);
    assert.doesNotMatch(
        indexSource,
        /if \(Number\(lvl\) === 0\) \{[\s\S]{0,500}memoryData\.levels = \{ 0: l0 \};/,
    );
});

test("manual ledger edits are stamped into the latest L0 state storage", () => {
    assert.match(indexSource, /captureLatestL0StateStorage\(memoryData\)/);
    assert.match(indexSource, /stampLatestL0StateSnapshot\(memoryData\)/);
    assert.match(indexSource, /restoreLatestL0StateStorage\(stateStorageCapture\)/);
});

test("model lists normalize full endpoint URLs and the launcher uses native keyboard activation", () => {
    assert.match(indexSource, /function getModelsEndpoint\(baseUrl\)/);
    assert.match(indexSource, /normalized\.endsWith\("\/chat\/completions"\)/);
    assert.match(indexSource, /<button type="button" id="tiandao_widget_pill"[^>]*aria-haspopup="dialog"/);
    assert.doesNotMatch(indexSource, /pill\.addEventListener\("keydown"/);
    assert.match(indexSource, /pill\.addEventListener\("click", \(\) => setWidgetExpanded\(true\)\)/);
    assert.match(indexSource, /interactive && interactive !== handle/);
});

test("story timeline paginates twenty entries with older and newer controls", () => {
    assert.match(indexSource, /const STORY_PAGE_SIZE = 20/);
    assert.match(indexSource, /Math\.ceil\(displayEntries\.length \/ STORY_PAGE_SIZE\)/);
    assert.match(indexSource, /data-story-page="older"/);
    assert.match(indexSource, /data-story-page="newer"/);
    assert.match(indexSource, /storySortOrder === "desc"[\s\S]{0,180}storyPage \+= pageKey === "older" \? 1 : -1/);
    assert.match(styleSource, /\.tiandao-story-pager\s*\{/);
    assert.match(styleSource, /\.tiandao-story-page-btn\s*\{/);
});

test("history preserves early coverage without a budget trim loop", () => {
    assert.match(historySource, /selectHistoricalEntries/);
    assert.doesNotMatch(engineSource, /while \(estimatePromptTokens\(prompt\)/);
    assert.match(indexSource, /自动模式满 N 轮归档；手动模式需在剧情页选择轮次合并/);
});

test("prompt injection keeps chronological order independent of the timeline display sort", () => {
    assert.match(engineSource, /注入顺序固定为剧情内“由远及近”/);
    assert.match(engineSource, /const orderedTimeline = safeTimeline[\s\S]{0,200}orderStart/);
    assert.match(indexSource, /const displayEntries = storySortOrder === "desc"/);
});

test("story timeline defaults to descending order and exposes ascending order", () => {
    assert.match(indexSource, /let storySortOrder = "desc"/);
    assert.match(indexSource, /id="tiandao_story_sort_order"[\s\S]{0,220}<option value="desc" selected>倒序<\/option>[\s\S]{0,80}<option value="asc">正序<\/option>/);
    assert.match(indexSource, /const displayEntries = storySortOrder === "desc"[\s\S]{0,60}entries\.slice\(\)\.reverse\(\)/);
    assert.match(indexSource, /tiandao-pagecap">剧情时间线<\/span>/);
    assert.match(styleSource, /\.tiandao-story-sort-select\s*\{/);
});

test("pending automatic summaries queue instead of being dropped", () => {
    assert.match(indexSource, /function enqueuePendingAiTurns\(chat, upToIndex, options = \{\}\)[\s\S]{0,2600}enqueueBackgroundSummary\(async \(\) => \{[\s\S]{0,300}acquireSummaryTask/);
    assert.doesNotMatch(indexSource, /function enqueuePendingAiTurns\(chat, upToIndex, options = \{\}\)[\s\S]{0,1000}if \(activeSummaryTask\) \{[\s\S]{0,200}return null;/);
});

test("welcome screen cannot report pending rounds or start automatic summaries", () => {
    assert.match(indexSource, /function getPendingBacklog\(chat, memoryData\) \{\s*if \(!isActiveChatContext\(getSTContext\(\)\)\) return \[\];/);
    assert.match(indexSource, /const activeChat = isActiveChatContext\(getSTContext\(\)\);[\s\S]{0,220}const error = activeChat \? memoryData\.lastSummaryError : null;/);
    assert.match(indexSource, /const ctx = options\.ctx \|\| getSTContext\(\);\s*if \(!isActiveChatContext\(ctx\)\) return false;/);
    assert.match(indexSource, /function enqueuePendingAiTurns[\s\S]{0,140}if \(!isActiveChatContext\(ctx\)\) return null;/);
});

test("legacy state snapshot migration is persisted after load", () => {
    assert.match(indexSource, /previousStateStorageVersion = metadata\.tiandao_memory\.stateStorageVersion/);
    assert.match(indexSource, /previousStateStorageVersion !== memoryData\.stateStorageVersion[\s\S]{0,120}scheduleChatSave\(\)/);
});

test("story range groups its endpoints and wraps without shrinking interactive targets", () => {
    assert.match(indexSource, /class="tiandao-story-range-fields" role="group" aria-labelledby="tiandao_story_range_label"/);
    assert.match(indexSource, /class="tiandao-story-range-actions"/);
    assert.match(styleSource, /\.tiandao-story-range-bar\s*\{[^}]*display:\s*grid/);
    assert.match(styleSource, /\.tiandao-story-range-bar \.tiandao-input-sm\s*\{[^}]*min-height:\s*28px/);
    assert.match(styleSource, /\.tiandao-story-range-mode\s*,\s*\.tiandao-story-range-bar \.tiandao-btn-sm,[^}]*min-height:\s*32px/);
});

test("todo ledger uses checkboxes that save completion immediately", () => {
    assert.match(indexSource, /class="tiandao-todo-check" data-todo-id=/);
    assert.match(indexSource, /function updateTodoCompletion\(todoId, completed\)/);
    assert.match(indexSource, /todo\.completedBy = completed \? "player" : ""/);
    assert.match(indexSource, /refreshPromptInjection\("", \{ skipRetrieval: true \}\)/);
    assert.match(engineSource, /“询问某人……尚未回应”/);
    assert.match(engineSource, /pruneExpiredCompletedTodos\(/);
    assert.match(styleSource, /\.tiandao-todo-done \.tiandao-todo-text/);
});

test("widget card uses a fixed height instead of content-driven height", () => {
    assert.match(styleSource, /\.tiandao-widget-card[\s\S]{0,180}height:\s*min\(610px/);
    assert.match(indexSource, /card\.style\.height = fixedHeight \+ "px"/);
    assert.match(indexSource, /const fixedHeight = Math\.max\(200, Math\.min\(610, viewportCap/);
});

test("API settings expose saved profiles and keep profile keys out of local backup", () => {
    assert.match(engineSource, /apiProfiles:\s*\[\]/);
    assert.match(engineSource, /activeApiProfileId/);
    assert.match(indexSource, /id="tiandao_api_profile_select"/);
    assert.match(indexSource, /id="tiandao_api_profile_save_btn"/);
    assert.match(indexSource, /function saveCurrentApiProfile\(\)/);
    assert.match(indexSource, /API_PROFILE_FIELDS = \[[^\]]*requestTimeoutSeconds/);
    assert.match(indexSource, /API_PROFILE_FIELDS = \[[^\]]*streamMode/);
    assert.match(indexSource, /requestTimeoutSeconds: "tiandao_request_timeout"/);
    assert.match(indexSource, /streamMode: "tiandao_stream_mode"/);
    assert.match(indexSource, /delete safeProfile\.apiKey/);
});

test("story rebuild is bounded and exposes a full rebuild and per-entry action", () => {
    assert.doesNotMatch(indexSource, /重整范围及之后/);
    assert.match(indexSource, /<option value="rebuild">重新总结<\/option>/);
    assert.match(indexSource, /id="tiandao_story_rebuild_all_btn"/);
    assert.match(indexSource, /function rebuildAllStorySummaries\(\)/);
    assert.match(indexSource, /turn\.round >= fromRound && turn\.round <= toRound/);
    assert.match(indexSource, /tiandao-entry-resummarize-btn/);
    assert.match(indexSource, /function resummarizeStoryEntry\(lvl, idx, button = null\)/);
    assert.match(indexSource, /async function resummarizeRoundInPlace/);
});

test("footer no longer exposes the old rebuild-current-round shortcut", () => {
    assert.doesNotMatch(indexSource, /id="tiandao_widget_refresh_last_btn"/);
    assert.doesNotMatch(indexSource, />重整本轮<\/button>/);
});

test("legacy migration can explicitly include native hidden floors", () => {
    assert.match(engineSource, /includeNativeHidden:\s*false/);
    assert.match(indexSource, /id="tiandao_include_native_hidden"/);
    assert.match(indexSource, /bindCheck\("tiandao_include_native_hidden", "includeNativeHidden", \(\) =>/);
    assert.match(indexSource, /buildRoundMessageIndex\(chat, settings\.includeNativeHidden\)/);
    assert.match(indexSource, /轮次计算与总结包含酒馆原生隐藏楼层/);
    assert.match(indexSource, /切换后请重新扫描或重建/);
});

test("story range has an explicit settings binding", () => {
    assert.match(indexSource, /function resummarizeStoryRange\(\) \{\s*const ctx = getSTContext\(\);\s*const settings = getSettings\(\);/);
    assert.match(indexSource, /buildRoundMessageIndex\(chat, settings\.includeNativeHidden\)/);
});

test("summary and embedding toggles control accessible model lists without native datalist conflicts", () => {
    for (const prefix of ["tiandao_model", "tiandao_emb_model"]) {
        assert.match(indexSource, new RegExp(`id="${prefix}_toggle_btn"[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"[^>]*aria-controls="${prefix}_menu"`));
    }
    assert.match(indexSource, /menu\.setAttribute\("role", "listbox"\)/);
    assert.match(indexSource, /option\.setAttribute\("role", "option"\)/);
    assert.match(indexSource, /setFetchedModelNames\(names\)/);
    assert.match(indexSource, /手动输入模型名称/);
    assert.doesNotMatch(indexSource, /list="tiandao_(?:emb_)?model_datalist"/);
    assert.match(styleSource, /\.tiandao-model-menu\[hidden\]\s*\{\s*display:\s*none/);
    assert.match(styleSource, /\.tiandao-model-option\.selected\s*\{/);
});

test("chat changes reset story editing and abort stale summaries", () => {
    assert.match(indexSource, /if \(eventTypes\.CHAT_CHANGED\)[\s\S]{0,700}if \(activeSummaryTask\) requestSummaryTaskStop\(\)/);
    assert.match(indexSource, /if \(eventTypes\.CHAT_CHANGED\)[\s\S]{0,900}storyEditingKey = null;/);
    assert.match(indexSource, /if \(eventTypes\.CHAT_CHANGED\)[\s\S]{0,900}storyViewRange = null;/);
});

test("todo edits use the shared memory lock while the current chat is being summarized", () => {
    assert.match(indexSource, /const memoryBusy = activeSummaryChats\.has\(chatKey\)/);
    assert.match(indexSource, /\$\{memoryBusy \? "disabled" : ""\}/);
    const start = indexSource.indexOf("async function updateTodoCompletion(");
    const end = indexSource.indexOf("const memoryData = getChatMemory();", start);
    assert.ok(start >= 0 && end > start, "todo handler must exist before its memory mutation");
    assert.match(indexSource.slice(start, end), /if \(memoryOperationBusy\(\)\)\s*\{/);
    const lockStart = indexSource.indexOf("function memoryOperationBusy()");
    const lockEnd = indexSource.indexOf("function ", lockStart + 9);
    assert.match(indexSource.slice(lockStart, lockEnd), /activeSummaryChats\.size > 0/);
});

test("interrupted range rebuild invalidates contradictory high-level summaries", () => {
    assert.match(indexSource, /const working = clonePlainData\(before\)/);
    assert.match(indexSource, /invalidateDerivedSummariesInRange\(working, firstRound, lastRound\)/);
    assert.match(engineSource, /export function invalidateDerivedSummariesInRange/);
});

test("range fill explains prerequisite rounds before processing", () => {
    assert.match(indexSource, /const pendingThroughRange = collectMissingAiTurns\(/);
    assert.match(indexSource, /const prerequisiteCount = pendingThroughRange/);
    assert.match(indexSource, /将先补齐范围前 \$\{prerequisiteCount\} 轮前置缺口/);
    assert.match(indexSource, /补缺失\+前置/);
});

test("switching API profiles cancels pending lookups and clears stale model options", () => {
    assert.match(indexSource, /settings\.activeApiProfileId = profile\.id;\s*invalidateSummaryModelLookup\(\);/);
    assert.match(indexSource, /invalidateSummaryModelLookup = bindModelLookup\(/);
    const start = indexSource.indexOf("const invalidate = () =>");
    const end = indexSource.indexOf("const checkCredentials", start);
    assert.ok(start >= 0 && end > start, "model lookup invalidation must be defined");
    assert.match(indexSource.slice(start, end), /request\?\.abort\(\)/);
    assert.match(indexSource.slice(start, end), /applyNames\(\[\]\)/);
    assert.match(indexSource, /模型列表已清空，请重新拉取/);
});

test("todo save failure restores the previous completion state", () => {
    assert.match(indexSource, /const previousCompletion = \{/);
    assert.match(indexSource, /Object\.assign\(currentTodo, previousCompletion\)/);
    assert.match(indexSource, /reportSavedMemoryChange\(isActive, checkpoint, completed/);
    assert.match(indexSource, /但刷新注入失败/);
});

test("placeholder cleanup schedules a chat save", () => {
    assert.match(indexSource, /if \(cleanupPlaceholderCharacters\(memoryData, ctx\.name1 \|\| "", true\)\) \{\s*scheduleChatSave\(\);/);
});

test("memory import is size limited", () => {
    assert.match(backupSource, /MAX_IMPORT_FILE_BYTES = 20 \* 1024 \* 1024/);
    assert.match(backupSource, /MAX_MEMORY_ENTRIES = 50_000/);
    assert.match(indexSource, /file\.size > MAX_IMPORT_FILE_BYTES/);
    assert.match(indexSource, /超过 20MB/);
    assert.match(backupSource, /记忆条目超过/);
});

test("range resummarize passes precomputed round windows", () => {
    assert.match(indexSource, /precomputedTurn\?\.window/);
    assert.match(indexSource, /\.map\(\(\{ idx, round, msg, window \}\) => \(\{ idx, round, msg, window \}\)\)/);
    assert.match(indexSource, /group\.length === 1 \? group\[0\] : null/);
    assert.match(indexSource, /group\.length > 1 \? group : null/);
    assert.match(
        indexSource,
        /precomputedTurn\?\.msg[\s\S]{0,100}chat\[msgIdx\] === precomputedTurn\.msg/,
    );
});

test("character cards and their inventory lists are collapsed disclosures", () => {
    assert.match(indexSource, /const expandedCharacterCards = new Set\(\)/);
    assert.match(indexSource, /const expandedInventoryCards = new Set\(\)/);
    assert.match(indexSource, /data-char-toggle="\$\{escapeHTML\(name\)\}"/);
    assert.match(indexSource, /class="tiandao-char-body" \$\{characterExpanded \? "" : "hidden"\}/);
    assert.match(indexSource, /data-item-toggle="\$\{escapeHTML\(name\)\}"/);
    assert.match(indexSource, /class="tiandao-item-list" \$\{inventoryExpanded \? "" : "hidden"\}/);
    assert.match(styleSource, /\.tiandao-char-body\[hidden\][\s\S]{0,80}display:\s*none/);
    assert.match(styleSource, /\.tiandao-item-list\[hidden\][\s\S]{0,80}display:\s*none/);
});

test("ledger items can be deleted after confirmation and refresh injection", () => {
    assert.match(indexSource, /data-delete-item="\$\{kind\}"/);
    assert.match(indexSource, /class="tiandao-item-delete"/);
    assert.match(indexSource, /async function deleteLedgerItem\(characterName, itemKind, itemIndex, button = null\)/);
    assert.match(indexSource, /只会修改当前状态账本，不会改动历史剧情/);
    assert.match(indexSource, /currentInfo\[field\] = previousList/);
    assert.match(indexSource, /await refreshPromptInjection\("", \{ skipRetrieval: true \}\)/);
    assert.match(styleSource, /\.tiandao-item-delete:hover:not\(:disabled\)/);
});

test("model menus keep internal scrolling and move focus safely when dismissed", () => {
    assert.match(indexSource, /window\.addEventListener\("scroll", \(event\) => \{\s*const menu = activeModelMenu\?\.menu;\s*if \(menu && !menu\.contains\(event\.target\)\) dismissModelMenu\(\);/);
    assert.match(indexSource, /closeModelMenu\(opened\?\.menu\.contains\(document\.activeElement\) \? opened\.opener : null\)/);
    assert.match(styleSource, /\.tiandao-model-menu\s*\{[\s\S]{0,520}touch-action:\s*pan-y/);
    assert.match(styleSource, /-webkit-overflow-scrolling:\s*touch/);
    assert.match(styleSource, /\.tiandao-model-option\s*\{[^}]*flex:\s*0 0 auto/);
});

test("embedding models have a separate fetch action and embedding-only filter", () => {
    assert.match(engineSource, /embeddingModelFilterOnly:\s*true/);
    assert.match(indexSource, /id="tiandao_fetch_embedding_models_btn"/);
    assert.match(indexSource, /id="tiandao_emb_model_toggle_btn"/);
    assert.match(indexSource, /id="tiandao_emb_model_select"/);
    assert.match(indexSource, /function getSelectableEmbeddingModelNames\(\)/);
    assert.match(indexSource, /select\.hidden = visibleNames\.length === 0/);
    assert.match(indexSource, /id="tiandao_emb_filter_models"/);
    assert.match(indexSource, /function isEmbeddingModelName\(name\)/);
    assert.match(indexSource, /function getVisibleEmbeddingModelNames\(\)/);
    assert.match(indexSource, /bindCheck\("tiandao_emb_filter_models", "embeddingModelFilterOnly"/);
    assert.match(styleSource, /\.tiandao-emb-model-select\s*\{/);
});

test("editing an unmerged L0 leaves higher summaries untouched", () => {
    assert.match(indexSource, /const needsHierarchyRebuild = numericLevel > 0\s*\|\| isMemoryEntryCoveredByHigherLevels\(memoryData, item, 0\)/);
    assert.match(indexSource, /该范围尚未并入高层，L1～L3 未改动/);
});

test("L0 round count is editable as a single digit without live normalization", () => {
    assert.match(indexSource, /id="tiandao_l0_chunk" type="text" inputmode="numeric" pattern="\[0-9\]\*"/);
    assert.match(indexSource, /bindInput\("tiandao_l0_chunk", "l0RoundsPerSummary", true,[\s\S]{0,600}deferCallbackUntilCommit: true/);
    assert.match(indexSource, /options\.selectOnFocus[\s\S]{0,180}el\.select\?\.\(\)/);
    assert.match(indexSource, /L0 \$\{pendingBacklogCount\}\/\$\{l0Chunk\}/);
});

test("deleted summary rounds clear stale recovery errors and keep valid cursor state", () => {
    assert.match(indexSource, /clearedDeletedRoundError = Boolean/);
    assert.match(engineSource, /lastProcessedMessageId !== nextProcessedMessageId[\s\S]{0,180}changed = true/);
});

test("summary failure banner can be dismissed without deleting pending rounds", () => {
    assert.match(indexSource, /id="tiandao_story_dismiss_error_btn"/);
    assert.match(indexSource, /memoryData.lastSummaryError = null;[\s\S]{0,220}saveChatMemory()/);
    assert.match(indexSource, /未归档轮次仍保留/);
    assert.match(indexSource, /normalPartialBatch/);
});

test("L0 grouping has automatic and manual modes with a configurable round count", () => {
    assert.match(engineSource, /l0RoundsPerSummary:\s*1/);
    assert.match(engineSource, /l0MergeMode:\s*"auto"/);
    assert.match(engineSource, /export function resolveL0RoundsPerSummary\(/);
    assert.match(engineSource, /export function groupAiTurnsForL0\(/);
    assert.match(indexSource, /id="tiandao_l0_chunk"/);
    assert.match(indexSource, /id="tiandao_l0_merge_mode"/);
    assert.match(indexSource, /bindInput\("tiandao_l0_chunk", "l0RoundsPerSummary", true/);
    assert.match(indexSource, /bindInput\("tiandao_l0_merge_mode", "l0MergeMode"/);
    assert.match(indexSource, /settings\.l0MergeMode === "manual"/);
    assert.match(indexSource, /groupAiTurnsForL0\(\s*pending,\s*resolveL0RoundsPerSummary\(settings\),\s*!isManual/);
    assert.match(indexSource, /singleGroup: true/);
    assert.match(indexSource, /下一段自动计数会从第 \$\{toRound \+ 1\} 轮重新开始/);
    assert.match(indexSource, /连续轮次微摘要/);
});

test("message deletion reconciles surviving summaries instead of rolling back the whole archive", () => {
    assert.match(engineSource, /export function reconcileMemoryAfterMessageDeletion\(/);
    assert.match(engineSource, /remapRangeFromSurvivingL0/);
    assert.match(engineSource, /lastProcessedMessageId = Math\.max\(\.\.\.archivedEnds\)/);
    assert.match(indexSource, /eventTypes\.MESSAGE_DELETED[\s\S]{0,700}reconcileMemoryAfterMessageDeletion\(/);
    assert.match(indexSource, /const roundRange = startRound === roundNumber \? String\(roundNumber\)/);
    assert.doesNotMatch(
        indexSource,
        /eventTypes\.MESSAGE_DELETED[\s\S]{0,800}rollbackMemoryFromMessageIndex\(/,
    );
});

test("resummarize expands overlapping L0 and hidden raw rounds keep their summary", () => {
    assert.match(indexSource, /expandResummarizeRanges\(requestedRanges, existingL0\)/);
    assert.match(indexSource, /replaceL0EntryInMemory\(memoryData, target, replacement\)/);
    assert.match(historySource, /function selectHistoricalEntries/);
    assert.match(historySource, /end > limit/);
    assert.match(historySource, /rawStart = eligibleTurns\[pastRound\]\.window\.startMessageId/);
    assert.match(indexSource, /eventTypes\.MESSAGE_SWIPED[\s\S]{0,1800}scheduleAfterReplySwipeRepair\(getChatKey\(\)\)/);
    // 摘要不再携带向量；手工编辑摘要文本只更新文本本身，不得再出现嵌入清理残留。
    assert.doesNotMatch(indexSource, /clearEntryEmbedding/);
    assert.match(indexSource, /for \(const entry of new Set\(\[draftItem, archiveEntry\]\)\)/);
});

test("manual backfill ignores stale summaries after chat mutations", () => {
    assert.match(indexSource, /const backfillEpoch = summaryEpoch;/);
    assert.match(
        indexSource,
        /shouldAbort: \(\) => abortBackfillFlag[\s\S]{0,220}backfillEpoch !== summaryEpoch/,
    );
    assert.match(
        indexSource,
        /shouldCommitTurn: \(\) => isCurrentChat\(backfillChatKey\)\s*&& backfillEpoch === summaryEpoch/,
    );
});

test("legacy settings backups strip nested API keys before restore", () => {
    assert.match(indexSource, /function sanitizeSettingsBackup\(backup\)/);
    assert.match(indexSource, /safeProfile\.apiKey !== undefined[\s\S]{0,120}delete safeProfile\.apiKey/);
    assert.match(indexSource, /const sanitized = sanitizeSettingsBackup\(backup\)/);
    assert.match(indexSource, /if \(sanitized\.redacted\)/);
});

test("metadata saves have concrete fallbacks and failed destructive writes roll back", () => {
    assert.match(indexSource, /async function saveChatMemory\(\)[\s\S]{0,500}ctx\.saveChat/);
    assert.match(indexSource, /saveAndVerifyChatMetadata\(ctx, expectedFields, savers, globalThis\.fetch, isCurrent\)/);
    assert.doesNotMatch(indexSource, /savers\.push\(\(\) => ctx\.saveMetadataDebounced\(\)\)/);
    assert.match(indexSource, /const result = await saveAndVerifyChatMetadata/);
    assert.match(indexSource, /async function saveReplacementMemory\(checkpoint, memory\)[\s\S]{0,600}metadata\.tiandao_memory = previousMemory/);
    assert.match(indexSource, /async function saveCheckpointedEdit\(checkpoint, apply, rollback\)[\s\S]{0,350}checkpoint\.rollback\(\)/);
    assert.match(indexSource, /await saveReplacementMemory\(checkpoint, createEmptyMemoryData\(\)\)/);
    assert.match(indexSource, /await saveReplacementMemory\(checkpoint, imported\.memory\)/);
});

test("chat mutations abort in-flight summaries instead of wasting the request", () => {
    assert.match(indexSource, /function invalidateActiveSummaryWork\(reason = "聊天内容已变化"\)/);
    assert.match(
        indexSource,
        /function invalidateActiveSummaryWork\([\s\S]{0,420}task\.controller\.abort\(\)/,
    );
    assert.match(indexSource, /eventTypes\.MESSAGE_DELETED[\s\S]{0,700}invalidateActiveSummaryWork\("消息已删除"\)/);
    assert.match(indexSource, /eventTypes\.MESSAGE_EDITED[\s\S]{0,400}invalidateActiveSummaryWork\("消息已编辑"\)/);
    assert.match(indexSource, /eventTypes\.MESSAGE_SWIPED[\s\S]{0,400}invalidateActiveSummaryWork\("已切换 Swipe"\)/);
});

test("long-chat hot paths reuse normalized memory and cap raw scanning", () => {
    assert.match(indexSource, /cleanupPlaceholderCharacters\(memoryData, ctx\.name1 \|\| "", true\)/);
    assert.match(indexSource, /retrieveRelevantArchivedMemories\([\s\S]{0,250}\{ skipNormalize: true,/);
    assert.match(indexSource, /pruneStaleCharacters\([\s\S]{0,180}skipNormalize: true/);
    assert.match(engineSource, /messageTextHashCache/);
    assert.match(indexSource, /currentMemoryReference\(\) === memoryData/);
    assert.match(indexSource, /renderStoryTimeline\(memoryData\)/);
    assert.match(engineSource, /function cloneMemoryForUpdate\(memoryData, skipNormalize = false\)/);
    assert.match(engineSource, /cloneMemoryForUpdate\(memoryData, true\)/);
    assert.match(engineSource, /memoryAlreadyNormalized: true/);
    assert.match(indexSource, /rollbackMemoryFromMessageIndex\(memoryData, idx, \{ skipNormalize: true \}\)/);
    assert.match(engineSource, /rollbackMemoryFromMessageIndex\(working, startMessageId, \{ skipNormalize: true \}\)/);
    assert.match(indexSource, /getSettings\(\)\.includeNativeHidden,\s*\{ skipNormalize: true \}/);
});

test('ledger render cache includes freshness even when stored state is unchanged', () => {
    assert.match(indexSource, /const ledgerFreshness = getLedgerFreshness\(memoryData\)/);
    assert.match(indexSource, /ledgerRenderKey = [^\n]*JSON\.stringify\(ledgerFreshness\)/);
    assert.match(indexSource, /bodyInner\.innerHTML = buildLedgerHtml\(memoryData, ledgerFreshness, \{ includeFreshness: false \}\)/);
    assert.match(styleSource, /\.tiandao-ledger-freshness\.is-stale/);
    assert.match(indexSource, /eventTypes\.USER_MESSAGE_RENDERED, \(\) => \{[\s\S]{0,240}updateFloatingWidgetUI\(\)/);
});

test('state update modes are selectable, preserve legacy defaults and disclose paid work', () => {
    assert.match(indexSource, /id="tiandao_state_update_mode"/);
    assert.match(indexSource, /option value="with_summary"/);
    assert.match(indexSource, /option value="independent"/);
    assert.match(indexSource, /option value="main_response"/);
    assert.match(engineSource, /stateUpdateMode: "with_summary"/);
    assert.match(indexSource, /bindInput\("tiandao_state_update_mode", "stateUpdateMode"/);
    assert.match(indexSource, /切换只作用于后续回复，不会重跑历史/);
    assert.match(indexSource, /独立模式每轮调用总结 API/);
    assert.match(indexSource, /正文模式由主模型随回复返回，不增加请求/);
    assert.match(indexSource, /状态区块发送时剔除/);
    assert.match(indexSource, /漏写只提示，不自动补跑/);
    assert.match(styleSource, /details\[data-suwei-state="1"\][^}]*display: none !important/);
    assert.match(indexSource, /stateMode !== "independent" && settings.autoSummarizePerTurn/);
});
