import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import * as engine from "../memory-engine.js";
import * as recovery from "../recovery-store.js";
import * as history from "../history-builder.js";
import * as hostPrompt from "../host-prompt.js";
import * as stateProtocol from "../state-protocol.js";
import { createSummaryTaskGate } from "../task-gate.js";

const source = (await readFile(new URL("../index.js", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .split("(async function initTiandaoMemoryExtension()")[0];
function makeContext(id = "a") {
    const memory = engine.createEmptyMemoryData();
    memory.stateLedger.time = "清晨";
    memory.stateLedger.characters = { 旅人: { location: "城门", statusAndAction: "等待", wear: "布衣", inventory: [], removedItemsLock: [] } };
    return {
        chatId: id, characterId: 0, name1: "旅人", name2: "守卫",
        chat: [{ is_user: true, mes: "钥匙呢" }, { is_user: false, mes: "在这里" }],
        chatMetadata: { tiandao_memory: memory },
        extensionSettings: { "tiandao-memory-engine": { ...engine.DEFAULT_SETTINGS, enableRetrieval: false, autoHideOldMessages: false } },
        saveMetadata: async () => {},
        setExtensionPrompt(_key, text) { this.injected = text; },
    };
}
function harness({ renderTimeline = false } = {}) {
    let current = makeContext();
    const messages = [], readers = [];
    const nodes = new Map();
    for (const name of ["tiandao_injection_text", "tiandao_injection_info", "tiandao_injection_copy", "tiandao_recovery_select"]) nodes.set(name, { value: "", textContent: "", disabled: false });
    class Reader {
        constructor() { readers.push(this); }
        readAsText() {}
        async complete(value) { this.result = value; await this.onload(); }
    }
    const scope = vm.createContext({
        ...engine, ...recovery, ...history, ...hostPrompt, ...stateProtocol, createSummaryTaskGate,
        window: {}, SillyTavern: { getContext: () => current },
        document: { getElementById: id => nodes.get(id) || null },
        FileReader: Reader, confirm: () => true, console,
        setTimeout, clearTimeout, AbortController, Map, Set, WeakMap, WeakSet,
    });
    scope.messages = messages;
    scope.renderTimeline = renderTimeline;
    vm.runInContext(source + '\nconst nativeSyncHidden = syncHiddenMessagesState; updateFloatingWidgetUI = () => { if (renderTimeline) renderStoryTimeline(); }; renderRecoveryPoints = () => {}; if (!renderTimeline) renderStoryTimeline = () => {}; syncHiddenMessagesState = () => {}; updateStatusBar = text => messages.push(text); globalThis.api = { scanChatHistory, resummarizeRoundInPlace, refreshLedgerFromLatestL0, enqueueLiveStateUpdates, processSingleAiTurn, refreshPromptInjection, retryPendingSummarySave, getPendingSummarySave, recoverPendingSummaries, renderStoryRecoveryState, invalidateActiveSummaryWork, syncLegacyHidden: nativeSyncHidden, interceptor: globalThis.tiandaoMemoryInterceptor, requestSummaryTaskStop, checkpointBeforeChange, importMemoryJsonFile, restoreSelectedRecovery, buildTimelineHtml, buildLedgerHtml, getLedgerFreshness, invalidateRoundIndexCache, updateTodoCompletion, deleteLedgerItem, memoryOperationBusy, clearCurrentChatMemory, saveStoryEntry: window.tiandaoSaveStoryEntry, preview: () => lastInjectionPreview, setScope: value => {storyMemoryScope=value}, setSearch: value => {storySearchQuery=value} };', scope);
    return { api: scope.api, nodes, readers, messages, current: () => current, switchTo: value => { current = value; } };
}

test("widget preview equals the replacement history and clears on pause or chat change", async () => {
    const h = harness();
    await h.api.refreshPromptInjection();
    assert.equal(h.current().injected, "");
    assert.equal(h.nodes.get("tiandao_injection_text").value, h.api.preview().text);
    assert.equal(h.api.preview().text, history.formatHistoryPreview(h.api.preview().messages));
    h.current().extensionSettings["tiandao-memory-engine"].enabled = false;
    await h.api.refreshPromptInjection();
    assert.equal(h.current().injected, "");
    assert.equal(h.api.preview(), null);
    h.switchTo(makeContext("b"));
    await h.api.refreshPromptInjection();
    assert.equal(h.api.preview().chatKey, "b");
});

test("import saves a recovery point and does not graft vectors or state from colliding ids", async () => {
    const h = harness();
    const current = h.current();
    current.chatMetadata.tiandao_memory.archivePool = [{ id: "shared", level: 0, roundRange: "1", text: "旧文字", embedding: [1, 0], embeddingModel: "private", postStateSnapshot: { time: "原状态", characters: {}, todosAndPromises: [] } }];
    const imported = engine.createEmptyMemoryData();
    imported.archivePool = [{ id: "shared", level: 0, roundRange: "1", text: "新剧情" }];
    h.api.importMemoryJsonFile({ size: 100 });
    await h.readers[0].complete(JSON.stringify(imported));
    const metadata = current.chatMetadata;
    assert.equal(metadata.suwei_memory_recovery_v1.length, 1);
    assert.equal(metadata.suwei_memory_recovery_v1[0].label, "导入记忆");
    assert.equal(metadata.tiandao_memory.archivePool[0].embedding, undefined);
    assert.notEqual(metadata.tiandao_memory.archivePool[0].postStateSnapshot?.time, "原状态");
    assert.equal(metadata.tiandao_memory.archivePool[0].text, "新剧情");
});

test("import cannot land in a different chat while the file is being read", async () => {
    const h = harness();
    const original = h.current();
    h.api.importMemoryJsonFile({ size: 100 });
    const next = makeContext("b");
    h.switchTo(next);
    await h.readers[0].complete(JSON.stringify(engine.createEmptyMemoryData()));
    assert.equal(original.chatMetadata.suwei_memory_recovery_v1, undefined);
    assert.equal(next.chatMetadata.suwei_memory_recovery_v1, undefined);
    assert.equal(next.chatMetadata.tiandao_memory.stateLedger.time, "清晨");
    assert.ok(h.messages.some(message => message.includes("已切换聊天")));
});

test("failed import persistence restores the original memory object", async () => {
    const h = harness();
    const previous = h.current().chatMetadata.tiandao_memory;
    h.current().saveMetadata = async () => { throw Error("disk full"); };
    h.api.importMemoryJsonFile({ size: 100 });
    await h.readers[0].complete(JSON.stringify(engine.createEmptyMemoryData()));
    assert.equal(h.current().chatMetadata.tiandao_memory, previous);
    assert.equal(previous.stateLedger.time, "清晨");
    assert.ok(h.messages.some(message => message.includes("disk full")));
});

test("restore failure keeps current memory and a successful restore makes a redo point", async () => {
    const h = harness();
    assert.equal(h.api.checkpointBeforeChange("edit"), true);
    const point = h.current().chatMetadata.suwei_memory_recovery_v1[0];
    h.nodes.get("tiandao_recovery_select").value = point.id;
    h.current().chatMetadata.tiandao_memory.stateLedger.time = "夜晚";
    const previous = h.current().chatMetadata.tiandao_memory;
    h.current().saveMetadata = async () => { throw Error("disk full"); };
    await h.api.restoreSelectedRecovery();
    assert.equal(h.current().chatMetadata.tiandao_memory, previous);
    h.current().saveMetadata = async () => {};
    await h.api.restoreSelectedRecovery();
    assert.equal(h.current().chatMetadata.tiandao_memory.stateLedger.time, "清晨");
    assert.equal(h.current().chatMetadata.suwei_memory_recovery_v1.at(-1).memory.stateLedger.time, "夜晚");
});

test("old pinned entries obey timeline sort and archive search", () => {
    const h = harness();
    const memory = h.current().chatMetadata.tiandao_memory;
    const early = { id: "early", level: 0, roundRange: "1", text: "铜钥匙约定", pinned: true };
    const recent = { id: "recent", level: 0, roundRange: "8", text: "码头见面" };
    memory.archivePool = [early, recent]; memory.levels[0] = [recent];
    const html = h.api.buildTimelineHtml(memory);
    assert.ok(html.indexOf("码头见面") < html.indexOf("铜钥匙约定"));
    h.api.setScope("all"); h.api.setSearch("铜钥匙");
    const filtered = h.api.buildTimelineHtml(memory);
    assert.ok(filtered.includes("铜钥匙约定"));
    assert.ok(!filtered.includes("码头见面"));
    h.api.setScope("pinned"); h.api.setSearch("");
    assert.ok(!h.api.buildTimelineHtml(memory).includes("码头见面"));
});

test("failed todo persistence rolls back the normalized ledger and releases the edit lock", async () => {
    const h = harness();
    const memory = h.current().chatMetadata.tiandao_memory;
    memory.stateLedger.todosAndPromises = [{ id: "promise", text: "归还铜钥匙", completed: false }];
    let rejectSave;
    h.current().saveMetadata = () => new Promise((resolve, reject) => { rejectSave = reject; });
    const pending = h.api.updateTodoCompletion("promise", true);
    assert.equal(h.api.memoryOperationBusy(), true);
    assert.equal(h.api.checkpointBeforeChange("blocked"), false);
    engine.normalizeMemoryData(memory);
    h.current().saveMetadata = async () => {};
    rejectSave(Error("disk full"));
    await pending;
    assert.equal(memory.stateLedger.todosAndPromises[0].completed, false);
    assert.equal(h.api.memoryOperationBusy(), false);
    await h.api.updateTodoCompletion("promise", true);
    assert.equal(memory.stateLedger.todosAndPromises[0].completed, true);
});

test("failed inventory persistence restores normalized items and permits a retry", async () => {
    const h = harness();
    const memory = h.current().chatMetadata.tiandao_memory;
    memory.stateLedger.characters.旅人.inventory = ["铜钥匙"];
    let rejectSave;
    h.current().saveMetadata = () => new Promise((resolve, reject) => { rejectSave = reject; });
    const pending = h.api.deleteLedgerItem("旅人", "inventory", 0);
    assert.equal(h.api.memoryOperationBusy(), true);
    engine.normalizeMemoryData(memory);
    h.current().saveMetadata = async () => {};
    rejectSave(Error("disk full"));
    await pending;
    assert.deepEqual(Array.from(memory.stateLedger.characters.旅人.inventory), ["铜钥匙"]);
    assert.equal(h.api.memoryOperationBusy(), false);
    await h.api.deleteLedgerItem("旅人", "inventory", 0);
    assert.equal(memory.stateLedger.characters.旅人.inventory.length, 0);
});

test("a failed save after switching chats cannot save or report errors into the next chat", async () => {
    const h = harness();
    const original = h.current();
    original.chatMetadata.tiandao_memory.stateLedger.todosAndPromises = [{ id: "promise", text: "归还铜钥匙", completed: false }];
    let rejectSave;
    original.saveMetadata = () => new Promise((resolve, reject) => { rejectSave = reject; });
    const pending = h.api.updateTodoCompletion("promise", true);
    const next = makeContext("b");
    let nextSaves = 0;
    next.saveMetadata = async () => { nextSaves++; };
    h.switchTo(next);
    rejectSave(Error("disk full"));
    await pending;
    assert.equal(nextSaves, 0);
    assert.equal(original.chatMetadata.tiandao_memory.stateLedger.todosAndPromises[0].completed, false);
    assert.equal(h.api.memoryOperationBusy(), false);
    assert.ok(!h.messages.some(message => message.includes("disk full")));
});

test("failed clear restores the original memory and releases the mutation lock", async () => {
    const h = harness();
    const original = h.current().chatMetadata.tiandao_memory;
    let rejectSave;
    h.current().saveMetadata = () => new Promise((resolve, reject) => { rejectSave = reject; });
    const pending = h.api.clearCurrentChatMemory();
    assert.equal(h.api.memoryOperationBusy(), true);
    assert.notEqual(h.current().chatMetadata.tiandao_memory, original);
    rejectSave(Error("disk full"));
    await pending;
    assert.equal(h.current().chatMetadata.tiandao_memory, original);
    assert.equal(original.stateLedger.time, "清晨");
    assert.equal(h.api.memoryOperationBusy(), false);
    h.current().saveMetadata = async () => {};
    await h.api.clearCurrentChatMemory();
    assert.equal(h.current().chatMetadata.tiandao_memory.stateLedger.time, "未知时间");
});

test("a failed clear after switching chats preserves the original without touching the new chat", async () => {
    const h = harness();
    const original = h.current();
    const originalMemory = original.chatMetadata.tiandao_memory;
    let rejectSave;
    original.saveMetadata = () => new Promise((resolve, reject) => { rejectSave = reject; });
    const pending = h.api.clearCurrentChatMemory();
    const next = makeContext("b");
    h.switchTo(next);
    rejectSave(Error("disk full"));
    await pending;
    assert.equal(original.chatMetadata.tiandao_memory, originalMemory);
    assert.equal(next.chatMetadata.tiandao_memory.stateLedger.time, "清晨");
    assert.equal(h.api.memoryOperationBusy(), false);
    assert.ok(!h.messages.some(message => message.includes("disk full")));
});

test("saving an edited L0 holds the mutation lock and rolls back on persistence failure", async () => {
    const h = harness();
    const memory = h.current().chatMetadata.tiandao_memory;
    const entry = {id: "entry", level: 0, roundRange: "1", startMessageId: 0, endMessageId: 1, text: "原剧情"};
    memory.archivePool = [entry]; memory.levels[0] = [entry];
    h.nodes.set("tiandao_story_page_timeline", {querySelector: () => ({value: "新剧情"})});
    let rejectSave;
    h.current().saveMetadata = () => new Promise((resolve, reject) => { rejectSave = reject; });
    const pending = h.api.saveStoryEntry(0, 0);
    assert.equal(h.api.memoryOperationBusy(), true);
    h.current().saveMetadata = async () => {};
    rejectSave(Error("disk full"));
    await pending;
    assert.equal(memory.levels[0][0].text, "原剧情");
    assert.equal(memory.archivePool[0].text, "原剧情");
    assert.equal(h.api.memoryOperationBusy(), false);
});

for (const roundCount of [1, 2]) {
    test(`a newly archived ${roundCount}-round L0 appears on the default story timeline inside the raw window`, async t => {
        const h = harness({ renderTimeline: true });
        const context = h.current();
        const settings = context.extensionSettings["tiandao-memory-engine"];
        Object.assign(settings, {
            autoHideOldMessages: true,
            keepRecentRoundsCount: 5,
            apiUrl: "https://example.invalid/v1",
            apiKey: "test-key",
            model: "test-model",
        });
        if (roundCount === 2) {
            context.chat.push({ is_user: true, mes: "还需要什么？" }, { is_user: false, mes: "一封信。" });
        }
        const text = "守卫答应替旅人保管铜钥匙。";
        const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ l0_summary: text, keywords: [], stateLedger: {} }) } }],
        }), { headers: { "Content-Type": "application/json" } }));
        const timeline = { innerHTML: "" };
        h.nodes.set("tiandao_story_page_timeline", timeline);
        const saved = [];
        context.saveMetadata = async () => saved.push(context.chatMetadata.tiandao_memory.archivePool.map(item => item.text));
        const lastFloor = context.chat.length - 1;
        const groupTurns = Array.from({ length: roundCount }, (_, i) => ({ idx: i * 2 + 1 }));
        assert.equal(await h.api.processSingleAiTurn(lastFloor, false, { groupTurns }), true);
        assert.equal(fetchMock.mock.callCount(), 1);
        assert.equal(saved.at(-1)[0], text);
        assert.ok(timeline.innerHTML.includes(text), "default timeline should show the newly saved L0");
        assert.ok(!context.injected.includes(text), "the raw messages already cover the L0 for the model");
    });
}


