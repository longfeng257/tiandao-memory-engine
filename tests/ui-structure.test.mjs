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
