import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_SETTINGS, createEmptyMemoryData, normalizeMemoryData, buildRoundMessageIndex,
    collectMissingAiTurns, collectPendingAiTurns, getContinuousRoundRange, getL0CoverageRanges,
    isRoundRangeCovered, groupAiTurnsForL0, checkAndCascadeMerge, backfillExistingChatHistory,
    reconcileMemoryAfterMessageDeletion, buildChatMessageFingerprint,
} from "../memory-engine.js";
import { buildChatHistoryReplacement } from "../history-builder.js";

const settings = { ...DEFAULT_SETTINGS, apiUrl: "https://example.invalid/v1", apiKey: "test", model: "mock", mergeChunkSize: 2 };
function fixture(count = 10) {
    const memory = createEmptyMemoryData();
    const chat = [];
    for (let round = 1; round <= count; round++) {
        chat.push({ is_user: true, mes: "问题" + round }, { is_user: false, mes: "回答" + round });
        const entry = { id: "round-" + round, level: 0, roundRange: String(round),
            startMessageId: (round - 1) * 2, endMessageId: round * 2 - 1, text: "事实" + round };
        memory.archivePool.push(entry);
        memory.levels[0].push(entry);
    }
    normalizeMemoryData(memory);
    return { chat, memory };
}
function mockCompletion(t) {
    const prompts = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
        prompts.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "守卫收好钥匙，众人离开城门。" } }] }),
            { headers: { "Content-Type": "application/json" } });
    });
    return prompts;
}

test("missing rounds before the high-water cursor are detected without rewinding it", () => {
    const { memory, chat } = fixture(6);
    memory.archivePool = memory.archivePool.filter(item => item.roundRange !== "3");
    memory.levels[0] = memory.archivePool.slice();
    normalizeMemoryData(memory);
    const before = JSON.stringify(memory);
    assert.deepEqual(collectPendingAiTurns(chat, memory.lastProcessedMessageId), []);
    assert.deepEqual(collectMissingAiTurns(chat, memory).map(turn => turn.round), [3]);
    assert.equal(memory.lastProcessedRound, 6);
    assert.equal(memory.lastProcessedMessageId, 11);
    assert.equal(JSON.stringify(memory), before);
});

test("L0 coverage validates both round ends against the real message windows", () => {
    const { memory, chat } = fixture(4);
    memory.archivePool[1].startMessageId = 0;
    memory.archivePool[2].endMessageId = 3;
    const index = buildRoundMessageIndex(chat);
    const ranges = getL0CoverageRanges(memory.archivePool, index);
    assert.equal(isRoundRangeCovered({ start: 1, end: 4 }, ranges), false);
    assert.deepEqual(collectMissingAiTurns(chat, memory, Infinity, false, index).map(turn => turn.round), [2, 3]);
});

test("overlapping valid L0 spans cover the union without inventing a missing round", () => {
    assert.equal(isRoundRangeCovered({ start: 1, end: 7 }, [
        { start: 4, end: 7 }, { start: 1, end: 5 },
    ]), true);
    assert.equal(isRoundRangeCovered({ start: 1, end: 7 }, [
        { start: 1, end: 3 }, { start: 5, end: 7 },
    ]), false);
    assert.deepEqual(getContinuousRoundRange([{ roundRange: "1-3" }, { roundRange: "4-7" }]), { start: 1, end: 7 });
    assert.equal(getContinuousRoundRange([{ roundRange: "1-3" }, { roundRange: "5-7" }]), null);
    assert.equal(getContinuousRoundRange([{ roundRange: "1-3" }, { roundRange: "3-7" }]), null);
});

test("grouping missing rounds never spans an already archived gap", () => {
    const turns = [1, 2, 4, 5, 6, 8].map(round => ({ round, idx: round * 2 - 1 }));
    assert.deepEqual(groupAiTurnsForL0(turns, 3, false).map(group => group.map(turn => turn.round)), [[1, 2], [4, 5, 6], [8]]);
    assert.deepEqual(groupAiTurnsForL0(turns, 3, true).map(group => group.map(turn => turn.round)), [[4, 5, 6]]);
});