function mockSummary(t, h) {
    Object.assign(h.current().extensionSettings['tiandao-memory-engine'], { apiUrl: 'https://summary.test/v1', apiKey: 'test', model: 'test', autoSummarizePerTurn: false });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ l0_summary: '守卫答应保管铜钥匙。', keywords: [], stateLedger: {} }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    return () => calls;
}

test('failed automatic save restores the cursor and retries the generated result without another API call', async t => {
    const h = harness(), calls = mockSummary(t, h), memory = h.current().chatMetadata.tiandao_memory;
    h.current().saveMetadata = async () => { throw Error('disk full'); };
    assert.equal(await h.api.processSingleAiTurn(1), false);
    assert.equal(memory.lastProcessedMessageId, -1);
    assert.equal(memory.archivePool.length, 0);
    assert.equal(engine.collectPendingAiTurns(h.current().chat, memory.lastProcessedMessageId).length, 1);
    assert.ok(h.api.getPendingSummarySave());
    assert.equal(h.api.memoryOperationBusy(), true);
    assert.equal(calls(), 1);
    h.current().saveMetadata = async () => {};
    assert.equal(await h.api.retryPendingSummarySave(), true);
    assert.equal(calls(), 1);
    assert.equal(memory.archivePool.length, 1);
    assert.equal(memory.lastProcessedMessageId, 1);
    assert.equal(h.api.getPendingSummarySave(), null);
    assert.equal(h.api.memoryOperationBusy(), false);
});

