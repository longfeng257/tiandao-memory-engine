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
    assert.match(indexSource, /task\.controller\.abort\(\)/);
    assert.match(indexSource, /finishSummaryTask\(task\)/);
    assert.match(styleSource, /\.tiandao-summary-progress\s*\{/);
    assert.match(styleSource, /\.tiandao-summary-progress-bar\s*\{/);
});

test("backfill and story rebuild pass cancellation signals into summary work", () => {
    assert.match(indexSource, /backfillExistingChatHistory\([\s\S]{0,2200}shouldCommitTurn:[\s\S]{0,160}signal,/);
    assert.match(indexSource, /runStoryResummarize[\s\S]{0,2200}beginSummaryTask/);
    assert.match(indexSource, /rebuildMemoryHierarchy\([\s\S]{0,400}\{ signal \}/);
    assert.match(indexSource, /resummarizeRoundInPlace\([\s\S]{0,500}signal/);
    assert.match(indexSource, /isSummaryTaskCancelled\(task\)/);
});

test("story range exposes fill, view and rebuild modes plus recovery entry", () => {
    assert.match(indexSource, /id="tiandao_story_range_from"/);
    assert.match(indexSource, /id="tiandao_story_range_to"/);
    assert.match(indexSource, /id="tiandao_story_range_mode"[\s\S]*?value="fill"/);
    assert.match(indexSource, /value="view"/);
    assert.match(indexSource, /value="rebuild"/);
    assert.match(indexSource, /id="tiandao_story_error_box"/);
    assert.match(indexSource, /id="tiandao_story_recover_btn"/);
    assert.match(styleSource, /\.tiandao-story-error-box/);
    assert.match(styleSource, /\.tiandao-story-range-mode/);
});

test("API controls expose retry, max tokens and JSON mode", () => {
    assert.match(indexSource, /id="tiandao_summary_retry"/);
    assert.match(indexSource, /id="tiandao_max_tokens"/);
    assert.match(indexSource, /id="tiandao_use_json_mode"/);
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
});

test("story timeline paginates twenty entries with older and newer controls", () => {
    assert.match(indexSource, /const STORY_PAGE_SIZE = 20/);
    assert.match(indexSource, /Math\.ceil\(entries\.length \/ STORY_PAGE_SIZE\)/);
    assert.match(indexSource, /data-story-page="older"/);
    assert.match(indexSource, /data-story-page="newer"/);
    assert.match(indexSource, /storyPage \+= button\.dataset\.storyPage === "older" \? 1 : -1/);
    assert.match(styleSource, /\.tiandao-story-pager\s*\{/);
    assert.match(styleSource, /\.tiandao-story-page-btn\s*\{/);
});

test("pending automatic summaries queue instead of being dropped", () => {
    assert.match(indexSource, /function enqueuePendingAiTurns\(chat, upToIndex, options = \{\}\)[\s\S]{0,2600}enqueueBackgroundSummary\(async \(\) => \{[\s\S]{0,300}beginSummaryTask/);
    assert.doesNotMatch(indexSource, /function enqueuePendingAiTurns\(chat, upToIndex, options = \{\}\)[\s\S]{0,1000}if \(activeSummaryTask\) \{[\s\S]{0,200}return null;/);
});

test("legacy state snapshot migration is persisted after load", () => {
    assert.match(indexSource, /previousStateStorageVersion = metadata\.tiandao_memory\.stateStorageVersion/);
    assert.match(indexSource, /previousStateStorageVersion !== memoryData\.stateStorageVersion[\s\S]{0,120}scheduleChatSave\(\)/);
});

test("story range stays on one compact row", () => {
    assert.match(styleSource, /\.tiandao-story-range-bar[\s\S]{0,160}flex-wrap:\s*nowrap/);
    assert.match(styleSource, /\.tiandao-story-range-bar \.tiandao-input-sm[\s\S]{0,140}width:\s*38px/);
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
    assert.match(indexSource, /bindCheck\("tiandao_include_native_hidden", "includeNativeHidden"\)/);
    assert.match(indexSource, /isAiReplyMessage\(msg, settings\.includeNativeHidden\)/);
});