test("cascade merges retain a noncontiguous batch without paid requests", async t => {
    const { memory } = fixture();
    memory.archivePool = memory.archivePool.filter(item => item.roundRange !== "2");
    memory.levels[0] = memory.archivePool.slice();
    const prompts = mockCompletion(t);
    const before = JSON.stringify(memory);
    await checkAndCascadeMerge(settings, memory);
    assert.equal(prompts.length, 0);
    assert.equal(JSON.stringify(memory), before);
});

test("higher-level cascade rejects a continuous label whose L0 sources contain a gap", async t => {
    const { memory } = fixture();
    memory.archivePool = memory.archivePool.filter(item => item.roundRange !== "2");
    memory.levels[0] = [];
    memory.levels[1] = Array.from({ length: 10 }, (_, index) => ({
        id: "phase-" + index, level: 1, roundRange: String(index + 1), text: "旧阶段事实",
    }));
    const prompts = mockCompletion(t);
    await checkAndCascadeMerge(settings, memory);
    assert.equal(prompts.length, 0);
    assert.equal(memory.levels[1].length, 10);
    assert.equal(memory.levels[2].length, 0);
});

test("far history folds a continuous prefix and leaves later separated spans pending", async t => {
    const memory = createEmptyMemoryData();
    memory.pendingFarHistory = [
        { level: 3, roundRange: "1-2", text: "前段事实" },
        { level: 3, roundRange: "4-5", text: "后段事实" },
    ];
    const prompts = mockCompletion(t);
    await checkAndCascadeMerge(settings, memory);
    assert.equal(prompts.length, 1);
    assert.equal(memory.farHistory.earliestRound, 1);
    assert.equal(memory.farHistory.latestRound, 2);
    assert.deepEqual(memory.pendingFarHistory.map(item => item.roundRange), ["4-5"]);
});

test("far-history labels with missing L0 sources do not trigger a merge", async t => {
    const { memory } = fixture(6);
    memory.archivePool = memory.archivePool.filter(item => item.roundRange !== "3");
    memory.levels[0] = [];
    memory.pendingFarHistory = [{ level: 3, roundRange: "1-5", text: "跨缺档旧远史" }];
    const prompts = mockCompletion(t);
    await checkAndCascadeMerge(settings, memory);
    assert.equal(prompts.length, 0);
    assert.equal(memory.pendingFarHistory.length, 1);
    assert.equal(memory.farHistory.text, "");
});

test("standalone append-only backfill rejects a middle gap before any request", async t => {
    const { memory, chat } = fixture(5);
    memory.archivePool = memory.archivePool.filter(item => item.roundRange !== "2");
    memory.levels[0] = memory.archivePool.slice();
    const before = JSON.stringify(memory);
    const prompts = mockCompletion(t);
    await assert.rejects(backfillExistingChatHistory(settings, memory, chat, "旅人", "守卫"), { code: "MEMORY_HISTORY_GAP" });
    assert.equal(prompts.length, 0);
    assert.equal(JSON.stringify(memory), before);
});

test("deletion invalidates derived spans when an earlier L0 source was already missing", () => {
    const { memory, chat } = fixture(6);
    memory.archivePool = memory.archivePool.filter(item => item.roundRange !== "2");
    memory.levels[0] = memory.archivePool.slice();
    memory.levels[1] = [{ id: "phase", level: 1, roundRange: "1-5", text: "来源不完整的阶段" }];
    memory.farHistory = { earliestRound: 1, latestRound: 5, text: "来源不完整的远史", updatedAt: 1 };
    memory.pendingFarHistory = [{ level: 3, roundRange: "1-5", text: "来源不完整的待合并阶段" }];
    chat.push({ is_user: true, mes: "尚未回答" });
    const previous = buildChatMessageFingerprint(chat);
    chat.pop();
    reconcileMemoryAfterMessageDeletion(memory, chat, previous);
    assert.equal(memory.levels[1].length, 0);
    assert.equal(memory.farHistory.text, "");
    assert.equal(memory.pendingFarHistory.length, 0);
    assert.deepEqual(memory.archivePool.map(item => item.roundRange), ["1", "3", "4", "5", "6"]);
});