test('repeated failed save retries keep the original cursor and the same generated summary', async t => {
    const h = harness(), calls = mockSummary(t, h), memory = h.current().chatMetadata.tiandao_memory;
    h.current().saveMetadata = async () => { throw Error('offline'); };
    await h.api.processSingleAiTurn(1);
    assert.equal(await h.api.retryPendingSummarySave(), false);
    assert.equal(await h.api.retryPendingSummarySave(), false);
    assert.equal(memory.lastProcessedMessageId, -1);
    assert.equal(memory.archivePool.length, 0);
    assert.equal(calls(), 1);
    assert.ok(h.api.getPendingSummarySave());
});

test('an automatic retry reuses pending generation and never duplicates an L0', async t => {
    const h = harness(), calls = mockSummary(t, h);
    h.current().saveMetadata = async () => { throw Error('offline'); };
    await h.api.processSingleAiTurn(1);
    h.current().saveMetadata = async () => {};
    assert.equal(await h.api.processSingleAiTurn(1), true);
    assert.equal(calls(), 1);
    assert.equal(h.current().chatMetadata.tiandao_memory.archivePool.length, 1);
});

test('editing the summarized source invalidates the unsaved candidate instead of replaying old facts', async t => {
    const h = harness(), calls = mockSummary(t, h);
    h.current().saveMetadata = async () => { throw Error('offline'); };
    await h.api.processSingleAiTurn(1);
    h.current().chat[1].mes = '改为把钥匙交给另一位旅人';
    assert.equal(h.api.getPendingSummarySave(), null);
    h.current().saveMetadata = async () => {};
    assert.equal(await h.api.processSingleAiTurn(1), true);
    assert.equal(calls(), 2);
});

test('failed generated save after switching chats rolls back only the original and can be retried there', async t => {
    const h = harness(), calls = mockSummary(t, h), original = h.current();
    let reject;
    original.saveMetadata = () => new Promise((resolve, rejectSave) => { reject = rejectSave; });
    const work = h.api.processSingleAiTurn(1);
    for (let i = 0; i < 25 && !reject; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(reject);
    const next = makeContext('next'); let nextSaves = 0;
    next.saveMetadata = async () => { nextSaves++; };
    h.switchTo(next); reject(Error('offline')); await work;
    assert.equal(original.chatMetadata.tiandao_memory.archivePool.length, 0);
    assert.equal(nextSaves, 0);
    assert.equal(next.chatMetadata.tiandao_memory.archivePool.length, 0);
    h.switchTo(original); original.saveMetadata = async () => {};
    assert.equal(await h.api.retryPendingSummarySave(), true);
    assert.equal(calls(), 1);
    assert.equal(original.chatMetadata.tiandao_memory.archivePool.length, 1);
});

test('generation replaces only a working history copy and clears the legacy depth prompt', async () => {
    const h = harness(), ctx = h.current();
    ctx.extensionSettings['tiandao-memory-engine'].autoSummarizePerTurn = false;
    const before = JSON.stringify(ctx.chat);
    const core = ctx.chat.map((message, index) => ({ ...message, index }));
    let aborted = false;
    await h.api.interceptor(core, 10000, () => { aborted = true; }, 'normal');
    assert.equal(aborted, false);
    assert.equal(JSON.stringify(ctx.chat), before);
    assert.equal(ctx.injected, '');
    assert.equal(history.formatHistoryPreview(core), h.api.preview().text);
});

test('a host passing its live source array is stopped without overwriting the chat', async () => {
    const h = harness(), ctx = h.current(), before = JSON.stringify(ctx.chat);
    let aborted = false;
    await h.api.interceptor(ctx.chat, 10000, () => { aborted = true; }, 'normal');
    assert.equal(aborted, true);
    assert.equal(JSON.stringify(ctx.chat), before);
});

test('legacy hidden flags are restored while native hidden messages remain untouched', () => {
    const h = harness(), ctx = h.current();
    ctx.chat[0].is_system = true; ctx.chat[0].extra = { tiandao_hidden: true };
    ctx.chat[1].is_system = true;
    h.api.syncLegacyHidden();
    assert.equal(ctx.chat[0].is_system, false);
    assert.equal(ctx.chat[0].extra.tiandao_hidden, undefined);
    assert.equal(ctx.chat[1].is_system, true);
});


test('an explicit false save result leaves a retryable candidate instead of reporting success', async t => {
    const h = harness(); mockSummary(t, h);
    h.current().saveMetadata = async () => false;
    assert.equal(await h.api.processSingleAiTurn(1), false);
    assert.equal(h.current().chatMetadata.tiandao_memory.lastProcessedMessageId, -1);
    assert.ok(h.api.getPendingSummarySave());
});

test('a fire-and-forget debounced save is not accepted as durable completion', async t => {
    const h = harness(); mockSummary(t, h); let debounced = 0;
    delete h.current().saveMetadata;
    h.current().saveMetadataDebounced = () => { debounced++; };
    assert.equal(await h.api.processSingleAiTurn(1), false);
    assert.equal(debounced, 0);
    assert.ok(h.api.getPendingSummarySave());
});

test('stopping a pending summary aborts its request without archiving a partial result', async t => {
    const h = harness(); mockSummary(t, h);
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        ready();
        return await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('stopped','AbortError')), { once: true }));
    });
    const work = h.api.processSingleAiTurn(1);
    await started;
    h.api.requestSummaryTaskStop();
    assert.equal(await work, false);
    assert.equal(h.current().chatMetadata.tiandao_memory.archivePool.length, 0);
    assert.equal(h.current().chatMetadata.tiandao_memory.lastProcessedMessageId, -1);
    assert.equal(h.api.getPendingSummarySave(), null);
});

test('prepared preview filters native prompt-only choices while the source chat stays intact', async () => {
    const h = harness(), ctx = h.current();
    ctx.chat[1].mes = '剧情正文<options>不要发送的选项</options>';
    const before = JSON.stringify(ctx.chat);
    ctx.getRegexedString = (text, placement, options) => {
        assert.equal(options.isPrompt, true);
        return placement === 2 ? text.replace(/<options>.*?<\/options>/g, '') : text;
    };
    await h.api.refreshPromptInjection();
    assert.match(h.api.preview().text, /剧情正文/);
    assert.doesNotMatch(h.api.preview().text, /不要发送的选项|<options>/);
    assert.equal(JSON.stringify(ctx.chat), before);
});

test('actual send retains host-preprocessed text without applying regex for a second time', async () => {
    const h = harness(), ctx = h.current();
    Object.assign(ctx.extensionSettings['tiandao-memory-engine'], { autoSummarizePerTurn: false, enableRetrieval: false });
    ctx.chat[1].mes = '原始正文<options>禁止发送</options>';
    ctx.getRegexedString = () => { throw Error('已经过滤过的 coreChat 不应再处理'); };
    const core = ctx.chat.map((message, index) => ({ ...message, index }));
    core[1].mes = '酒馆处理后的正文';
    let aborted = false;
    await h.api.interceptor(core, 10000, () => { aborted = true; }, 'normal');
    assert.equal(aborted, false);
    assert.ok(core.some(message => message.mes === '酒馆处理后的正文'));
    assert.doesNotMatch(h.api.preview().text, /禁止发送/);
});

test('automatic L0 summary sends only regex-filtered source dialogue', async t => {
    const h = harness(), ctx = h.current(), bodies = [];
    Object.assign(ctx.extensionSettings['tiandao-memory-engine'], { apiUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'test-model' });
    ctx.chat[1].mes = '守卫接过铜钥匙。<options>不要总结的选项</options>';
    ctx.getRegexedString = text => text.replace(/<options>.*?<\/options>/g, '');
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ l0_summary: '守卫接过铜钥匙。', keywords: [], stateLedger: {} }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    assert.equal(await h.api.processSingleAiTurn(1), true);
    assert.equal(bodies.length, 1);
    const sourcePrompt = bodies[0].messages.find(item => item.role === 'user').content;
    assert.match(sourcePrompt, /守卫接过铜钥匙/);
    assert.doesNotMatch(sourcePrompt, /不要总结的选项|<options>/);
});

