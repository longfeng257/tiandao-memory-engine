import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as backup from "../memory-backup.js";
import * as engine from "../memory-engine.js";
import * as recovery from "../recovery-store.js";
import * as hostPersistence from "../host-persistence.js";
import { createSummaryTaskGate } from "../task-gate.js";

const RECOVERY_KEY = "suwei_memory_recovery_v1";
const source = (await readFile(new URL("../index.js", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .split("(async function initTiandaoMemoryExtension()")[0];
const makeChat = (reply = "门开了") => [{ is_user: true, mes: "拿出钥匙" }, { is_user: false, mes: reply }];
const makeMemory = (time = "清晨") => {
    const memory = engine.createEmptyMemoryData();
    memory.stateLedger.time = time;
    return memory;
};
const makeEntry = () => ({ level: 0, id: "entry", text: "门开了", roundRange: "1", startMessageId: 0, endMessageId: 1 });

function makeHarness({ readsThrow = false, readbackUnavailable = false } = {}) {
    function makeContext(chatId = "test") {
        return {
            chatId, characterId: 0, characters: [{ avatar: "test.png" }],
            chat: makeChat(), name1: "旅人", name2: "守卫",
            chatMetadata: { tiandao_memory: makeMemory() },
            getRequestHeaders: () => ({ "X-CSRF-Token": "stub" }),
        };
    }

    let ctx = makeContext();
    const saves = [], readbacks = [], confirmations = [], statuses = [], readers = [], downloads = [];
    const nodes = new Map([["tiandao_recovery_select", { value: "" }]]);
    let decide = () => true;
    let persist = () => true;
    let refresh = () => {};
    const persisted = new Map();
    const startIn = value => {
        ctx = value;
        value.saveMetadata = async () => {
            const candidate = JSON.parse(JSON.stringify(value.chatMetadata));
            saves.push(candidate);
            if (!await persist(candidate)) return false;
            persisted.set(value.chatId, candidate);
            return true;
        };
        return ctx;
    };
    startIn(ctx);
    class Reader {
        constructor() { readers.push(this); }
        readAsText() { if (readsThrow) throw Error("read unavailable"); }
        load(result) { this.result = result; return this.onload(); }
    }
    const scope = vm.createContext({
        ...engine, ...recovery, ...backup, ...hostPersistence, createSummaryTaskGate, Blob, AbortController,
        window: {}, SillyTavern: { getContext: () => ctx },
        document: {
            getElementById: id => nodes.get(id) || null,
            createElement: tag => {
                assert.equal(tag, "a");
                return { click() { downloads.push({ name: this.download }); } };
            },
        },
        URL: {
            createObjectURL(blob) { scope.exportedBlob = blob; return "blob:stub"; },
            revokeObjectURL() {},
        },
        FileReader: Reader,
        confirm: message => { confirmations.push(message); return decide(message); },
        fetch: async (url, request) => {
            assert.equal(url, "/api/chats/get");
            readbacks.push(JSON.parse(request.body));
            if (readbackUnavailable) throw Error("readback unavailable");
            return { ok: true, json: async () => [{ chat_metadata: persisted.get(readbacks.at(-1).file_name) }] };
        },
        setTimeout: () => 1, clearTimeout() {}, console,
        statuses, preview: () => refresh(),
    });
    vm.runInContext(source + `
        updateStatusBar = (text, isError) => statuses.push({ text, isError: Boolean(isError) });
        renderRecoveryPoints = () => {};
        updateFloatingWidgetUI = () => {};
        renderStoryTimeline = () => {};
        refreshPromptInjection = async () => preview();
        globalThis.api = {
            checkpointBeforeChange, clearCurrentChatMemory, deleteLedgerItem, updateTodoCompletion, updateMemoryPin,
            exportMemoryJson, exportSelectedRecovery, importMemoryJsonFile, restoreSelectedRecovery,
            saveStoryEntry: window.tiandaoSaveStoryEntry, memoryOperationBusy, requestSummaryTaskStop,
            whenIdle: () => summaryQueue,
            testHierarchyBuild: build => { rebuildHierarchyLevelsFromL0 = build; },
        };
    `, scope);
    return {
        api: scope.api, saves, readbacks, confirmations, statuses, readers, nodes, downloads,
        context: () => ctx, alternateChat: makeContext, switchTo: startIn,
        setConfirm: callback => { decide = callback; }, setPersist: callback => { persist = callback; },
        setPreview: callback => { refresh = callback; },
        exportContents: async () => JSON.parse(await scope.exportedBlob.text()),
        async importText(text) { scope.api.importMemoryJsonFile({ size: Buffer.byteLength(text) }); await readers.at(-1).load(text); },
    };
}

function seedRecovery(ctx, chat = ctx.chat) {
    const point = recovery.createRecoveryPoint(makeMemory("凌晨"), chat, "既有备份", 100);
    ctx.chatMetadata[RECOVERY_KEY] = [point];
    return point;
}

test("versioned backups round trip with the export time and advisory chat signature", () => {
    const chatSignature = recovery.recoveryChatSignature(makeChat());
    const memory = makeMemory();
    const entry = { ...makeEntry(), postStateSnapshot: makeMemory("开门时").stateLedger, embedding: [1, 0], embeddingModel: "test", embeddingDimension: 2 };
    memory.levels[0].push(entry);
    memory.archivePool.push(entry);
    memory.stateSync = {
        version: 1, base: { round: 1, endMessageId: 1, ledger: memory.stateLedger }, lastError: null,
        entries: [{ round: 2, endMessageId: 3, postStateDelta: { t: "o", v: { time: { t: "v", v: "夜晚" } } } }],
    };
    engine.normalizeMemoryData(memory);
    const envelope = backup.createMemoryBackup(memory, chatSignature, 1_700_000_000_000);
    assert.equal(envelope.format, "suwei-memory");
    assert.equal(envelope.version, 1);
    assert.equal(envelope.exportedAt, 1_700_000_000_000);
    assert.equal(envelope.chatSignature, chatSignature);
    const text = JSON.stringify(envelope);
    const parsed = backup.parseMemoryBackup(text, chatSignature);
    assert.deepEqual(parsed, { memory, sourceVerified: true });
    assert.notEqual(parsed.memory.stateLedger, memory.stateLedger);
    assert.equal(backup.parseMemoryBackup(text, recovery.recoveryChatSignature(makeChat("门关上了"))).sourceVerified, false);
});

test("legacy bare memory keeps omitted defaults and remains source-unverified", () => {
    const text = '\uFEFF' + JSON.stringify({ version: 3, levels: { 0: [{ roundRange: "1", text: "旧归档" }] },
        stateLedger: { time: "夜晚", todosAndPromises: ["归还钥匙", { title: "守夜" }] } });
    const parsed = backup.parseMemoryBackup(text, "");
    assert.equal(parsed.sourceVerified, false);
    assert.equal(parsed.memory.version, 4);
    assert.equal(parsed.memory.levels[0][0].text, "旧归档");
    assert.deepEqual(parsed.memory.stateLedger.todosAndPromises.map(todo => todo.text), ["归还钥匙", "守夜"]);
});

test("malformed envelope, memory levels, ledger, archive and state changes are rejected", () => {
    const signature = recovery.recoveryChatSignature(makeChat());
    const valid = backup.createMemoryBackup(makeMemory(), signature, 100);
    const cases = [
        [{ ...valid, format: "other" }, /标识/],
        [{ ...valid, version: 2 }, /版本/],
        [{ ...valid, exportedAt: "yesterday" }, /导出时间/],
        [{ ...valid, chatSignature: [] }, /来源签名/],
        [{ ...valid, memory: [] }, /记忆数据/],
        [{ ...makeMemory(), levels: [] }, /levels/],
        [{ ...makeMemory(), levels: { 4: [] } }, /层级/],
        [{ ...makeMemory(), levels: { 0: "bad" } }, /levels\.0/],
        [{ ...makeMemory(), levels: { 0: [{ ...makeEntry(), text: {} }] } }, /text/],
        [{ ...makeMemory(), levels: { 0: [{ ...makeEntry(), roundRange: "2-1" }] } }, /roundRange/],
        [{ ...makeMemory(), stateLedger: [] }, /stateLedger/],
        [{ ...makeMemory(), stateLedger: { characters: { A: [] } } }, /characters/],
        [{ ...makeMemory(), stateLedger: { characters: { A: { inventory: [{}] } } } }, /inventory/],
        [{ ...makeMemory(), stateLedger: { todosAndPromises: [7] } }, /todosAndPromises/],
        [{ ...makeMemory(), archivePool: {} }, /archivePool/],
        [{ ...makeMemory(), archivePool: [{ ...makeEntry(), startMessageId: 3 }] }, /消息范围/],
        [{ ...makeMemory(), archivePool: [{ ...makeEntry(), embedding: ["1"] }] }, /embedding/],
        [{ ...makeMemory(), archivePool: [{ ...makeEntry(), postStateDelta: { t: "o", v: [] } }] }, /postStateDelta/],
        [{ ...makeMemory(), stateSync: { version: 1, base: { round: 0, endMessageId: -1, ledger: {} }, entries: [null] } }, /stateSync\.entries/],
    ];
    for (const [value, error] of cases) assert.throws(() => backup.parseMemoryBackup(JSON.stringify(value), signature), error);
});

test("import validation bounds nested data and aggregate entry count", () => {
    const invalid = [
        ['{"levels":{},"stateLedger":{"characters":{"__proto__":{}}}}', /不安全/],
        ['{"levels":{},"stateLedger":{},"lastProcessedRound":1e999}', /无效数字/],
        ['{"levels":{},"stateLedger":{},"unknown":' + '['.repeat(66) + '0' + ']'.repeat(66) + '}', /嵌套过深/],
        [JSON.stringify({ ...makeMemory(), levels: { 0: Array(50_000).fill(makeEntry()) }, archivePool: [makeEntry()] }), /50000/],
    ];
    for (const [text, error] of invalid) assert.throws(() => backup.parseMemoryBackup(text, ""), error);
});

test("invalid import never prompts, changes live metadata, or attempts persistence", async () => {
    const h = makeHarness();
    const ctx = h.context();
    seedRecovery(ctx);
    const previousMemory = ctx.chatMetadata.tiandao_memory;
    const previousPoints = ctx.chatMetadata[RECOVERY_KEY];
    await h.importText('{"levels":{"0":[null]},"stateLedger":{}}');
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.saves.length, 0);
    assert.equal(ctx.chatMetadata.tiandao_memory, previousMemory);
    assert.equal(ctx.chatMetadata[RECOVERY_KEY], previousPoints);
    assert.match(h.statuses.at(-1).text, /导入记忆数据失败/);
});

for (const legacy of [true, false]) {
    test(`${legacy ? "legacy" : "other branch"} imports must explicitly confirm unverified source`, async () => {
        const h = makeHarness();
        const memory = makeMemory("黄昏");
        const text = JSON.stringify(legacy ? memory : backup.createMemoryBackup(memory, recovery.recoveryChatSignature(makeChat("门关了"))));
        h.setConfirm(message => { assert.match(message, /来源未验证/); return false; });
        await h.importText(text);
        assert.equal(h.saves.length, 0);
        assert.equal(Object.hasOwn(h.context().chatMetadata, RECOVERY_KEY), false);
        h.setConfirm(message => { assert.match(message, /来源未验证/); return true; });
        await h.importText(text);
        assert.equal(h.saves.length, 1);
        assert.equal(h.context().chatMetadata.tiandao_memory.stateLedger.time, "黄昏");
        assert.equal(h.context().chatMetadata[RECOVERY_KEY].length, 1);
    });
}

test("current downloads sign current raw chat and recovery downloads keep the point signature", async () => {
    const h = makeHarness();
    const ctx = h.context();
    const point = seedRecovery(ctx, makeChat("另一个分支"));
    h.api.exportMemoryJson();
    const current = await h.exportContents();
    assert.equal(current.chatSignature, recovery.recoveryChatSignature(ctx.chat));
    assert.equal(current.memory.stateLedger.time, "清晨");
    h.nodes.get("tiandao_recovery_select").value = point.id;
    h.api.exportSelectedRecovery();
    const saved = await h.exportContents();
    assert.equal(saved.chatSignature, point.chatSignature);
    assert.notEqual(saved.chatSignature, current.chatSignature);
    assert.equal(saved.memory.stateLedger.time, "凌晨");
    assert.match(h.downloads.at(-1).name, /^suwei_backup_/);
});

test("file readers report errors, cancellation and synchronous read failure without saving", () => {
    const h = makeHarness();
    h.api.importMemoryJsonFile({ size: 100 });
    h.readers[0].error = Error("read unavailable");
    h.readers[0].onerror();
    assert.match(h.statuses.at(-1).text, /读取记忆文件失败/);
    h.api.importMemoryJsonFile({ size: 100 });
    h.readers[1].onabort();
    assert.match(h.statuses.at(-1).text, /已取消读取/);
    assert.equal(h.saves.length, 0);
    const unable = makeHarness({ readsThrow: true });
    unable.api.importMemoryJsonFile({ size: 100 });
    assert.match(unable.statuses.at(-1).text, /读取记忆文件失败/);
    unable.api.importMemoryJsonFile({ size: backup.MAX_IMPORT_FILE_BYTES + 1 });
    assert.match(unable.statuses.at(-1).text, /20MB/);
    assert.equal(unable.readers.length, 1);
    assert.equal(unable.saves.length, 0);
});

test("same-ID chat reload aborts a pending file import", async () => {
    const h = makeHarness();
    const old = h.context();
    h.api.importMemoryJsonFile({ size: 100 });
    const next = h.switchTo(h.alternateChat(old.chatId));
    await h.readers[0].load(JSON.stringify(makeMemory("傍晚")));
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.saves.length, 0);
    assert.equal(next.chatMetadata.tiandao_memory.stateLedger.time, "清晨");
    assert.match(h.statuses.at(-1).text, /已切换聊天/);
});

test("checkpoint rollback restores the old recovery list including evicted points", () => {
    const h = makeHarness();
    const ctx = h.context();
    const original = [0, 1, 2].map(i => recovery.createRecoveryPoint(makeMemory(), ctx.chat, String(i), i));
    ctx.chatMetadata[RECOVERY_KEY] = original;
    const checkpoint = h.api.checkpointBeforeChange("测试");
    assert.equal(checkpoint.metadata, ctx.chatMetadata);
    assert.equal(checkpoint.created, true);
    assert.notEqual(checkpoint.metadata[RECOVERY_KEY][0], original[0]);
    checkpoint.rollback();
    checkpoint.rollback();
    assert.equal(ctx.chatMetadata[RECOVERY_KEY], original);
});

const replacement = {
    import: async h => {
        const signature = recovery.recoveryChatSignature(h.context().chat);
        await h.importText(JSON.stringify(backup.createMemoryBackup(makeMemory("夜晚"), signature)));
        assert.doesNotMatch(h.confirmations[0], /来源未验证/);
    },
    clear: h => h.api.clearCurrentChatMemory(),
    restore: h => h.api.restoreSelectedRecovery(),
};

for (const [name, run] of Object.entries(replacement)) {
    test(`${name} rolls back both metadata fields when save fails`, async () => {
        const h = makeHarness();
        const { chatMetadata: metadata } = h.context();
        h.nodes.get("tiandao_recovery_select").value = seedRecovery(h.context()).id;
        const { tiandao_memory: before, [RECOVERY_KEY]: points } = metadata;
        h.setPersist(() => false);
        await run(h);
        assert.equal(metadata.tiandao_memory, before);
        assert.equal(metadata[RECOVERY_KEY], points);
        assert.equal(h.api.memoryOperationBusy(), false);
        assert.equal(h.saves.length, 1);
        assert.equal(h.saves[0][RECOVERY_KEY].length, 2);
        assert.match(h.statuses.at(-1).text, /失败/);
    });

    test(`${name} keeps verified changes when preview refresh fails`, async () => {
        const h = makeHarness();
        const { chatMetadata: metadata } = h.context();
        h.nodes.get("tiandao_recovery_select").value = seedRecovery(h.context()).id;
        const { tiandao_memory: before } = metadata;
        h.setPreview(() => { throw Error("preview unavailable"); });
        await run(h);
        assert.notEqual(metadata.tiandao_memory, before);
        assert.equal(metadata[RECOVERY_KEY].length, 2);
        assert.equal(h.saves.length, 1);
        assert.equal(h.readbacks.length, 1);
        assert.match(h.statuses.at(-1).text, /恢复点已保存.*刷新注入失败.*preview unavailable/);
    });
}

test("unverified persistence rolls back newly created recovery metadata and absent memory", async () => {
    const h = makeHarness({ readbackUnavailable: true });
    const { chatMetadata: metadata } = h.context();
    delete metadata.tiandao_memory;
    await h.api.clearCurrentChatMemory();
    assert.equal(Object.hasOwn(metadata, "tiandao_memory"), false);
    assert.equal(Object.hasOwn(metadata, RECOVERY_KEY), false);
    assert.match(h.statuses.at(-1).text, /无法确认宿主保存结果/);
});

test("oversized memory can continue without claiming an automatic recovery point", async () => {
    const h = makeHarness();
    const old = h.context().chatMetadata;
    old.tiandao_memory.farHistory.text = "a".repeat(4_000_001);
    seedRecovery(h.context());
    const points = old[RECOVERY_KEY];
    await h.api.clearCurrentChatMemory();
    assert.equal(old[RECOVERY_KEY], points);
    assert.equal(old.tiandao_memory.stateLedger.time, "未知时间");
    assert.match(h.confirmations.at(-1), /不会生成自动恢复点/);
    assert.match(h.statuses.at(-1).text, /本次未生成自动恢复点/);
    assert.doesNotMatch(h.statuses.at(-1).text, /恢复点已保存/);
});

for (const edit of ["todo", "inventory", "pin", "L0", "rebuilt L0"]) {
    test(`${edit} edits restore the prior memory and recovery list on save failure`, async () => {
        const h = makeHarness();
        const ctx = h.context();
        seedRecovery(ctx);
        const previousPoints = ctx.chatMetadata[RECOVERY_KEY];
        const memory = ctx.chatMetadata.tiandao_memory;
        memory.stateLedger.characters.旅人 = { inventory: ["钥匙"] };
        memory.stateLedger.todosAndPromises = [{ id: "task", text: "归还钥匙", completed: false }];
        const item = makeEntry();
        memory.levels[0] = [item];
        memory.archivePool = [item];
        if (edit === "rebuilt L0") memory.levels[1] = [{ level: 1, roundRange: "1", text: "城门阶段" }];
        engine.normalizeMemoryData(memory);
        const before = JSON.parse(JSON.stringify(memory));
        h.setPersist(() => false);
        if (edit === "todo") await h.api.updateTodoCompletion("task", true);
        else if (edit === "inventory") await h.api.deleteLedgerItem("旅人", "inventory", 0);
        else if (edit === "pin") await h.api.updateMemoryPin(0);
        else {
            h.nodes.set("tiandao_story_page_timeline", { querySelector: () => ({ value: "新剧情" }) });
            h.api.testHierarchyBuild(async (_settings, editedMemory) => ({
                levels: { ...editedMemory.levels, 1: [{ level: 1, roundRange: "1", text: "新城门阶段" }] },
                farHistory: editedMemory.farHistory, pendingFarHistory: editedMemory.pendingFarHistory,
                fadedHistory: editedMemory.fadedHistory,
            }));
            await h.api.saveStoryEntry(0, 0);
            await h.api.whenIdle();
        }
        assert.equal(ctx.chatMetadata[RECOVERY_KEY], previousPoints);
        assert.deepEqual(JSON.parse(JSON.stringify(memory)), before);
        assert.equal(h.api.memoryOperationBusy(), false);
        assert.equal(h.saves.length, 1);
    });
}

test("cancelling a delayed story rebuild leaves live memory and recovery metadata untouched", async () => {
    const h = makeHarness();
    const ctx = h.context();
    const memory = ctx.chatMetadata.tiandao_memory;
    const item = makeEntry();
    memory.levels[0] = [item];
    memory.archivePool = [item];
    memory.levels[1] = [{ level: 1, roundRange: "1", text: "原阶段" }];
    seedRecovery(ctx);
    const points = ctx.chatMetadata[RECOVERY_KEY];
    h.nodes.set("tiandao_story_page_timeline", { querySelector: () => ({ value: "新剧情" }) });
    let release;
    let start;
    const started = new Promise(resolve => { start = resolve; });
    h.api.testHierarchyBuild((_settings, draft) => new Promise(resolve => {
        assert.equal(draft.levels[0][0].text, "新剧情");
        release = () => resolve({ levels: draft.levels });
        start();
    }));
    const pending = h.api.saveStoryEntry(0, 0);
    await started;
    assert.equal(ctx.chatMetadata.tiandao_memory, memory);
    assert.equal(memory.levels[0][0].text, "门开了");
    assert.equal(ctx.chatMetadata[RECOVERY_KEY], points);
    h.api.requestSummaryTaskStop();
    release();
    await pending;
    assert.equal(h.saves.length, 0);
    assert.equal(ctx.chatMetadata[RECOVERY_KEY], points);
    assert.equal(h.api.memoryOperationBusy(), false);
    assert.match(h.statuses.at(-1).text, /本次修改未保存/);
});