for (const span of [1, 3]) {
    test(`deleting a reply keeps its surviving prompt raw before a ${span}-round L0`, () => {
        const { memory, chat } = fixture(8);
        const next = { ...memory.archivePool[2], id: "next-span", roundRange: span === 1 ? "3" : "3-5",
            endMessageId: (2 + span) * 2 - 1, text: "仅总结后续对话，不含遗留问题" };
        memory.archivePool.splice(2, span, next);
        memory.levels[0] = memory.archivePool.slice();
        memory.levels[1] = [{ id: "phase", level: 1, roundRange: "3-5", text: "后续阶段事实" }];
        const previous = buildChatMessageFingerprint(chat);
        chat.splice(3, 1); // The round-2 user prompt now belongs to the next reply's window.
        const chatBeforeRemap = JSON.stringify(chat);

        reconcileMemoryAfterMessageDeletion(memory, chat, previous);

        assert.equal(memory.archivePool.find(item => item.id === next.id).startMessageId, 3);
        assert.deepEqual(collectMissingAiTurns(chat, memory).map(turn => turn.round),
            Array.from({ length: span }, (_, index) => index + 2));
        assert.equal(memory.levels[1].length, 0);
        const plan = buildChatHistoryReplacement(memory, chat, chat, { ...settings, keepRecentRoundsCount: 2 });
        assert.equal(plan.rawStart, 2);
        assert.ok(plan.messages.includes(chat[2]), "the surviving user prompt must remain raw");
        assert.ok(plan.messages.includes(chat.at(-1)), "later dialogue must remain raw after the gap");
        assert.doesNotMatch(plan.text, /后续阶段事实/);
        assert.equal(JSON.stringify(chat), chatBeforeRemap);
    });
}

for (const bounds of ["missing", "negative", "out-of-range"]) {
    test(`deletion preserves a legacy L0 with ${bounds} IDs without trusting its derived facts`, () => {
        const { memory, chat } = fixture(8);
        const legacy = memory.archivePool[1];
        if (bounds === "missing") {
            delete legacy.startMessageId;
            delete legacy.endMessageId;
        } else if (bounds === "negative") {
            legacy.startMessageId = -1;
        } else {
            legacy.endMessageId = chat.length + 1;
        }
        memory.levels[0] = [];
        for (let level = 1; level <= 3; level++) {
            memory.levels[level] = [{ id: "stale-" + level, level, roundRange: "1-2", text: "DELETED_FACT" }];
        }
        memory.levels[1].push({ id: "unaffected", level: 1, roundRange: "5-6", text: "保留的后续事实" });
        memory.pendingFarHistory = [{ level: 3, roundRange: "1-2", text: "DELETED_FACT" }];
        memory.farHistory = { earliestRound: 1, latestRound: 2, text: "DELETED_FACT", updatedAt: 1 };
        memory.fadedHistory = { earliestRound: 1, latestRound: 2, count: 1 };
        const previous = buildChatMessageFingerprint(chat);
        chat.splice(2, 2);

        reconcileMemoryAfterMessageDeletion(memory, chat, previous);

        assert.ok(memory.archivePool.includes(legacy), "unverifiable legacy narrative is preserved");
        assert.equal(legacy.roundRange, "2");
        assert.deepEqual(memory.levels[1].map(item => [item.id, item.roundRange]), [["unaffected", "4-5"]]);
        assert.equal(memory.levels[2].length, 0);
        assert.equal(memory.levels[3].length, 0);
        assert.equal(memory.pendingFarHistory.length, 0);
        assert.equal(memory.farHistory.text, "");
        assert.equal(memory.fadedHistory.count, 0);
        const plan = buildChatHistoryReplacement(memory, chat, chat, { ...settings, keepRecentRoundsCount: 2 });
        assert.doesNotMatch(plan.text, /DELETED_FACT/);
        assert.match(plan.text, /保留的后续事实/);
    });
}