test('embedding retrieval query also obeys outgoing regex exclusions', async t => {
    const h = harness(), ctx = h.current(), bodies = [];
    Object.assign(ctx.extensionSettings['tiandao-memory-engine'], {
        enableRetrieval: true, useEmbeddingApi: true, embeddingApiUrl: 'https://query-regression.invalid/v1', embeddingApiKey: 'test-key',
    });
    const memory = ctx.chatMetadata.tiandao_memory;
    for (let round = 1; round <= 8; round++) {
        if (round > 1) ctx.chat.push({ is_user: true, mes: '提问' }, { is_user: false, mes: '回答' });
        memory.archivePool.push({ id: 'q'+round, level: 0, roundRange: String(round), startMessageId: round*2-2, endMessageId: round*2-1, text: '铜钥匙放在柜子里。', keywords: ['铜钥匙'] });
    }
    memory.levels[0] = memory.archivePool.slice(-2);
    memory.levels[1] = [{ id: 'phase', level: 1, roundRange: '1-6', text: '守卫保管铜钥匙。' }];
    memory.lastProcessedMessageId = 15; memory.lastProcessedRound = 8;
    ctx.chat.push({ is_user: true, mes: '铜钥匙呢？<options>不可发送的秘密选项</options>' });
    ctx.getRegexedString = text => text.replace(/<options>.*?<\/options>/g, '');
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    await h.api.refreshPromptInjection();
    assert.equal(bodies.length, 1);
    assert.match(bodies[0].input, /铜钥匙/);
    assert.doesNotMatch(bodies[0].input, /秘密|<options>/);
});

test('an already archived round is not summarized again after asynchronous preprocessing', async t => {
    const h = harness(), ctx = h.current();
    Object.assign(ctx.extensionSettings['tiandao-memory-engine'], { apiUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'test-model' });
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
        throw Error('已经归档的轮次不应再次调用 API');
    });
    const work = h.api.processSingleAiTurn(1);
    // Simulate another successful archive while host preprocessing is suspended.
    ctx.chatMetadata.tiandao_memory.lastProcessedMessageId = 1;
    ctx.chatMetadata.tiandao_memory.lastProcessedRound = 1;
    assert.equal(await work, true);
    assert.equal(fetch.mock.callCount(), 0);
});

function retrievalReviewFixture() {
    const h = harness(), ctx = h.current();
    Object.assign(ctx.extensionSettings['tiandao-memory-engine'], {
        enableRetrieval: true, autoSummarizePerTurn: false,
        useEmbeddingApi: true, embeddingApiUrl: 'https://retrieval-review.invalid/v1', embeddingApiKey: 'test-key',
    });
    const memory = ctx.chatMetadata.tiandao_memory;
    for (let round = 1; round <= 8; round++) {
        if (round > 1) ctx.chat.push({ is_user: true, mes: '铜钥匙呢？' }, { is_user: false, mes: '守卫保管着铜钥匙。' });
        memory.archivePool.push({ id: 'review-'+round, level: 0, roundRange: String(round), startMessageId: round*2-2, endMessageId: round*2-1, text: '铜钥匙放在柜子里。', keywords: ['铜钥匙'] });
    }
    memory.levels[0] = memory.archivePool.slice(-2);
    memory.levels[1] = [{ id: 'review-phase', level: 1, roundRange: '1-6', text: '守卫保管铜钥匙。' }];
    memory.lastProcessedMessageId = 15; memory.lastProcessedRound = 8;
    return h;
}

test('actual retrieval uses the host-preprocessed user text without rereading the raw source', async t => {
    const h = retrievalReviewFixture(), ctx = h.current(), bodies = [];
    ctx.chat.push({ is_user: true, mes: '铜钥匙在哪？原始内容不可发送' });
    const core = ctx.chat.map((message, index) => ({ ...message, index }));
    core.at(-1).mes = '只允许查询铜钥匙';
    ctx.getRegexedString = () => { throw Error('发出副本已经由宿主过滤，不能重新读取原文'); };
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    let aborted = false;
    await h.api.interceptor(core, 10000, () => { aborted = true; }, 'normal');
    assert.equal(aborted, false);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0].input, /只允许查询铜钥匙/);
    assert.doesNotMatch(bodies[0].input, /原始内容不可发送/);
});

test('swipe never uses the discarded reply as a retrieval or embedding query', async t => {
    const h = retrievalReviewFixture(), ctx = h.current();
    ctx.chat.at(-2).mes = '';
    ctx.chat.at(-1).mes = '被丢弃回复中的秘密剧情';
    ctx.getRegexedString = text => text;
    const core = ctx.chat.slice(0, -1).map((message, index) => ({ ...message, index }));
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
        throw Error('没有有效玩家查询时不能把被丢弃回复发给向量 API');
    });
    let aborted = false;
    await h.api.interceptor(core, 10000, () => { aborted = true; }, 'swipe');
    assert.equal(aborted, false);
    assert.equal(fetch.mock.callCount(), 0);
    assert.doesNotMatch(h.api.preview().text, /被丢弃回复中的秘密剧情/);
});

function setLedgerRoundFixture(h, completed, snapshot = 5) {
    const ctx = h.current();
    ctx.chat = Array.from({ length: completed }, (_, i) => [
        { is_user: true, mes: '玩家第' + (i + 1) + '轮' },
        { is_user: false, mes: '剧情第' + (i + 1) + '轮' },
    ]).flat();
    const memory = ctx.chatMetadata.tiandao_memory;
    memory.lastProcessedRound = snapshot;
    memory.lastProcessedMessageId = snapshot * 2 - 1;
    ctx.extensionSettings['tiandao-memory-engine'].l0RoundsPerSummary = 5;
    return { ctx, memory };
}

test('five-round L0 panels expose each unsynced round without requesting state extraction', t => {
    const h = harness();
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('面板刷新不得调用模型'); });
    for (let completed = 5; completed <= 10; completed++) {
        const { memory } = setLedgerRoundFixture(h, completed);
        const freshness = h.api.getLedgerFreshness(memory);
        assert.equal(freshness.snapshotRound, 5);
        assert.equal(freshness.latestRound, completed);
        assert.equal(freshness.pendingRounds, completed - 5);
        assert.equal(freshness.stale, completed > 5);
        const html = h.api.buildLedgerHtml(memory);
        assert.match(html, /账本快照 · 截至第 5 轮/);
        assert.match(html, /快照故事时间/);
        if (completed > 5) {
            assert.ok(html.includes((completed - 5) + ' 轮尚未同步'));
            assert.match(html, /以之后的剧情为准/);
            assert.match(html, /is-stale/);
        }
    }
    const { memory } = setLedgerRoundFixture(h, 10, 10);
    assert.equal(h.api.getLedgerFreshness(memory).stale, false);
    assert.equal(fetch.mock.callCount(), 0);
});

test('panels distinguish no first batch, manual mode and next-send timing', () => {
    const h = harness();
    let { memory } = setLedgerRoundFixture(h, 4, 0);
    assert.match(h.api.buildLedgerHtml(memory), /账本尚未同步/);
    assert.match(h.api.buildLedgerHtml(memory), /最新已完成第 4 轮/);
    let fixture = setLedgerRoundFixture(h, 8, 5);
    fixture.ctx.extensionSettings['tiandao-memory-engine'].l0MergeMode = 'manual';
    assert.equal(h.api.getLedgerFreshness(fixture.memory).pendingRounds, 3);
    fixture = setLedgerRoundFixture(h, 5, 0);
    fixture.ctx.extensionSettings['tiandao-memory-engine'].summarizeTiming = 'on_next_send';
    assert.equal(h.api.getLedgerFreshness(fixture.memory).pendingRounds, 5);
    assert.match(h.api.buildLedgerHtml(fixture.memory), /尚无已归档的状态快照/);
});

test('a new player message marks an otherwise synchronized panel as stale', () => {
    const h = harness(), { ctx, memory } = setLedgerRoundFixture(h, 5, 5);
    assert.equal(h.api.getLedgerFreshness(memory).stale, false);
    ctx.chat.push({ is_user: true, mes: '我脱下外套，放到桌上。' });
    h.api.invalidateRoundIndexCache(ctx.chat);
    assert.equal(h.api.getLedgerFreshness(memory).pendingRounds, 0);
    assert.equal(h.api.getLedgerFreshness(memory).stale, true);
    assert.match(h.api.buildLedgerHtml(memory), /有新的玩家消息尚未同步/);
    ctx.chat.push({ is_user: false, mes: '守卫拿起桌上的外套。' });
    h.api.invalidateRoundIndexCache(ctx.chat);
    assert.match(h.api.buildLedgerHtml(memory), /1 轮尚未同步/);
});

