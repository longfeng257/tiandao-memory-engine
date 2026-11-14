import test from "node:test";
import assert from "node:assert/strict";
import {
    createEmptyMemoryData,
    shouldSettleBeforeGeneration,
    rollbackMemoryFromMessageIndex,
    mergeStateLedger,
    normalizeMemoryData,
    summarizeSingleTurn,
    computeHiddenMessageCutoff,
    rebuildMemoryHierarchy,
} from "../memory-engine.js";

function memoryWithRounds(lastRound = 5) {
    const data = createEmptyMemoryData();
    data.stateLedger = {
        time: `第${lastRound}轮`,
        characters: {},
        todosAndPromises: [],
    };
    for (let round = 1; round <= lastRound; round++) {
        const entry = {
            id: `L0_${round}`,
            level: 0,
            roundRange: String(round),
            startMessageId: round * 2 - 2,
            endMessageId: round * 2 - 1,
            text: `第${round}轮`,
            keywords: [],
            postStateSnapshot: { time: `第${round}轮`, characters: {}, todosAndPromises: [] },
        };
        data.levels[0].push(entry);
        data.archivePool.push(entry);
    }
    data.lastProcessedMessageId = lastRound * 2 - 1;
    data.lastProcessedRound = lastRound;
    return data;
}

function stubChatCompletion(summaryText, mergeFails = false) {
    globalThis.fetch = async (_url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        const isMerge = body.messages?.[0]?.content?.includes("叙事剧情时间线提炼引擎");
        if (isMerge && mergeFails) {
            return new Response("merge failed", { status: 500 });
        }
        const content = isMerge
            ? "合并后的阶段剧情。"
            : JSON.stringify({
                l0_summary: summaryText,
                keywords: ["关键词"],
                stateLedger: {
                    time: "下午",
                    characters: {
                        小明: {
                            location: "客厅",
                            statusAndAction: "站着",
                            wear: "衬衫",
                            removedItemsLock: [],
                            inventory: [],
                        },
                    },
                    todosAndPromises: [],
                },
            });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
}

const SETTINGS = {
    apiUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    mergeChunkSize: 2,
    maxLevel: 3,
};

test("rollback invalidates higher-level summaries and restores L0/state", () => {
    const data = memoryWithRounds(5);
    data.levels[1].push({
        id: "L1_old",
        level: 1,
        roundRange: "1-5",
        text: "包含第1到5轮的旧合并摘要",
    });

    assert.equal(rollbackMemoryFromMessageIndex(data, 6), true);
    assert.deepEqual(data.levels[0].map(x => x.roundRange), ["1", "2", "3"]);
    assert.deepEqual(data.archivePool.map(x => x.roundRange), ["1", "2", "3"]);
    assert.deepEqual(data.levels[1], []);
    assert.equal(data.stateLedger.time, "第3轮");
    assert.equal(data.lastProcessedMessageId, 5);
    assert.equal(data.lastProcessedRound, 3);
});

test("rollback keeps L0 already covered by surviving higher levels out of active window", () => {
    const data = memoryWithRounds(6);
    data.levels[1].push({
        id: "L1_1_4",
        level: 1,
        roundRange: "1-4",
        text: "前四轮阶段摘要",
    });

    assert.equal(rollbackMemoryFromMessageIndex(data, 10), true);
    assert.deepEqual(data.archivePool.map(x => x.roundRange), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(data.levels[0].map(x => x.roundRange), ["5"]);
    assert.deepEqual(data.levels[1].map(x => x.roundRange), ["1-4"]);
});

test("merge failure keeps memory unchanged and retry does not duplicate L0", async () => {
    const data = memoryWithRounds(1);
    stubChatCompletion("第二轮摘要", true);
    const turn = {
        roundNumber: 2,
        startMessageId: 2,
        endMessageId: 3,
        userName: "我",
        charName: "小明",
        dialogueText: "第二轮对话",
    };

    await assert.rejects(() => summarizeSingleTurn(SETTINGS, data, turn), /API 请求失败/);
    assert.deepEqual(data.levels[0].map(x => x.roundRange), ["1"]);
    assert.equal(data.lastProcessedMessageId, 1);

    await assert.rejects(() => summarizeSingleTurn(SETTINGS, data, turn), /API 请求失败/);
    assert.deepEqual(data.levels[0].map(x => x.roundRange), ["1"]);
    assert.equal(data.archivePool.filter(x => x.roundRange === "2").length, 0);
});

test("removed item locks are inherited unless explicitly unlocked", () => {
    const merged = mergeStateLedger(
        {
            time: "上午",
            characters: {
                小明: {
                    location: "客厅",
                    statusAndAction: "坐着",
                    wear: "衬衫",
                    removedItemsLock: ["金丝眼镜（已摘下）", "外套（已脱下）"],
                    inventory: ["钥匙"],
                },
            },
            todosAndPromises: [],
        },
        {
            time: "下午",
            characters: {
                小明: {
                    location: "客厅",
                    statusAndAction: "站着",
                    wear: "衬衫",
                    removedItemsLock: [],
                    unlockedItems: ["金丝眼镜"],
                    inventory: [],
                },
            },
            todosAndPromises: [],
        },
    );

    assert.deepEqual(merged.characters.小明.removedItemsLock, ["外套（已脱下）"]);
    assert.deepEqual(merged.characters.小明.inventory, []);
});

test("normalize repairs malformed imported memory", () => {
    const data = normalizeMemoryData({
        levels: {
            0: [{ id: "a", level: 0, roundRange: "1", startMessageId: 0, endMessageId: 1, text: "x" }],
        },
        stateLedger: {
            time: "t",
            characters: { A: { removedItemsLock: "bad", inventory: 3 } },
            todosAndPromises: "bad",
        },
        archivePool: [],
    });

    assert.equal(Array.isArray(data.stateLedger.characters.A.removedItemsLock), true);
    assert.equal(Array.isArray(data.stateLedger.characters.A.inventory), true);
    assert.equal(Array.isArray(data.stateLedger.todosAndPromises), true);
    assert.equal(data.archivePool.length, 1);
});

test("normalize does not reactivate archived L0 after a completed merge", () => {
    const data = createEmptyMemoryData();
    data.levels = { 0: [], 1: [{ id: "L1", level: 1, roundRange: "1-2", text: "合并" }] };
    data.archivePool = [
        { id: "1", level: 0, roundRange: "1", startMessageId: 0, endMessageId: 1, text: "a" },
        { id: "2", level: 0, roundRange: "2", startMessageId: 2, endMessageId: 3, text: "b" },
    ];

    normalizeMemoryData(data);
    assert.deepEqual(data.levels[0], []);
    assert.equal(data.archivePool.length, 2);
});

test("unsettled generation types are skipped", () => {
    for (const type of ["swipe", "regenerate", "continue", "quiet"]) {
        assert.equal(shouldSettleBeforeGeneration(type), false, type);
    }
    assert.equal(shouldSettleBeforeGeneration("normal"), true);
    assert.equal(shouldSettleBeforeGeneration("normal", true), false);
});

test("auto-hide never crosses unprocessed messages", () => {
    const chat = [];
    for (let round = 1; round <= 5; round++) {
        chat.push({ is_user: true, mes: `u${round}` });
        chat.push({ is_user: false, mes: `a${round}` });
    }

    assert.equal(computeHiddenMessageCutoff(chat, 1, -1), 0);
    assert.equal(computeHiddenMessageCutoff(chat, 1, 3), 4);
    assert.equal(computeHiddenMessageCutoff(chat, 3, 9), 4);
});

test("rebuilding hierarchy uses edited L0 text", async () => {
    const data = memoryWithRounds(4);
    data.levels[1].push({
        id: "old_L1",
        level: 1,
        roundRange: "1-4",
        text: "旧的高层摘要",
    });
    data.levels[0][0].text = "编辑后的第一轮";
    stubChatCompletion("重建摘要");

    await rebuildMemoryHierarchy(SETTINGS, data);
    assert.equal(data.levels[1].length, 0);
    assert.equal(data.levels[2].length, 1);
    assert.equal(data.levels[0].length, 0);
    assert.equal(data.archivePool[0].text, "编辑后的第一轮");
});