test("an unrelated deletion cannot repair an unverified L0 window into coverage", () => {
    const { memory, chat } = fixture(6);
    memory.archivePool[1].startMessageId = 0;
    memory.levels[1] = [{ level: 1, roundRange: "1-3", text: "来源错位的阶段" }];
    assert.deepEqual(collectMissingAiTurns(chat, memory).map(turn => turn.round), [2]);
    chat.push({ is_user: true, mes: "尚未回答" });
    const previous = buildChatMessageFingerprint(chat);
    chat.pop();

    reconcileMemoryAfterMessageDeletion(memory, chat, previous);

    assert.equal(memory.archivePool.find(item => item.id === "round-2").startMessageId, 0);
    assert.deepEqual(collectMissingAiTurns(chat, memory).map(turn => turn.round), [2]);
    assert.equal(memory.levels[1].length, 0);
});

test("far-history extension rechecks the existing span's L0 sources", async t => {
    const { memory } = fixture(7);
    memory.archivePool = memory.archivePool.filter(item => item.roundRange !== "3");
    memory.levels[0] = [];
    memory.farHistory = { earliestRound: 1, latestRound: 5, text: "已有远史事实", updatedAt: 1 };
    memory.pendingFarHistory = [{ level: 3, roundRange: "6-7", text: "新增远史事实" }];
    const before = JSON.stringify(memory);
    const prompts = mockCompletion(t);

    await checkAndCascadeMerge(settings, memory);

    assert.equal(prompts.length, 0);
    assert.equal(JSON.stringify(memory), before, "neither the old span nor the pending batch is consumed");
});

test("far-history extension with complete sources still merges both spans", async t => {
    const { memory } = fixture(7);
    memory.levels[0] = [];
    memory.farHistory = { earliestRound: 1, latestRound: 5, text: "已有远史事实", updatedAt: 1 };
    memory.pendingFarHistory = [{ level: 3, roundRange: "6-7", text: "新增远史事实" }];
    const prompts = mockCompletion(t);

    await checkAndCascadeMerge(settings, memory);

    assert.equal(prompts.length, 1);
    assert.match(prompts[0].messages[1].content, /已有远史事实/);
    assert.match(prompts[0].messages[1].content, /新增远史事实/);
    assert.deepEqual([memory.farHistory.earliestRound, memory.farHistory.latestRound], [1, 7]);
    assert.equal(memory.pendingFarHistory.length, 0);
});

test("complete L0 sources cannot bridge a gap between far-history inputs", async t => {
    const { memory } = fixture(7);
    memory.levels[0] = [];
    memory.farHistory = { earliestRound: 1, latestRound: 2, text: "已有远史事实", updatedAt: 1 };
    memory.pendingFarHistory = [{ level: 3, roundRange: "4-5", text: "不相接的远史事实" }];
    const before = JSON.stringify(memory);
    const prompts = mockCompletion(t);

    await checkAndCascadeMerge(settings, memory);

    assert.equal(prompts.length, 0);
    assert.equal(JSON.stringify(memory), before);
});

test("a missing endpoint beyond the real chat cannot mask a backfill gap", async t => {
    const { memory, chat } = fixture(6);
    memory.archivePool = [
        { id: "legacy-without-end", level: 0, roundRange: "1-20", startMessageId: 0, text: "无法核对结束点的旧摘要" },
        memory.archivePool.at(-1),
    ];
    memory.levels[0] = [];
    normalizeMemoryData(memory);
    const index = buildRoundMessageIndex(chat);
    const before = JSON.stringify(memory);
    const prompts = mockCompletion(t);

    assert.deepEqual(getL0CoverageRanges(memory.archivePool, index), [{ start: 6, end: 6 }]);
    assert.deepEqual(collectMissingAiTurns(chat, memory, Infinity, false, index).map(turn => turn.round), [1, 2, 3, 4, 5]);
    await assert.rejects(backfillExistingChatHistory(settings, memory, chat, "旅人", "守卫"), { code: "MEMORY_HISTORY_GAP" });
    assert.equal(prompts.length, 0);
    assert.equal(JSON.stringify(memory), before);
});