test('an out-of-range snapshot is not presented as synchronized after chat truncation', () => {
    const h = harness(), { memory } = setLedgerRoundFixture(h, 3, 5);
    assert.equal(h.api.getLedgerFreshness(memory).stale, true);
    assert.match(h.api.buildLedgerHtml(memory), /快照超出当前剧情范围/);
});

function liveModeHarness(mode, overrides = {}) {
    const h = harness(), ctx = h.current();
    ctx.chat = [];
    Object.assign(ctx.extensionSettings['tiandao-memory-engine'], {
        stateUpdateMode: mode, l0RoundsPerSummary: 5, summarizeTiming: 'after_reply',
        apiUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test', summaryRetryCount: 0,
        ...overrides,
    });
    return { h, ctx, memory: ctx.chatMetadata.tiandao_memory };
}
function appendLiveRound(h, ctx, round, data = null) {
    const block = data ? '<details data-suwei-state="1"><summary>溯微状态</summary><suwei_state>' + JSON.stringify(data) + '</suwei_state></details>' : '';
    ctx.chat.push({ is_user: true, mes: '问题' + round }, { is_user: false, mes: '剧情' + round + block });
    h.api.invalidateRoundIndexCache(ctx.chat);
}
function stateResponse(changes, baseRound = 0) {
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ version: 1, baseRound, changes }) } }] }), { headers: { 'Content-Type': 'application/json' } });
}

test('independent state updates combine the fifth reply with a five-round L0 into five requests', async t => {
    const { h, ctx, memory } = liveModeHarness('independent');
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(options.body); bodies.push(body);
        const round = ctx.chat.length / 2;
        if (body.messages[0].content.includes('l0_summary')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            l0_summary: '旅人走到第' + round + '处营地。', keywords: [], stateUpdate: { version: 1, baseRound: round - 1, changes: { time: '时间' + round, characters: { 旅人: { location: '营地' + round } } } },
        }) } }] }));
        const baseRound = Number(body.messages[0].content.match(/baseRound 必须为 (\d+)/)?.[1]);
        return stateResponse({ time: '时间' + round, characters: { 旅人: { location: '营地' + round } } }, baseRound);
    });
    for (let round = 1; round <= 5; round++) {
        appendLiveRound(h, ctx, round);
        await h.api.enqueueLiveStateUpdates(ctx.chat, ctx.chat.length - 1);
        assert.equal(engine.getStateLedgerCursor(memory).round, round, h.messages.at(-1));
        assert.equal(memory.stateLedger.characters.旅人.location, '营地' + round);
        assert.equal(memory.lastProcessedRound, round === 5 ? 5 : 0);
    }
    assert.equal(bodies.length, 5);
    assert.equal(bodies.filter(body => body.messages[0].content.includes('l0_summary')).length, 1);
    assert.equal(memory.archivePool.length, 1);
    assert.equal(memory.archivePool[0].roundRange, '1-5');
    appendLiveRound(h, ctx, 6);
    await h.api.enqueueLiveStateUpdates(ctx.chat, 11);
    assert.equal(bodies.length, 6);
    assert.equal(memory.lastProcessedRound, 5);
    assert.equal(h.api.getLedgerFreshness(memory).snapshotRound, 6);
    assert.equal(h.api.getLedgerFreshness(memory).stale, false);
});

test('main-response state uses no independent requests and L0 remains a separate five-round archive', async t => {
    const { h, ctx, memory } = liveModeHarness('main_response');
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        assert.match(body.messages[0].content, /不要返回或更新人物状态账本/);
        assert.doesNotMatch(body.messages[1].content, /suwei_state|inventoryAdd/);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"l0_summary":"旅人完成五处营地的行程。","keywords":[]}' } }] }));
    });
    for (let round = 1; round <= 5; round++) {
        appendLiveRound(h, ctx, round, { version: 1, baseRound: round - 1, changes: { characters: { 旅人: { location: '营地' + round } } } });
        await h.api.enqueueLiveStateUpdates(ctx.chat, ctx.chat.length - 1);
        assert.equal(engine.getStateLedgerCursor(memory).round, round, h.messages.at(-1));
        assert.equal(requests.length, 0);
    }
    const groupTurns = Array.from({ length: 5 }, (_, i) => ({ idx: i * 2 + 1 }));
    assert.equal(await h.api.processSingleAiTurn(9, false, { groupTurns }), true);
    assert.equal(requests.length, 1);
    assert.equal(memory.lastProcessedRound, 5);
    assert.equal(memory.stateLedger.characters.旅人.location, '营地5');
    assert.equal(engine.getStateLedgerCursor(memory).round, 5);
});

test('main-response failures keep the old snapshot and never fall back to paid state calls', async t => {
    const { h, ctx, memory } = liveModeHarness('main_response', { autoSummarizePerTurn: false });
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('不得偷偷调用独立 API'); });
    appendLiveRound(h, ctx, 1);
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    assert.equal(engine.getStateLedgerCursor(memory).round, 0);
    assert.equal(memory.stateLedger.characters.旅人.location, '城门');
    assert.match(memory.stateSync.lastError.message, /主模型未返回完整状态区块/);
    assert.match(h.api.buildLedgerHtml(memory), /重新读取正文状态（不调用 API）/);
    ctx.chat[1].mes += '<suwei_state>{"version":1,"baseRound":0,"changes":{"characters":{"旅人":{"location":"码头"}}}}</suwei_state>';
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1, { allowSummary: false });
    assert.equal(engine.getStateLedgerCursor(memory).round, 1);
    assert.equal(memory.stateLedger.characters.旅人.location, '码头');
    assert.equal(memory.stateSync.lastError, null);
    assert.equal(fetch.mock.callCount(), 0);
});

test('a failed live-state save retries the generated result without another model call', async t => {
    const { h, ctx, memory } = liveModeHarness('independent', { autoSummarizePerTurn: false });
    const fetch = t.mock.method(globalThis, 'fetch', async () => stateResponse({ characters: { 旅人: { location: '码头' } } }));
    appendLiveRound(h, ctx, 1);
    ctx.saveMetadata = async () => { throw Error('disk full'); };
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(engine.getStateLedgerCursor(memory).round, 0);
    assert.equal(memory.stateLedger.characters.旅人.location, '城门');
    assert.equal(h.api.getPendingSummarySave().kind, 'state');
    ctx.saveMetadata = async () => {};
    assert.equal(await h.api.retryPendingSummarySave(), true);
    assert.equal(engine.getStateLedgerCursor(memory).round, 1);
    assert.equal(memory.stateLedger.characters.旅人.location, '码头');
    assert.equal(fetch.mock.callCount(), 1);
});

for (const sourceChange of ['reopen', 'edited reply', 'changed baseline']) {
    test('a failed live-state save while switching chats handles ' + sourceChange, async t => {
        const { h, ctx, memory } = liveModeHarness('independent', { autoSummarizePerTurn: false });
        const fetch = t.mock.method(globalThis, 'fetch', async () => stateResponse({ characters: { 旅人: { location: '码头' } } }));
        appendLiveRound(h, ctx, 1);
        const savedChat = structuredClone(ctx.chat);
        const savedMetadata = structuredClone(ctx.chatMetadata);
        let startSave, rejectSave;
        const started = new Promise(resolve => { startSave = resolve; });
        ctx.saveMetadata = () => new Promise((_resolve, reject) => { rejectSave = reject; startSave(); });
        let fallbackSaves = 0;
        ctx.saveChat = async () => { fallbackSaves++; };
        const work = h.api.enqueueLiveStateUpdates(ctx.chat, 1);
        await started;
        assert.equal(engine.getStateLedgerCursor(memory).round, 1);
        const next = makeContext(ctx.chatId);
        next.characterId = 1; // Filenames can coincide across different characters.
        // The host reuses its chat array but loads a fresh metadata object on every switch.
        ctx.chat.splice(0, ctx.chat.length, ...next.chat);
        next.chat = ctx.chat;
        h.switchTo(next);
        h.api.invalidateActiveSummaryWork('切换聊天');
        const messageCount = h.messages.length;
        rejectSave(Error('offline'));
        await work;
        assert.equal(memory.stateLedger.characters.旅人.location, '城门');
        assert.equal(engine.getStateLedgerCursor(memory).round, 0);
        assert.equal(h.api.getPendingSummarySave(), null);
        assert.equal(next.chatMetadata.tiandao_memory.stateSync, null);
        assert.equal(fallbackSaves, 0);
        assert.equal(h.messages.length, messageCount);

        const reopened = { ...ctx, saveMetadata: async () => {}, chatMetadata: savedMetadata };
        reopened.getCurrentChatId = () => reopened.chatId;
        reopened.chat.splice(0, reopened.chat.length, ...savedChat);
        h.switchTo(reopened);
        const reopenedMemory = reopened.chatMetadata.tiandao_memory;
        if (sourceChange === 'edited reply') reopened.chat[1].mes = '已编辑的旧回复。';
        if (sourceChange === 'changed baseline') reopenedMemory.stateLedger.time = '已手动修改';
        if (sourceChange !== 'reopen') {
            assert.equal(h.api.getPendingSummarySave(), null);
            assert.equal(engine.getStateLedgerCursor(reopenedMemory).round, 0);
        } else {
            const newerArchive = { id: 'independent-archive', level: 0, roundRange: '1', startMessageId: 0, endMessageId: 1, text: '已单独保存的剧情' };
            reopenedMemory.archivePool.push(newerArchive);
            // This archive was saved independently of the live-state cursor while the draft was pending.
            reopenedMemory.stateSync = structuredClone(memory.stateSync);
            reopenedMemory.lastSummaryError = { message: '旧剧情归档待处理' };
            assert.equal(h.api.getPendingSummarySave()?.kind, 'state');
            assert.equal(await h.api.retryPendingSummarySave(), true);
            assert.equal(engine.getStateLedgerCursor(reopenedMemory).round, 1);
            assert.equal(reopenedMemory.stateLedger.characters.旅人.location, '码头');
            assert.equal(reopenedMemory.archivePool[0].text, newerArchive.text);
            assert.equal(reopenedMemory.lastSummaryError.message, '旧剧情归档待处理');
        }
        assert.equal(fetch.mock.callCount(), 1);
    });
}

