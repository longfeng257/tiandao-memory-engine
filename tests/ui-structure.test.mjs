import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const indexSource = readFileSync(join(root, "index.js"), "utf8");
const engineSource = readFileSync(join(root, "memory-engine.js"), "utf8");
const styleSource = readFileSync(join(root, "style.css"), "utf8");

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
    assert.match(indexSource, /英文逗号、中文逗号或空格均可分隔/);
    assert.match(indexSource, /同样使用英文逗号、中文逗号或空格分隔/);
    assert.match(indexSource, /标签名不必带尖括号，大小写不敏感/);
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

test("memory depth and safety token cap stay internal", () => {
    assert.doesNotMatch(indexSource, /id="tiandao_max_level"/);
    assert.doesNotMatch(indexSource, /id="tiandao_memory_budget"/);
    assert.match(engineSource, /const MAX_MEMORY_LEVEL = 3/);
    assert.match(engineSource, /tokenBudget = 5000/);
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
    assert.match(indexSource, /memoryData\.levels = rebuiltLevels\.levels;/);
    assert.match(indexSource, /memoryData\.farHistory = rebuiltLevels\.farHistory;/);
    assert.match(indexSource, /本次修改未保存/);
    assert.match(indexSource, /pendingHierarchyEdits/);
    assert.match(indexSource, /重建后的层级无法定位所选阶段/);
    assert.match(indexSource, /restoreStagedIfNeeded/);
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

test("model lists normalize full endpoint URLs and the pill is keyboard operable", () => {
    assert.match(indexSource, /function getModelsEndpoint\(baseUrl\)/);
    assert.match(indexSource, /normalized\.endsWith\("\/chat\/completions"\)/);
    assert.match(indexSource, /id="tiandao_widget_pill"[^>]*role="button"[^>]*tabindex="0"/);
    assert.match(indexSource, /pill\.addEventListener\("keydown"/);
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

test("story timeline defaults to descending order and exposes ascending order", () => {
    assert.match(indexSource, /let storySortOrder = "desc"/);
    assert.match(indexSource, /id="tiandao_story_sort_order"[\s\S]{0,220}<option value="desc" selected>倒序<\/option>[\s\S]{0,80}<option value="asc">正序<\/option>/);
    assert.match(indexSource, /const displayEntries = storySortOrder === "desc"[\s\S]{0,60}entries\.slice\(\)\.reverse\(\)/);
    assert.match(indexSource, /剧情时间线（\$\{storySortOrder === "desc" \? "由近及远" : "由远及近"\}）/);
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

test("story range stays on one compact row", () => {
    assert.match(styleSource, /\.tiandao-story-range-bar[\s\S]{0,160}flex-wrap:\s*nowrap/);
    assert.match(styleSource, /\.tiandao-story-range-bar \.tiandao-input-sm[\s\S]{0,140}width:\s*38px/);
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
    assert.match(indexSource, /切换后建议立即重新扫描或重建/);
});

test("story range has an explicit settings binding", () => {
    assert.match(indexSource, /function resummarizeStoryRange\(\) \{\s*const ctx = getSTContext\(\);\s*const settings = getSettings\(\);/);
    assert.match(indexSource, /buildRoundMessageIndex\(chat, settings\.includeNativeHidden\)/);
});

test("fetched models open a dedicated clickable menu", () => {
    assert.match(indexSource, /id="tiandao_model_toggle_btn"/);
    assert.match(indexSource, /function openModelMenu\(/);
    assert.match(indexSource, /function setFetchedModelNames\(/);
    assert.match(indexSource, /ensureModelMenu\(\)/);
    assert.match(indexSource, /modelInput\?\.addEventListener\("click"/);
    assert.match(indexSource, /setFetchedModelNames\(names\)/);
    assert.match(indexSource, /手动输入模型名称/);
    assert.match(indexSource, /isMobileWidgetViewport\(\) && fetchedModelNames\.length > 0/);
    assert.match(indexSource, /if \(!isMobileWidgetViewport\(\)\) input\.focus\(\)/);
    assert.match(styleSource, /\.tiandao-model-menu\s*\{/);
    assert.match(styleSource, /\.tiandao-model-option\.selected\s*\{/);
    assert.match(styleSource, /\.tiandao-model-manual\s*\{/);
});

test("chat changes reset story editing and abort stale summaries", () => {
    assert.match(indexSource, /if \(eventTypes\.CHAT_CHANGED\)[\s\S]{0,700}if \(activeSummaryTask\) requestSummaryTaskStop\(\)/);
    assert.match(indexSource, /if \(eventTypes\.CHAT_CHANGED\)[\s\S]{0,900}storyEditingKey = null;/);
    assert.match(indexSource, /if \(eventTypes\.CHAT_CHANGED\)[\s\S]{0,900}storyViewRange = null;/);
});

test("todo edits are blocked while the current chat is being summarized", () => {
    assert.match(indexSource, /const memoryBusy = activeSummaryChats\.has\(chatKey\)/);
    assert.match(indexSource, /\$\{memoryBusy \? "disabled" : ""\}/);
    assert.match(indexSource, /async function updateTodoCompletion\(todoId, completed\) \{\s*const chatKey = getChatKey\(\);\s*if \(activeSummaryChats\.has\(chatKey\)/);
});

test("interrupted range rebuild invalidates contradictory high-level summaries", () => {
    assert.match(indexSource, /const partial = completedRounds > 0 && !rebuiltSuccessfully;/);
    assert.match(indexSource, /invalidateDerivedSummariesInRange\(memoryData, fromRound, toRound\)/);
    assert.match(engineSource, /export function invalidateDerivedSummariesInRange/);
});

test("range fill explains prerequisite rounds before processing", () => {
    assert.match(indexSource, /const pendingThroughRange = collectPendingAiTurns\(/);
    assert.match(indexSource, /const prerequisiteCount = pendingThroughRange/);
    assert.match(indexSource, /将先补齐范围前 \$\{prerequisiteCount\} 轮前置缺口/);
    assert.match(indexSource, /补缺失\+前置/);
});

test("switching API profiles clears stale model options", () => {
    assert.match(indexSource, /settings\.activeApiProfileId = profile\.id;\s*setFetchedModelNames\(\[\]\);/);
    assert.match(indexSource, /模型列表已清空，请重新拉取/);
});

test("todo save failure restores the previous completion state", () => {
    assert.match(indexSource, /const previousCompletion = \{/);
    assert.match(indexSource, /Object\.assign\(todo, previousCompletion\)/);
    assert.match(indexSource, /待办状态已保存，但刷新注入失败/);
});

test("placeholder cleanup schedules a chat save", () => {
    assert.match(indexSource, /if \(cleanupPlaceholderCharacters\(memoryData, ctx\.name1 \|\| "", true\)\) \{\s*scheduleChatSave\(\);/);
});

test("memory import is size limited", () => {
    assert.match(indexSource, /MAX_IMPORT_FILE_BYTES = 20 \* 1024 \* 1024/);
    assert.match(indexSource, /MAX_IMPORT_MEMORY_ENTRIES = 50_000/);
    assert.match(indexSource, /file\.size > MAX_IMPORT_FILE_BYTES/);
    assert.match(indexSource, /超过 20MB/);
    assert.match(indexSource, /记忆条目超过/);
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
    assert.match(indexSource, /info\[field\] = previousList/);
    assert.match(indexSource, /await refreshPromptInjection\("", \{ skipRetrieval: true \}\)/);
    assert.match(styleSource, /\.tiandao-item-delete:hover:not\(:disabled\)/);
});

test("model menus keep scrolling inside the open menu", () => {
    assert.match(indexSource, /const scrollingInsideModelMenu = modelMenu && !modelMenu\.hidden/);
    assert.match(indexSource, /const scrollingInsideEmbeddingMenu = embeddingMenu && !embeddingMenu\.hidden/);
    assert.match(indexSource, /if \(!scrollingInsideModelMenu\) closeModelMenu\(\)/);
    assert.match(indexSource, /if \(!scrollingInsideEmbeddingMenu\) closeEmbeddingModelMenu\(\)/);
    assert.match(styleSource, /\.tiandao-model-menu\s*\{[\s\S]{0,520}touch-action:\s*pan-y/);
    assert.match(styleSource, /-webkit-overflow-scrolling:\s*touch/);
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
    assert.match(indexSource, /recentRawRoundNumbers:\s*recentRawRounds > 0[\s\S]{0,180}getSendableRawRoundNumbers\(chat, settings, currentRound, recentRawRounds\)/);
    assert.match(indexSource, /function getSendableRawRoundNumbers\(chat, settings, currentRound = 0, recentRawRounds = 0\)/);
    assert.match(indexSource, /msg\.is_system \|\| !String\(msg\.mes \|\| ""\)\.trim\(\)/);
    assert.match(indexSource, /eventTypes\.MESSAGE_SWIPED[\s\S]{0,1800}scheduleAfterReplySwipeRepair\(getChatKey\(\)\)/);
    assert.match(indexSource, /clearEntryEmbedding\(item\)/);
    assert.match(indexSource, /embeddingDimension: archiveEntry\.embeddingDimension/);
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

test("story timeline mirrors prompt visibility for hidden raw rounds", () => {
    assert.match(indexSource, /function isL0FullyCoveredByRaw\(/);
    assert.match(
        indexSource,
        /rawRoundNumbers = rawKeep > 0[\s\S]{0,140}getSendableRawRoundNumbers\(chat, settings, currentRound, rawKeep\)/,
    );
    assert.match(
        indexSource,
        /isL0FullyCoveredByRaw\(it, rawWindowStart, currentRound, rawRoundNumbers\)/,
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
    assert.match(indexSource, /saveMetadataDebounced\(\)[\s\S]{0,120}return/);
    assert.match(
        indexSource,
        /const previousMemory = metadata\.tiandao_memory;\s*metadata\.tiandao_memory = createEmptyMemoryData\(\)[\s\S]{0,520}metadata\.tiandao_memory = previousMemory/,
    );
    assert.match(
        indexSource,
        /metadata\.tiandao_memory = merged;[\s\S]{0,320}metadata\.tiandao_memory = previousMemory/,
    );
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
    assert.match(indexSource, /retrieveRelevantArchivedMemories\([\s\S]{0,180}\{ skipNormalize: true \}/);
    assert.match(indexSource, /pruneStaleCharacters\([\s\S]{0,180}skipNormalize: true/);
    assert.match(
        indexSource,
        /function getSendableRawRoundNumbers\([\s\S]{0,500}Math\.max\(1, currentRound - recentRawRounds \+ 1\)/,
    );
    assert.match(indexSource, /renderStoryTimeline\(memoryData\)/);
    assert.match(engineSource, /function cloneMemoryForUpdate\(memoryData, skipNormalize = false\)/);
    assert.match(engineSource, /cloneMemoryForUpdate\(memoryData, true\)/);
    assert.match(engineSource, /memoryAlreadyNormalized: true/);
    assert.match(indexSource, /rollbackMemoryFromMessageIndex\(memoryData, idx, \{ skipNormalize: true \}\)/);
    assert.match(engineSource, /rollbackMemoryFromMessageIndex\(working, startMessageId, \{ skipNormalize: true \}\)/);
    assert.match(indexSource, /getSettings\(\)\.includeNativeHidden,\s*\{ skipNormalize: true \}/);
});
