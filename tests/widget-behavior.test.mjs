import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import * as engine from "../memory-engine.js";
import * as recovery from "../recovery-store.js";
import * as history from "../history-builder.js";
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
        ...engine, ...recovery, ...history, createSummaryTaskGate,
        window: {}, SillyTavern: { getContext: () => current },
        document: { getElementById: id => nodes.get(id) || null },
        FileReader: Reader, confirm: () => true, console,
        setTimeout, clearTimeout, AbortController, Map, Set, WeakMap, WeakSet,
    });
    scope.messages = messages;
    scope.renderTimeline = renderTimeline;
    vm.runInContext(source + '\nconst nativeSyncHidden = syncHiddenMessagesState; updateFloatingWidgetUI = () => { if (renderTimeline) renderStoryTimeline(); }; renderRecoveryPoints = () => {}; if (!renderTimeline) renderStoryTimeline = () => {}; syncHiddenMessagesState = () => {}; updateStatusBar = text => messages.push(text); globalThis.api = { processSingleAiTurn, refreshPromptInjection, retryPendingSummarySave, getPendingSummarySave, recoverPendingSummaries, renderStoryRecoveryState, invalidateActiveSummaryWork, syncLegacyHidden: nativeSyncHidden, interceptor: globalThis.tiandaoMemoryInterceptor, requestSummaryTaskStop, checkpointBeforeChange, importMemoryJsonFile, restoreSelectedRecovery, buildTimelineHtml, updateTodoCompletion, deleteLedgerItem, memoryOperationBusy, clearCurrentChatMemory, saveStoryEntry: window.tiandaoSaveStoryEntry, preview: () => lastInjectionPreview, setScope: value => {storyMemoryScope=value}, setSearch: value => {storySearchQuery=value} };', scope);
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