test('an edit during a failed live-state save discards the draft and restores the prior cursor', async t => {
    const { h, ctx, memory } = liveModeHarness('independent', { autoSummarizePerTurn: false });
    const fetch = t.mock.method(globalThis, 'fetch', async () => stateResponse({ time: '午后' }));
    appendLiveRound(h, ctx, 1);
    let startSave, rejectSave;
    const started = new Promise(resolve => { startSave = resolve; });
    ctx.saveMetadata = () => new Promise((_resolve, reject) => { rejectSave = reject; startSave(); });
    const job = h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    await started;
    ctx.chat[1].mes = '原文已修改。';
    h.api.invalidateActiveSummaryWork('消息已编辑');
    rejectSave(Error('disk full'));
    await job;
    assert.equal(engine.getStateLedgerCursor(memory).round, 0);
    assert.equal(memory.stateLedger.time, '清晨');
    assert.equal(h.api.getPendingSummarySave(), null);
    assert.equal(fetch.mock.callCount(), 1);
});

test('state results from an edited reply or a changed mode cannot land after an async request', async t => {
    for (const changeMode of [false, true]) {
        const { h, ctx, memory } = liveModeHarness('independent', { autoSummarizePerTurn: false });
        appendLiveRound(h, ctx, 1);
        let started, resolveResponse;
        const begin = new Promise(resolve => { started = resolve; });
        const mock = t.mock.method(globalThis, 'fetch', async () => { started(); return new Promise(resolve => { resolveResponse = resolve; }); });
        const job = h.api.enqueueLiveStateUpdates(ctx.chat, 1);
        await begin;
        if (changeMode) ctx.extensionSettings['tiandao-memory-engine'].stateUpdateMode = 'with_summary';
        else ctx.chat[1].mes = '这条回复已经被编辑。';
        resolveResponse(stateResponse({ characters: { 旅人: { location: '错误旧结果' } } }));
        await job;
        assert.equal(engine.getStateLedgerCursor(memory).round, 0);
        assert.equal(memory.stateLedger.characters.旅人.location, '城门');
        mock.mock.restore();
    }
});

test('continuing a main-model reply replaces its prior state effects from the same baseline', async t => {
    const { h, ctx, memory } = liveModeHarness('main_response', { autoSummarizePerTurn: false });
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('正文模式不能调用状态 API'); });
    appendLiveRound(h, ctx, 1, { version: 1, baseRound: 0, changes: { characters: { 旅人: { location: '旧码头' } } } });
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    ctx.chat[1].mes += '旅人继续走到新码头。<suwei_state>{"version":1,"baseRound":0,"changes":{"characters":{"旅人":{"location":"新码头"}}}}</suwei_state>';
    h.api.invalidateRoundIndexCache(ctx.chat);
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    assert.equal(engine.getStateLedgerCursor(memory).round, 1);
    assert.equal(memory.stateLedger.characters.旅人.location, '新码头');
    assert.equal(memory.stateSync.entries.length, 1);
    assert.equal(fetch.mock.callCount(), 0);
});

test('independent state syncing works in manual-L0 mode without creating an L0 entry', async t => {
    const { h, ctx, memory } = liveModeHarness('independent', { l0MergeMode: 'manual', autoSummarizePerTurn: false });
    const fetch = t.mock.method(globalThis, 'fetch', async () => stateResponse({ time: '正午' }));
    appendLiveRound(h, ctx, 1);
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(memory.archivePool.length, 0);
    assert.equal(engine.getStateLedgerCursor(memory).round, 1);
    assert.equal(memory.stateLedger.time, '正午');
});

test('state extraction respects outgoing host regex before calling the independent API', async t => {
    const { h, ctx, memory } = liveModeHarness('independent', { autoSummarizePerTurn: false });
    appendLiveRound(h, ctx, 1);
    ctx.chat[0].mes += '<options>用户禁发选项</options>';
    ctx.chat[1].mes += '<options>回复禁发选项</options>';
    ctx.getRegexedString = text => text.replace(/<options>[\s\S]*?<\/options>/g, '');
    let body;
    t.mock.method(globalThis, 'fetch', async (_url, options) => { body = JSON.parse(options.body); return stateResponse({ time: '午后' }); });
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    assert.doesNotMatch(JSON.stringify(body), /禁发选项|<options>/);
    assert.equal(memory.stateLedger.time, '午后');
});

test('mode changes do not run or erase earlier state records', async t => {
    const { h, ctx, memory } = liveModeHarness('main_response', { autoSummarizePerTurn: false });
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('切换模式不调用 API'); });
    appendLiveRound(h, ctx, 1, { version: 1, baseRound: 0, changes: { time: '午后' } });
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    ctx.extensionSettings['tiandao-memory-engine'].stateUpdateMode = 'with_summary';
    assert.equal(h.api.enqueueLiveStateUpdates(ctx.chat, 1), null);
    assert.equal(engine.getStateLedgerCursor(memory).round, 1);
    assert.equal(memory.stateLedger.time, '午后');
    ctx.extensionSettings['tiandao-memory-engine'].stateUpdateMode = 'independent';
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    assert.equal(fetch.mock.callCount(), 0);
});

test('re-summarizing an old group leaves newer live state intact and timestamps the replacement correctly', async t => {
    const { h, ctx, memory } = liveModeHarness('main_response', { autoSummarizePerTurn: false });
    for (let round = 1; round <= 8; round++) {
        appendLiveRound(h, ctx, round, { version: 1, baseRound: round - 1, changes: { characters: { 旅人: { location: '营地' + round } } } });
        await h.api.enqueueLiveStateUpdates(ctx.chat, ctx.chat.length - 1);
    }
    const entry = { id: 'group-old', level: 0, roundRange: '1-5', startMessageId: 0, endMessageId: 9,
        text: '旧剧情摘要', postStateSnapshot: engine.getStateLedgerAtMessage(memory, 9).ledger, stateMessageId: 9, stateRound: 5 };
    memory.archivePool = [entry]; memory.levels[0] = [entry]; memory.lastProcessedRound = 5; memory.lastProcessedMessageId = 9;
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"l0_summary":"旅人走过五处营地。","keywords":[],"stateLedger":{"time":"错误旧状态"}}' } }] })));
    const group = Array.from({ length: 5 }, (_, i) => ({ idx: i * 2 + 1, round: i + 1, msg: ctx.chat[i * 2 + 1] }));
    assert.equal(await h.api.resummarizeRoundInPlace(ctx.extensionSettings['tiandao-memory-engine'], ctx, ctx.chat, 9, memory, 'a', 0, null, null, group), true);
    assert.equal(memory.stateLedger.characters.旅人.location, '营地8');
    assert.equal(engine.getStateLedgerCursor(memory).round, 8);
    assert.equal(memory.archivePool[0].stateRound, 5);
    assert.equal(engine.resolveStateLedgerAfterEntry(memory, memory.archivePool[0]).characters.旅人.location, '营地5');
});

