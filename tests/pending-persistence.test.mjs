import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import * as engine from "../memory-engine.js";
import * as recovery from "../recovery-store.js";
import * as persistence from "../host-persistence.js";
import { createSummaryTaskGate } from "../task-gate.js";

const source = (await readFile(new URL("../index.js", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .split("(async function initTiandaoMemoryExtension()")[0];
const recoveryKey = "suwei_memory_recovery_v1";
const copy = value => structuredClone(value);

function context(id = "same-file", avatar = "first.png") {
    const memory = engine.createEmptyMemoryData();
    memory.stateLedger.time = "base time";
    return {
        chatId: id, characterId: 0, characters: [{ avatar }],
        getRequestHeaders: () => ({ "X-CSRF-Token": "mock" }),
        chat: [{ is_user: true, mes: "question" }, { is_user: false, mes: "answer" }],
        chatMetadata: { tiandao_memory: memory },
    };
}

function harness() {
    let current = context();
    let saver = null, reader = null, saves = 0, reads = 0;
    const persisted = new Map();
    const key = ctx => JSON.stringify([ctx.characters[ctx.characterId].avatar, ctx.chatId]);
    const install = ctx => {
        // Native getCurrentChatId and savers consult live host globals, not the captured context.
        ctx.getCurrentChatId = () => current.chatId;
        ctx.saveMetadata = async () => {
            saves++;
            if (saver) return saver();
            persisted.set(key(current), copy(current.chatMetadata));
        };
        if (!persisted.has(key(ctx))) persisted.set(key(ctx), copy(ctx.chatMetadata));
    };
    install(current);
    const messages = [];
    const scope = vm.createContext({
        ...engine, ...recovery, ...persistence, createSummaryTaskGate,
        window: {}, SillyTavern: { getContext: () => current },
        console, setTimeout, clearTimeout, AbortController,
        fetch: async (url, options) => {
            reads++;
            if (reader) return reader(url, options);
            const body = JSON.parse(options.body);
            const metadata = copy(persisted.get(JSON.stringify([body.avatar_url, body.file_name])) || {});
            return { ok: true, json: async () => [{ chat_metadata: metadata }] };
        },
    });
    scope.messages = messages;
    vm.runInContext(source + `
        updateFloatingWidgetUI = () => {};
        updateStatusBar = text => messages.push(text);
        refreshPromptInjection = async () => {};
        globalThis.api = { getPendingSummarySave, retryPendingSummarySave, saveChatMemory,
            seed(kind, withRecovery = false) {
                const ctx = getSTContext(), target = currentMemoryReference(), before = clonePlainData(target);
                const draft = clonePlainData(target), key = getStateSaveKey(ctx);
                const details = { signature: recoveryChatSignature(ctx.chat), endMessageId: 1,
                    roundNumber: 1, roundRange: '1' };
                if (kind === 'state') {
                    const baseCursor = getStateLedgerCursor(target);
                    const ledger = clonePlainData(target.stateLedger);
                    ledger.time = 'generated time';
                    recordStateLedger(draft, { endMessageId: 1, roundNumber: 1 }, ledger);
                    pendingStateSaves.set(key, { ...details, key, target, kind,
                        draft: clonePlainData(savedStateFields(draft)), baseCursor,
                        baseLedger: JSON.stringify(before.stateLedger) });
                } else {
                    draft.archivePool.push({ id: 'generated-entry', level: 0, roundRange: '1',
                        startMessageId: 0, endMessageId: 1, text: 'generated summary' });
                    draft.levels[0] = draft.archivePool.slice();
                    draft.lastProcessedMessageId = 1;
                    draft.lastProcessedRound = 1;
                    draft.stateLedger.time = 'generated time';
                    if (withRecovery) {
                        details.recoveryBefore = captureRecoveryMetadata(ctx.chatMetadata);
                        details.recoveryDraft = { present: true, value: [{ id: 'generated-recovery' }] };
                    }
                    retainPendingSummarySave(key, target, { ...details, before, draft });
                    target.lastSummaryError = { message: '摘要已生成，等待重试保存：offline', at: 1 };
                }
                return getPendingSummarySave();
            },
            busy(value) { recoveryBusy = value; },
        };`, scope);
    return {
        api: scope.api, messages, current: () => current,
        switchTo(ctx) { install(ctx); current = ctx; },
        saveWith(fn) { saver = fn; }, readWith(fn) { reader = fn; },
        saves: () => saves, reads: () => reads,
        store(metadata = current.chatMetadata) { persisted.set(key(current), copy(metadata)); },
        stored(ctx = current) { return copy(persisted.get(key(ctx))); },
    };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

for (const kind of ["summary", "state"]) {
    test(kind + " retry invalidates an in-place ledger baseline change", async () => {
        const h = harness(), memory = h.current().chatMetadata.tiandao_memory;
        assert.ok(h.api.seed(kind));
        memory.stateLedger.time = "revised in place";
        assert.equal(h.api.getPendingSummarySave(), null);
        assert.equal(await h.api.retryPendingSummarySave(), true);
        assert.equal(memory.stateLedger.time, "revised in place");
        assert.equal(h.saves(), 0);
        assert.equal(h.reads(), 0);
    });

    test(kind + " baseline is still checked during an unrelated busy operation", () => {
        const h = harness();
        h.api.seed(kind);
        h.api.busy(true);
        h.current().chatMetadata.tiandao_memory.stateLedger.time = "unrelated revision";
        assert.equal(h.api.getPendingSummarySave(), null);
        h.api.busy(false);
    });

    test(kind + " remains pending during its staged save and is idempotent after confirmation", async () => {
        const h = harness(), pending = h.api.seed(kind);
        h.saveWith(async () => {
            assert.equal(h.api.getPendingSummarySave(), pending);
            h.store();
        });
        assert.equal(await h.api.retryPendingSummarySave(), true);
        assert.equal(h.current().chatMetadata.tiandao_memory.stateLedger.time, "generated time");
        assert.equal(h.saves(), 1);
        assert.equal(h.api.getPendingSummarySave(), null);
        assert.equal(await h.api.retryPendingSummarySave(), true);
        assert.equal(h.saves(), 1);
    });

    test(kind + " retry confirms an already persisted draft without a native save", async () => {
        const h = harness(), pending = h.api.seed(kind);
        const memory = copy(h.current().chatMetadata.tiandao_memory);
        Object.assign(memory, copy(pending.draft));
        h.store({ tiandao_memory: memory });
        h.saveWith(() => { throw Error("must not save twice"); });
        assert.equal(await h.api.retryPendingSummarySave(), true);
        assert.equal(h.saves(), 0);
        assert.equal(h.api.getPendingSummarySave(), null);
    });

    test(kind + " draft remains retriable after a native wait saves a different owner with the same filename", async () => {
        const h = harness(), original = h.current(), pending = h.api.seed(kind);
        const next = context(original.chatId, "second.png");
        const started = deferred(), release = deferred();
        h.saveWith(async () => {
            started.resolve();
            await release.promise;
            h.store(); // Native conditional save selects current globals after waiting.
        });
        const retry = h.api.retryPendingSummarySave();
        await started.promise;
        h.switchTo(next);
        release.resolve();
        assert.equal(await retry, false);
        assert.equal(h.reads(), 1); // No misleading A readback after the native saver switched to B.
        assert.equal(next.chatMetadata.tiandao_memory.stateLedger.time, "base time");
        assert.equal(h.stored(next).tiandao_memory.stateLedger.time, "base time");
        assert.equal(original.chatMetadata.tiandao_memory.stateLedger.time, "base time");
        assert.equal(h.api.getPendingSummarySave(), null);
        h.switchTo(original);
        assert.equal(h.api.getPendingSummarySave(), pending);
        h.saveWith(null);
        assert.equal(await h.api.retryPendingSummarySave(), true);
        assert.equal(original.chatMetadata.tiandao_memory.stateLedger.time, "generated time");
    });
}

test("summary retries ignore ephemeral errors and atomically stage range recovery metadata", async () => {
    const h = harness(), ctx = h.current();
    ctx.chatMetadata[recoveryKey] = [{ id: "original-recovery" }];
    const pending = h.api.seed("summary", true);
    ctx.chatMetadata.tiandao_memory.lastSummaryError = { message: "new transient save error", at: 2 };
    assert.equal(h.api.getPendingSummarySave(), pending);
    h.saveWith(async () => {
        assert.equal(h.api.getPendingSummarySave(), pending);
        assert.deepEqual(copy(ctx.chatMetadata[recoveryKey]), copy(pending.recoveryDraft.value));
        throw Error("still offline");
    });
    assert.equal(await h.api.retryPendingSummarySave(), false);
    assert.deepEqual(copy(ctx.chatMetadata[recoveryKey]), [{ id: "original-recovery" }]);
    assert.equal(h.api.getPendingSummarySave(), pending);
    h.saveWith(null);
    assert.equal(await h.api.retryPendingSummarySave(), true);
    assert.deepEqual(copy(h.stored()[recoveryKey]), copy(pending.recoveryDraft.value));
});

test("a changed range recovery baseline invalidates a same-reference draft", () => {
    const h = harness(), ctx = h.current();
    ctx.chatMetadata[recoveryKey] = [{ id: "original-recovery" }];
    h.api.seed("summary", true);
    ctx.chatMetadata[recoveryKey].push({ id: "later-recovery" });
    assert.equal(h.api.getPendingSummarySave(), null);
    assert.equal(ctx.chatMetadata.tiandao_memory.archivePool.length, 0);
});

test("state-only retry preserves independently changed narrative data", async () => {
    const h = harness(), pending = h.api.seed("state");
    const memory = h.current().chatMetadata.tiandao_memory;
    memory.archivePool.push({ id: "independent", level: 0, roundRange: "1", startMessageId: 0,
        endMessageId: 1, text: "independently saved narrative" });
    memory.levels[0] = memory.archivePool.slice();
    memory.lastSummaryError = { message: "independent narrative diagnostic" };
    // A narrative save can move its own cursor while live state remains at its base.
    engine.ensureLiveStateStorage(memory);
    assert.equal(h.api.getPendingSummarySave(), pending);
    assert.equal(await h.api.retryPendingSummarySave(), true);
    assert.equal(memory.archivePool[0].text, "independently saved narrative");
    assert.equal(memory.lastSummaryError.message, "independent narrative diagnostic");
});

for (const change of ["owner", "chat", "metadata", "memory", "chat array"]) {
    test("saveChatMemory freezes " + change + " identity through the native save", async () => {
        const h = harness(), original = h.current();
        h.saveWith(async () => {
            if (change === "owner") original.characters[0].avatar = "different-owner.png";
            if (change === "chat") original.chatId = "different-chat";
            if (change === "metadata") original.chatMetadata = copy(original.chatMetadata);
            if (change === "memory") original.chatMetadata.tiandao_memory = copy(original.chatMetadata.tiandao_memory);
            if (change === "chat array") original.chat = copy(original.chat);
        });
        await assert.rejects(h.api.saveChatMemory(), error => error.persistenceStatus === "unknown");
        assert.equal(h.reads(), 0);
    });
}

test("saveChatMemory checks full owner identity before invoking the native saver", async () => {
    const h = harness(), ctx = h.current();
    let calls = 0;
    Object.defineProperty(ctx, "saveMetadata", { get() {
        ctx.characters[0].avatar = "changed-before-save.png";
        return async () => { calls++; };
    } });
    await assert.rejects(h.api.saveChatMemory(), error => error.persistenceStatus === "unknown");
    assert.equal(calls, 0);
    assert.equal(h.reads(), 0);
});

test("a switch during readback JSON decoding stays unknown despite matching saved metadata", async () => {
    const h = harness(), ctx = h.current(), next = context(ctx.chatId, "second.png");
    h.readWith(async () => ({ ok: true, json: async () => {
        h.switchTo(next);
        return [{ chat_metadata: copy(ctx.chatMetadata) }];
    } }));
    await assert.rejects(h.api.saveChatMemory(), error => error.persistenceStatus === "unknown");
    assert.equal(h.saves(), 1);
    assert.equal(h.reads(), 1);
});