test('switching chats while a state request is pending cannot write into either new chat state', async t => {
    const { h, ctx, memory } = liveModeHarness('independent', { autoSummarizePerTurn: false });
    appendLiveRound(h, ctx, 1);
    let begin, finish;
    const started = new Promise(resolve => { begin = resolve; });
    t.mock.method(globalThis, 'fetch', async () => { begin(); return new Promise(resolve => { finish = resolve; }); });
    const job = h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    await started;
    const next = makeContext('other-chat');
    h.switchTo(next);
    finish(stateResponse({ time: '错误旧结果' }));
    await job;
    assert.equal(memory.stateLedger.time, '清晨');
    assert.equal(engine.getStateLedgerCursor(memory).round, 0);
    assert.equal(next.chatMetadata.tiandao_memory.stateLedger.time, '清晨');
    assert.equal(next.chatMetadata.tiandao_memory.stateSync, null);
});

for (const [enabled, type] of [[false, 'normal'], [false, 'quiet'], [true, 'quiet']]) {
    test('state metadata is filtered even when enabled=' + enabled + ' and generation=' + type, async t => {
        const h = harness(), ctx = h.current();
        ctx.extensionSettings['tiandao-memory-engine'].enabled = enabled;
        const state = '<details data-suwei-state="1"><summary>溯微状态</summary><suwei_state>{"version":1,"baseRound":0,"changes":{"time":"夜晚"}}</suwei_state></details>';
        ctx.chat[0].mes = '玩家引用原样保留：' + state;
        ctx.chat[1].mes = '  角色正文  ' + state;
        ctx.chat[1].extra = { media: [{ url: '/fixture.png' }], reasoning_signature: 'fixture' };
        const before = JSON.stringify(ctx.chat);
        const core = ctx.chat.slice();
        const calls = t.mock.method(globalThis, 'fetch', () => { throw Error('此路径不能调用 API'); });
        let aborted = false;
        await h.api.interceptor(core, 10000, () => { aborted = true; }, type);
        assert.equal(aborted, false);
        assert.equal(core[0], ctx.chat[0]);
        assert.equal(core[1].mes, '角色正文');
        assert.equal(core[1].extra, ctx.chat[1].extra);
        assert.equal(JSON.stringify(ctx.chat), before);
        assert.equal(ctx.injected, '');
        assert.equal(calls.mock.callCount(), 0);
    });
}

test('main-response state cannot drop a newer saved round by naming an older baseline', async t => {
    const { h, ctx, memory } = liveModeHarness('main_response', { autoSummarizePerTurn: false });
    const calls = t.mock.method(globalThis, 'fetch', () => { throw Error('不能付费补跑'); });
    appendLiveRound(h, ctx, 1, { version: 1, baseRound: 0, changes: { characters: { 旅人: { inventoryAdd: ['铜钥匙'] } } } });
    await h.api.enqueueLiveStateUpdates(ctx.chat, 1);
    const before = JSON.stringify(memory.stateLedger);
    appendLiveRound(h, ctx, 2, { version: 1, baseRound: 0, changes: { time: '傍晚' } });
    await h.api.enqueueLiveStateUpdates(ctx.chat, 3);
    assert.equal(engine.getStateLedgerCursor(memory).round, 1);
    assert.equal(JSON.stringify(memory.stateLedger), before);
    assert.match(memory.stateSync.lastError.message, /基准轮次/);
    assert.equal(calls.mock.callCount(), 0);
});

for (const [enabled, type] of [[false, 'normal'], [true, 'normal'], [true, 'quiet']]) {
    test('flattened machine JSON is removed from the actual ' + type + ' send, enabled=' + enabled, async () => {
        const h = harness(), ctx = h.current();
        Object.assign(ctx.extensionSettings['tiandao-memory-engine'], { enabled, autoSummarizePerTurn: false });
        ctx.getRegexedString = () => { throw Error('不能二次应用宿主正则'); };
        ctx.chat[1].mes = '保留剧情。<options>不要发送</options><details data-suwei-state="1"><summary>溯微状态</summary><suwei_state>{"version":1,"baseRound":0,"changes":{"time":"夜晚"}}</suwei_state></details>';
        const before = JSON.stringify(ctx.chat);
        const core = ctx.chat.map((message, index) => ({ ...message, index,
            mes: message.mes.replace(/<options>[\s\S]*?<\/options>/g, '').replace(/<[^>]*>/g, '') }));
        let aborted = false;
        await h.api.interceptor(core, 10000, () => { aborted = true; }, type);
        assert.equal(aborted, false);
        assert.equal(core.find(message => message.index === 1).mes, '保留剧情。');
        assert.equal(JSON.stringify(ctx.chat), before);
    });
}

test("character growth renders inside the existing card with escaped facts and source rounds", () => {
    const h = harness();
    const memory = h.current().chatMetadata.tiandao_memory;
    memory.stateLedger.characters.旅人.inventory = ["铜钥匙"];
    memory.stateLedger.characters.旅人.growth = [{
        key: "对导师的判断", dimension: "relationship", target: "导师", state: '<img src=x onerror="bad()">先核实命令',
        evidence: "明确要求先查卷宗 & 再行动", sourceRound: 7,
    }];
    const html = h.api.buildLedgerHtml(memory);
    assert.match(html, /<details class="tiandao-char-growth"><summary>长期成长 · 1 项<\/summary>/);
    assert.match(html, /关系与信任 · 导师/);
    assert.match(html, /第 7 轮确认/);
    assert.match(html, /&lt;img/);
    assert.match(html, /&amp; 再行动/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /随身道具/);
    assert.match(html, /铜钥匙/);
});

test("a revealed name is displayed while card actions keep their stable storage key", () => {
 const h=harness();const memory=h.current().chatMetadata.tiandao_memory;
 memory.stateLedger.characters={戴面具的引路人:{canonicalName:'沈舟',aliases:[],inventory:['铜钥匙']}};
 const html=h.api.buildLedgerHtml(memory);
 assert.match(html,/<span class="tiandao-char-name">沈舟<\/span>/);
 assert.match(html,/data-char-name="戴面具的引路人"/);
 assert.match(html,/data-char-toggle="戴面具的引路人"/);
 assert.match(html,/别名\/称号: 戴面具的引路人/);
});

test("manual todo completion uses the state round when narrative summaries lag behind", async () => {
 const h=harness();const memory=h.current().chatMetadata.tiandao_memory;
 memory.stateSync={version:1,base:{endMessageId:19,round:10,ledger:structuredClone(memory.stateLedger)},entries:[],lastError:null};
 memory.stateLedger.todosAndPromises=[{id:'live-promise',text:'归还铜钥匙',completed:false}];
 await h.api.updateTodoCompletion('live-promise',true);
 assert.equal(memory.stateLedger.todosAndPromises[0].completedRound,10);
 const same=engine.applyStateChanges(memory.stateLedger,{version:1,baseRound:10,changes:{}},10);
 assert.equal(same.todosAndPromises[0].completed,true);
 const next=engine.applyStateChanges(same,{version:1,baseRound:10,changes:{}},11);
 assert.deepEqual(next.todosAndPromises,[]);
});


for (const change of ['none', 'reply', 'ledger', 'owner']) {
    test('unsaved narrative draft survives metadata reload only for the same source and baseline: ' + change, async t => {
        const h = harness(), calls = mockSummary(t, h), original = h.current();
        const persisted = structuredClone(original.chatMetadata);
        original.saveMetadata = async () => { throw Error('offline'); };
        await h.api.processSingleAiTurn(1);
        assert.ok(h.api.getPendingSummarySave()); assert.equal(calls(), 1);
        h.switchTo(makeContext('elsewhere'));
        h.api.invalidateActiveSummaryWork('switch');
        const reopened = { ...original, chat: structuredClone(original.chat), chatMetadata: persisted, saveMetadata: async () => {} };
        if (change === 'reply') reopened.chat[1].mes = '修改后的最终回复';
        if (change === 'ledger') reopened.chatMetadata.tiandao_memory.stateLedger.time = '手动修订的时间';
        if (change === 'owner') reopened.characterId = 1;
        h.switchTo(reopened);
        const pending = h.api.getPendingSummarySave();
        if (change === 'none') {
            assert.ok(pending);
            assert.equal(await h.api.retryPendingSummarySave(), true);
            assert.equal(reopened.chatMetadata.tiandao_memory.archivePool.length, 1);
            assert.equal(calls(), 1);
        } else {
            assert.equal(pending, null);
            assert.equal(reopened.chatMetadata.tiandao_memory.archivePool.length, 0);
        }
    });
}

test('a narrative draft survives a failed save after the host reuses the chat array for another chat', async t => {
    const h = harness(), calls = mockSummary(t, h), original = h.current();
    const savedChat = structuredClone(original.chat), savedMetadata = structuredClone(original.chatMetadata);
    let startSave, rejectSave;
    const started = new Promise(resolve => { startSave = resolve; });
    original.saveMetadata = () => new Promise((_resolve, reject) => { rejectSave = reject; startSave(); });
    const work = h.api.processSingleAiTurn(1); await started;
    const next = makeContext(original.chatId); next.characterId = 1;
    original.chat.splice(0, original.chat.length, ...next.chat); next.chat = original.chat;
    h.switchTo(next); h.api.invalidateActiveSummaryWork('switch');
    rejectSave(Error('offline')); await work;
    assert.equal(original.chatMetadata.tiandao_memory.archivePool.length, 0);
    assert.equal(h.api.getPendingSummarySave(), null);
    original.chat.splice(0, original.chat.length, ...savedChat);
    h.switchTo({ ...original, chatMetadata: savedMetadata, saveMetadata: async () => {} });
    assert.ok(h.api.getPendingSummarySave());
    assert.equal(await h.api.retryPendingSummarySave(), true);
    assert.equal(calls(), 1);
    assert.equal(h.current().chatMetadata.tiandao_memory.archivePool.length, 1);
});

for (const includeNativeHidden of [false, true]) {
    test('automatic summary obeys player visibility and retains every visible consecutive input: ' + includeNativeHidden, async t => {
        const h = harness(), prompts = [];
        const ctx = h.current();
        Object.assign(ctx.extensionSettings['tiandao-memory-engine'], { apiUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'mock', includeNativeHidden });
        ctx.chat = [
            { is_user: true, mes: '早先的玩家事实' },
            { is_user: true, is_system: true, mes: '隐藏的玩家事实' },
            { is_user: true, mes: '后续的玩家事实' },
            { is_user: false, mes: '角色的最终答复' },
        ];
        t.mock.method(globalThis, 'fetch', async (_url, options) => {
            prompts.push(JSON.parse(options.body));
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ l0_summary: '守卫收到铜钥匙。', keywords: [], stateLedger: {} }) } }] }), { headers: { 'Content-Type': 'application/json' } });
        });
        assert.equal(await h.api.processSingleAiTurn(3), true);
        const text = prompts[0].messages.map(message => message.content).join('\n');
        assert.match(text, /早先的玩家事实/); assert.match(text, /后续的玩家事实/);
        assert.equal(text.includes('隐藏的玩家事实'), includeNativeHidden);
    });
}


test('history scan retains a failed batch across metadata reload and retries saving without another API call', async t => {
    const h = harness(), calls = mockSummary(t, h), ctx = h.current();
    const persisted = structuredClone(ctx.chatMetadata);
    ctx.saveMetadata = async () => { throw Error('disk full'); };
    await h.api.scanChatHistory({ innerHTML: '' });
    assert.equal(calls(), 1); assert.ok(h.api.getPendingSummarySave());
    assert.equal(ctx.chatMetadata.tiandao_memory.archivePool.length, 0);
    assert.equal(ctx.chatMetadata.tiandao_memory.lastProcessedMessageId, -1);
    h.switchTo(makeContext('elsewhere')); h.api.invalidateActiveSummaryWork('switch');
    const reopened = { ...ctx, chat: structuredClone(ctx.chat), chatMetadata: persisted, saveMetadata: async () => {} };
    h.switchTo(reopened);
    assert.ok(h.api.getPendingSummarySave());
    await h.api.scanChatHistory({ innerHTML: '' });
    assert.equal(calls(), 1); assert.equal(h.api.getPendingSummarySave(), null);
    assert.equal(reopened.chatMetadata.tiandao_memory.archivePool.length, 1);
    assert.equal(reopened.chatMetadata.tiandao_memory.lastProcessedMessageId, 1);
});

test('a preview failure after a successful history save does not roll back or regenerate its archive', async t => {
    const h = harness(), calls = mockSummary(t, h), ctx = h.current();
    let saves = 0; ctx.saveMetadata = async () => { saves++; };
    ctx.setExtensionPrompt = () => { throw Error('preview unavailable'); };
    await h.api.scanChatHistory({ innerHTML: '' });
    assert.equal(saves, 1); assert.equal(calls(), 1);
    assert.equal(h.api.getPendingSummarySave(), null);
    assert.equal(ctx.chatMetadata.tiandao_memory.archivePool.length, 1);
});

test('a failed history save after a chat switch keeps the old draft away from the new owner', async t => {
    const h = harness(), calls = mockSummary(t, h), original = h.current();
    const savedChat = structuredClone(original.chat), savedMetadata = structuredClone(original.chatMetadata);
    let startSave, rejectSave;
    const started = new Promise(resolve => { startSave = resolve; });
    original.saveMetadata = () => new Promise((_resolve, reject) => { rejectSave = reject; startSave(); });
    const work = h.api.scanChatHistory({ innerHTML: '' }); await started;
    const next = makeContext(original.chatId); next.characterId = 1;
    next.chat[1].mes = '另一个人物的回复';
    original.chat.splice(0, original.chat.length, ...next.chat); next.chat = original.chat;
    let nextSaves = 0; next.saveMetadata = async () => { nextSaves++; };
    h.switchTo(next); h.api.invalidateActiveSummaryWork('switch');
    rejectSave(Error('offline')); await work;
    assert.equal(original.chatMetadata.tiandao_memory.archivePool.length, 0);
    assert.equal(next.chatMetadata.tiandao_memory.archivePool.length, 0);
    assert.equal(nextSaves, 0); assert.equal(h.api.getPendingSummarySave(), null);
    original.chat.splice(0, original.chat.length, ...savedChat);
    h.switchTo({ ...original, chatMetadata: savedMetadata, saveMetadata: async () => {} });
    assert.ok(h.api.getPendingSummarySave());
    assert.equal(await h.api.retryPendingSummarySave(), true);
    assert.equal(calls(), 1);
});


test('a native edit during a failed draft save cannot resurrect invalidated narrative archives', async t => {
    const h = harness(), calls = mockSummary(t, h), ctx = h.current();
    const memory = ctx.chatMetadata.tiandao_memory;
    await h.api.processSingleAiTurn(1);
    ctx.chat.push({ is_user: true, mes: '第二轮玩家' }, { is_user: false, mes: '第二轮回复' });
    ctx.saveMetadata = async () => { throw Error('offline'); };
    await h.api.processSingleAiTurn(3);
    assert.equal(memory.archivePool.length, 1); assert.ok(h.api.getPendingSummarySave());
    let startSave, rejectSave;
    const started = new Promise(resolve => { startSave = resolve; });
    ctx.saveMetadata = () => new Promise((_resolve, reject) => { rejectSave = reject; startSave(); });
    const retry = h.api.retryPendingSummarySave(); await started;
    ctx.chat[0].mes = '第一轮已改写'; h.api.invalidateActiveSummaryWork('edited');
    engine.rollbackMemoryFromMessageIndex(memory, 0);
    rejectSave(Error('offline')); await retry;
    assert.equal(memory.archivePool.length, 0); assert.equal(memory.lastProcessedMessageId, -1);
    assert.equal(h.api.getPendingSummarySave(), null); assert.equal(calls(), 2);
});


test('retrying an old scan save cannot begin scanning a different chat selected during the save', async t => {
    const h = harness(), calls = mockSummary(t, h), original = h.current();
    original.saveMetadata = async () => { throw Error('offline'); };
    await h.api.scanChatHistory({ innerHTML: '' });
    assert.ok(h.api.getPendingSummarySave()); assert.equal(calls(), 1);
    const next = makeContext('new-chat');
    next.extensionSettings = original.extensionSettings;
    original.saveMetadata = async () => { h.switchTo(next); h.api.invalidateActiveSummaryWork('switch'); };
    await h.api.scanChatHistory({ innerHTML: '' });
    assert.equal(calls(), 1); assert.equal(next.chatMetadata.tiandao_memory.archivePool.length, 0);
});


test('automatic archive retries cannot move on to another chat selected during the save', async t => {
    const h = harness(), calls = mockSummary(t, h), original = h.current();
    original.saveMetadata = async () => { throw Error('offline'); };
    await h.api.processSingleAiTurn(1);
    const next = makeContext('new-chat'); next.extensionSettings = original.extensionSettings;
    original.saveMetadata = async () => { h.switchTo(next); h.api.invalidateActiveSummaryWork('switch'); };
    assert.equal(await h.api.processSingleAiTurn(1), false);
    assert.equal(calls(), 1); assert.equal(next.chatMetadata.tiandao_memory.archivePool.length, 0);
});
