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
    safeParseJSON,
    cleanMessageText,
    buildInjectedMemoryPrompt,
    collectPendingAiTurns,
    cleanupPlaceholderCharacters,
    pruneStaleCharacters,
    callIndependentLLM,
    isAiReplyMessage,
    calculateRoundForMessageIndex,
    estimatePromptTokens,
    checkAndCascadeMerge,
    backfillExistingChatHistory,
    resolveStateLedgerAfterEntry,
    isActiveChatContext,
    isOpeningAiMessage,
    getOpeningAiMessageIndex,
    getRoundMessageWindow,
    buildRoundMessageIndex,
    invalidateDerivedSummariesInRange,
    readResponseText,
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
        const isFarHistory = body.messages?.[0]?.content?.includes("编年史整理器");
        if (isMerge && mergeFails) {
            return new Response("merge failed", { status: 500 });
        }
        const content = isFarHistory
            ? "景和三年春，众人在旧城立下约定；数月后局势骤变。"
            : isMerge
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

test("rollback invalidates far history that may contain removed rounds", () => {
    const data = memoryWithRounds(4);
    data.farHistory = {
        text: "远史包含第 8 轮的旧剧情",
        earliestRound: 1,
        latestRound: 10,
        updatedAt: 1,
    };
    data.pendingFarHistory = [
        { roundRange: "1-2", text: "保留的旧阶段" },
        { roundRange: "3-4", text: "失效的旧阶段" },
        { roundRange: "8-10", text: "更晚的旧阶段" },
    ];
    data.fadedHistory = { earliestRound: 1, latestRound: 10, count: 3 };

    assert.equal(rollbackMemoryFromMessageIndex(data, 4), true);
    assert.deepEqual(data.pendingFarHistory.map(item => item.roundRange), ["1-2"]);
    assert.equal(data.farHistory.text, "");
    assert.equal(data.fadedHistory.count, 0);
});

test("merge failure keeps memory unchanged and retry does not duplicate L0", async () => {
    const data = memoryWithRounds(7);
    stubChatCompletion("第二轮摘要", true);
    const turn = {
        roundNumber: 8,
        startMessageId: 14,
        endMessageId: 15,
        userName: "我",
        charName: "小明",
        dialogueText: "第八轮对话",
    };

    await assert.rejects(() => summarizeSingleTurn(SETTINGS, data, turn), /API 请求失败/);
    assert.deepEqual(data.levels[0].map(x => x.roundRange), ["1", "2", "3", "4", "5", "6", "7"]);
    assert.equal(data.lastProcessedMessageId, 13);

    await assert.rejects(() => summarizeSingleTurn(SETTINGS, data, turn), /API 请求失败/);
    assert.deepEqual(data.levels[0].map(x => x.roundRange), ["1", "2", "3", "4", "5", "6", "7"]);
    assert.equal(data.archivePool.filter(x => x.roundRange === "8").length, 0);
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

test("legacy string todos migrate to checkable records with stable ids", () => {
    const data = normalizeMemoryData({
        levels: { 0: [] },
        stateLedger: {
            time: "傍晚",
            characters: {},
            todosAndPromises: ["明日在城门会合", "把钥匙还给苏晚"],
        },
        archivePool: [],
    });

    assert.equal(data.stateLedger.todosAndPromises.length, 2);
    assert.match(data.stateLedger.todosAndPromises[0].id, /^todo_[a-z0-9]+$/);
    assert.equal(data.stateLedger.todosAndPromises[0].text, "明日在城门会合");
    assert.equal(data.stateLedger.todosAndPromises[0].completed, false);
});

test("model-completed todos stay visible for one round and are removed next round", () => {
    const previous = {
        time: "傍晚",
        characters: {},
        todosAndPromises: [
            { id: "todo_gate", text: "明日在城门会合", completed: false },
        ],
    };
    const marked = mergeStateLedger(previous, {
        time: "入夜",
        characters: {},
        todosAndPromises: [
            { id: "todo_gate", text: "明日在城门会合", completed: true },
        ],
    }, 3);

    assert.equal(marked.todosAndPromises[0].completed, true);
    assert.equal(marked.todosAndPromises[0].completedRound, 3);
    assert.equal(marked.todosAndPromises[0].completedBy, "model");

    const nextRound = mergeStateLedger(marked, {
        time: "次日清晨",
        characters: {},
        todosAndPromises: [],
    }, 4);
    assert.deepEqual(nextRound.todosAndPromises, []);
});

test("player-completed todos are removed by the next archive update", () => {
    const finished = {
        time: "夜间",
        characters: {},
        todosAndPromises: [
            {
                id: "todo_player",
                text: "把钥匙还给苏晚",
                completed: true,
                completedRound: 4,
                completedBy: "player",
            },
        ],
    };
    const merged = mergeStateLedger(finished, {
        time: "次日",
        characters: {},
        todosAndPromises: [],
    }, 5);

    assert.deepEqual(merged.todosAndPromises, []);
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
    const data = memoryWithRounds(40);
    data.levels[0][0].text = "编辑后的第一轮";
    stubChatCompletion("重建摘要");

    await rebuildMemoryHierarchy(SETTINGS, data);
    assert.ok(data.levels[0].length >= 6);
    assert.ok(data.levels[1].length > 0);
    assert.ok(data.levels[2].length > 0);
    assert.ok(data.levels[3].length > 0);
    assert.doesNotMatch(JSON.stringify(data.levels[1]), /旧的高层摘要/);
    assert.equal(data.archivePool[0].text, "编辑后的第一轮");
});

test("top memory level keeps anchors and recent entries without growing forever", () => {
    const data = createEmptyMemoryData();
    for (let round = 1; round <= 100; round += 5) {
        data.levels[3].push({
            id: `L3_${round}`,
            level: 3,
            roundRange: `${round}-${round + 4}`,
            text: `阶段${round}`,
        });
    }

    normalizeMemoryData(data);
    assert.equal(data.levels[3].length, 16);
    assert.equal(data.levels[3][0].roundRange, "1-5");
    assert.equal(data.levels[3].at(-1).roundRange, "96-100");
    assert.equal(data.fadedHistory.count, 4);
    assert.equal(data.pendingFarHistory.length, 4);
    assert.equal(data.fadedHistory.earliestRound, 21);
    assert.equal(data.fadedHistory.latestRound, 40);
});

test("far history is folded into one story-time summary", async () => {
    const data = createEmptyMemoryData();
    data.pendingFarHistory = [
        { roundRange: "1-5", text: "第一阶段的旧事", level: 3 },
        { roundRange: "6-10", text: "第二阶段的旧事", level: 3 },
    ];
    stubChatCompletion("不应使用");

    await checkAndCascadeMerge(SETTINGS, data);
    assert.equal(data.pendingFarHistory.length, 0);
    assert.match(data.farHistory.text, /景和三年春/);
    assert.equal(data.farHistory.earliestRound, 1);
    assert.equal(data.farHistory.latestRound, 10);
});

test("memory prompt respects the configured token budget", () => {
    const data = createEmptyMemoryData();
    data.stateLedger = {
        time: "未知",
        characters: {
            玩家: {
                canonicalName: "玩家",
                aliases: [],
                location: "极长地点名".repeat(300),
                statusAndAction: "极长状态".repeat(800),
                wear: "极长衣着".repeat(300),
                removedItemsLock: [],
                inventory: [],
                present: true,
            },
        },
        todosAndPromises: [],
    };
    for (let lvl = 1; lvl <= 3; lvl++) {
        for (let i = 0; i < 16; i++) {
            data.levels[lvl].push({
                id: `L${lvl}_${i}`,
                level: lvl,
                roundRange: `${i + 1}`,
                text: "长篇剧情摘要".repeat(80),
            });
        }
    }
    for (let i = 0; i < 8; i++) {
        data.levels[0].push({
            id: `L0_${i}`,
            level: 0,
            roundRange: `${i + 1}`,
            text: "最近剧情摘要".repeat(30),
        });
    }

    const prompt = buildInjectedMemoryPrompt(data, [], "", 1000);
    assert.ok(estimatePromptTokens(prompt) <= 1000);
});

test("raw recent rounds are not duplicated as injected L0 summaries", () => {
    const data = createEmptyMemoryData();
    data.stateLedger = { time: "未知", characters: {}, todosAndPromises: [] };
    for (let round = 1; round <= 8; round++) {
        data.levels[0].push({
            id: `L0_${round}`,
            level: 0,
            roundRange: String(round),
            startMessageId: round * 2 - 2,
            endMessageId: round * 2 - 1,
            text: `第${round}轮摘要`,
        });
    }

    const prompt = buildInjectedMemoryPrompt(data, [], "", 5000, {
        recentRawRounds: 5,
        currentRound: 8,
    });
    assert.match(prompt, /第1轮摘要/);
    assert.match(prompt, /第3轮摘要/);
    assert.doesNotMatch(prompt, /第4轮摘要/);
    assert.doesNotMatch(prompt, /第8轮摘要/);
});

test("history backfill saves in batches instead of after every round", async () => {
    const data = createEmptyMemoryData();
    const chat = [];
    for (let round = 1; round <= 6; round++) {
        chat.push({ is_user: true, mes: `玩家 ${round}` });
        chat.push({ is_user: false, name: "角色", mes: `回复 ${round}` });
    }
    stubChatCompletion("批量总结");
    let saves = 0;
    const result = await backfillExistingChatHistory(
        { ...SETTINGS, mergeChunkSize: 20 },
        data,
        chat,
        "玩家",
        "角色",
        {
            saveEvery: 2,
            onChunkSaved: async () => { saves++; },
        },
    );

    assert.equal(result.processedCount, 6);
    assert.equal(saves, 3);
});

test("history backfill sends the card opening with the first real round", async () => {
    const data = createEmptyMemoryData();
    const chat = [
        { is_user: false, name: "角色", mes: "这是卡片开场白。" },
        { is_user: true, name: "玩家", mes: "这是第一句话。" },
        { is_user: false, name: "角色", mes: "这是第一个回复。" },
    ];
    let capturedPrompt = "";
    globalThis.fetch = async (_url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        capturedPrompt = body.messages.map(message => message.content || "").join("\n");
        const content = JSON.stringify({
            l0_summary: "开场与第一轮",
            keywords: ["开场"],
            stateLedger: { time: "开始", characters: {}, todosAndPromises: [] },
        });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    const result = await backfillExistingChatHistory(
        { ...SETTINGS, mergeChunkSize: 20 },
        data,
        chat,
        "玩家",
        "角色",
    );
    assert.equal(result.processedCount, 1);
    assert.match(capturedPrompt, /开场白·角色[\s\S]*这是卡片开场白/);
    assert.match(capturedPrompt, /玩家[\s\S]*这是第一句话/);
    assert.equal(data.archivePool[0].roundRange, "1");
    assert.equal(data.archivePool[0].startMessageId, 0);
    assert.equal(data.archivePool[0].endMessageId, 2);
});

test("state snapshots use keyframes plus deltas without losing rollback accuracy", async () => {
    const data = memoryWithRounds(1);
    stubChatCompletion("第二轮摘要");
    await summarizeSingleTurn(SETTINGS, data, {
        roundNumber: 2,
        startMessageId: 2,
        endMessageId: 3,
        userName: "我",
        charName: "小明",
        dialogueText: "第二轮对话",
    });

    const second = data.archivePool.find(item => item.roundRange === "2");
    assert.equal(second.postStateSnapshot, undefined);
    assert.ok(second.postStateDelta);
    const state = resolveStateLedgerAfterEntry(data, second);
    assert.equal(state.characters.小明.location, "客厅");

    assert.equal(rollbackMemoryFromMessageIndex(data, 2), true);
    assert.equal(data.stateLedger.characters.小明, undefined);
});

test("legacy full snapshots are migrated to keyframes and deltas on load", () => {
    const data = createEmptyMemoryData();
    data.stateStorageVersion = 1;
    for (let round = 1; round <= 3; round++) {
        const entry = {
            id: `L0_${round}`,
            level: 0,
            roundRange: String(round),
            startMessageId: round * 2 - 2,
            endMessageId: round * 2 - 1,
            text: `第${round}轮`,
            postStateSnapshot: {
                time: `第${round}日`,
                characters: {
                    小明: {
                        location: `地点${round}`,
                        statusAndAction: "等待",
                        wear: "长衣",
                        removedItemsLock: [],
                        inventory: [],
                    },
                },
                todosAndPromises: [],
            },
        };
        data.levels[0].push(entry);
        data.archivePool.push(entry);
    }

    normalizeMemoryData(data);
    assert.equal(data.archivePool[0].postStateSnapshot.time, "第1日");
    assert.equal(data.archivePool[1].postStateSnapshot, undefined);
    assert.ok(data.archivePool[1].postStateDelta);
    assert.equal(resolveStateLedgerAfterEntry(data, data.archivePool[2]).characters.小明.location, "地点3");
});

test("legacy standalone opening entries are folded into the first real round", () => {
    const opening = {
        id: "L0_opening",
        level: 0,
        roundRange: "1",
        startMessageId: 0,
        endMessageId: 0,
        text: "开场摘要",
    };
    const firstRound = {
        id: "L0_first",
        level: 0,
        roundRange: "2",
        startMessageId: 1,
        endMessageId: 2,
        text: "第一轮真实对话",
    };
    const data = {
        ...createEmptyMemoryData(),
        version: 3,
        lastProcessedMessageId: 2,
        lastProcessedRound: 2,
        levels: { 0: [opening, firstRound], 1: [], 2: [], 3: [] },
        archivePool: [opening, firstRound],
    };

    normalizeMemoryData(data);
    assert.equal(data.version, 4);
    assert.equal(data.archivePool.length, 1);
    assert.equal(data.archivePool[0].id, "L0_first");
    assert.equal(data.archivePool[0].roundRange, "1");
    assert.equal(data.archivePool[0].startMessageId, 0);
    assert.match(data.archivePool[0].text, /开场背景.*开场摘要/);
    assert.equal(data.lastProcessedRound, 1);

    const openingOnly = {
        ...createEmptyMemoryData(),
        version: 3,
        lastProcessedMessageId: 0,
        lastProcessedRound: 1,
        levels: { 0: [opening], 1: [], 2: [], 3: [] },
        archivePool: [opening],
    };
    normalizeMemoryData(openingOnly);
    assert.equal(openingOnly.archivePool.length, 0);
    assert.equal(openingOnly.lastProcessedMessageId, -1);
    assert.equal(openingOnly.lastProcessedRound, 0);
});

test("safeParseJSON tolerates code fences, commentary and trailing commas", () => {
    const parsed = safeParseJSON(`说明文字
\`\`\`json
{
  "l0_summary": "测试摘要",
  "keywords": ["甲", "乙",],
  "stateLedger": {"time": "清晨", "characters": {}, "todosAndPromises": []}
}
\`\`\`
后续说明`);
    assert.equal(parsed.l0_summary, "测试摘要");
    assert.deepEqual(parsed.keywords, ["甲", "乙"]);
});

test("summary retries malformed model output without duplicating L0", async () => {
    const data = createEmptyMemoryData();
    let calls = 0;
    globalThis.fetch = async (_url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        const isMerge = body.messages?.[0]?.content?.includes("叙事剧情时间线提炼引擎");
        if (isMerge) {
            return new Response(JSON.stringify({ choices: [{ message: { content: "合并摘要" } }] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        calls++;
        const content = calls === 1
            ? "这不是 JSON"
            : JSON.stringify({
                l0_summary: "重试后得到的有效摘要",
                keywords: ["重试"],
                stateLedger: {
                    time: "清晨",
                    characters: { 阿青: { location: "门口", statusAndAction: "等待", wear: "长衣", removedItemsLock: [], inventory: [] } },
                    todosAndPromises: [],
                },
            });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    const result = await summarizeSingleTurn(
        { ...SETTINGS, summaryRetryCount: 1, mergeChunkSize: 20 },
        data,
        {
            roundNumber: 1,
            startMessageId: 0,
            endMessageId: 1,
            userName: "旁观者",
            charName: "群像卡",
            dialogueText: "【旁白】：阿青在门口等待。",
        },
    );

    assert.equal(calls, 2);
    assert.equal(result.text, "重试后得到的有效摘要");
    assert.equal(data.levels[0].length, 1);
    assert.equal(data.archivePool.length, 1);
});

test("empty strip tags mean no built-in tags are removed", () => {
    const text = "<thinking>内部推理</thinking>正文内容<details>完整设定</details>";
    assert.equal(cleanMessageText(text, "", ""), text);
    assert.equal(cleanMessageText(text, "", "thinking"), "正文内容<details>完整设定</details>");
    assert.equal(cleanMessageText(text, "", "thinking,details"), "正文内容");
});

test("injected ledger puts the user's own entry first", () => {
    const data = createEmptyMemoryData();
    data.stateLedger.characters = {
        群像卡: { location: "广场", statusAndAction: "观望", wear: "斗篷", removedItemsLock: [], inventory: [] },
        玩家甲: { location: "钟楼", statusAndAction: "俯瞰", wear: "长衣", removedItemsLock: [], inventory: [] },
    };
    const prompt = buildInjectedMemoryPrompt(data, [], "玩家甲");
    assert.ok(prompt.indexOf("【玩家甲】") < prompt.indexOf("【群像卡】"));
});

test("completed todos are not injected as active tasks", () => {
    const data = createEmptyMemoryData();
    data.stateLedger.todosAndPromises = [
        { id: "todo_open", text: " OPEN_TASK ", completed: false },
        { id: "todo_done", text: "DONE_TASK", completed: true, completedRound: 4 },
    ];
    const prompt = buildInjectedMemoryPrompt(data, [], "玩家甲");

    assert.match(prompt, /OPEN_TASK/);
    assert.doesNotMatch(prompt, /DONE_TASK/);
});

test("pending AI turns include earlier gaps before the current reply", () => {
    const chat = [
        { is_user: true, mes: "u1" },
        { is_user: false, mes: "a1" },
        { is_user: true, mes: "u2" },
        { is_user: false, mes: "a2" },
        { is_user: true, mes: "u3" },
        { is_user: false, mes: "a3" },
    ];
    const pending = collectPendingAiTurns(chat, 1, 5);
    assert.deepEqual(pending.map(x => x.idx), [3, 5]);
    assert.deepEqual(pending.map(x => x.round), [2, 3]);
});

test("welcome screen context is not treated as an active chat", () => {
    assert.equal(isActiveChatContext({
        getCurrentChatId: () => undefined,
        characterId: undefined,
        groupId: null,
    }), false);
    assert.equal(isActiveChatContext({
        getCurrentChatId: () => "",
        characterId: 0,
    }), false);
    assert.equal(isActiveChatContext({
        getCurrentChatId: () => "Chat 2026-11-15",
        characterId: 0,
    }), true);
    assert.equal(isActiveChatContext({ chatId: "Chat 2026-11-15" }), true);
    assert.equal(isActiveChatContext({ characterId: 0 }), true);
    assert.equal(isActiveChatContext({ groupId: "group-1" }), true);
});

test("card opening is a prologue folded into the first real round", () => {
    const chat = [
        { is_user: false, name: "角色", mes: "开场白" },
        { is_user: true, mes: "第一句话" },
        { is_user: false, name: "角色", mes: "第一个回复" },
        { is_user: true, mes: "第二句话" },
        { is_user: false, name: "角色", mes: "第二个回复" },
    ];
    assert.equal(isOpeningAiMessage(chat, 0), true);
    assert.equal(calculateRoundForMessageIndex(chat, 0), 1);
    assert.equal(calculateRoundForMessageIndex(chat, 2), 1);
    assert.equal(calculateRoundForMessageIndex(chat, 4), 2);
    assert.deepEqual(
        collectPendingAiTurns(chat, -1).map(item => [item.idx, item.round]),
        [[2, 1], [4, 2]],
    );
    assert.deepEqual(getRoundMessageWindow(chat, 2), {
        roundNumber: 1,
        startMessageId: 0,
        endMessageId: 2,
        userMessageIndex: 1,
        openingMessageIndex: 0,
    });
    assert.equal(getRoundMessageWindow(chat, 0), null);
    assert.deepEqual(getRoundMessageWindow(chat, 4), {
        roundNumber: 2,
        startMessageId: 3,
        endMessageId: 4,
        userMessageIndex: 3,
        openingMessageIndex: -1,
    });
});

test("user-starting chats and system-prefixed openings use the same round rules", () => {
    const userStart = [
        { is_user: true, mes: "玩家自定义开场" },
        { is_user: false, mes: "AI 回复" },
    ];
    assert.equal(getOpeningAiMessageIndex(userStart), -1);
    assert.deepEqual(
        collectPendingAiTurns(userStart, -1).map(item => [item.idx, item.round]),
        [[1, 1]],
    );
    assert.deepEqual(getRoundMessageWindow(userStart, 1), {
        roundNumber: 1,
        startMessageId: 0,
        endMessageId: 1,
        userMessageIndex: 0,
        openingMessageIndex: -1,
    });

    const systemPrefixed = [
        { is_user: false, is_system: true, mes: "系统提示" },
        { is_user: false, mes: "卡片开场白" },
        { is_user: true, mes: "第一句话" },
        { is_user: false, mes: "第一个回复" },
    ];
    assert.equal(getOpeningAiMessageIndex(systemPrefixed), 1);
    assert.equal(calculateRoundForMessageIndex(systemPrefixed, 3), 1);
    assert.deepEqual(getRoundMessageWindow(systemPrefixed, 3), {
        roundNumber: 1,
        startMessageId: 1,
        endMessageId: 3,
        userMessageIndex: 2,
        openingMessageIndex: 1,
    });
    assert.equal(computeHiddenMessageCutoff(systemPrefixed, 1, 3), 2);
});

test("native hidden AI floors can be included explicitly for legacy migration", () => {
    const chat = [
        { is_user: true, mes: "hello" },
        { is_user: false, is_system: true, mes: "native hidden reply" },
        { is_user: false, mes: "visible reply" },
    ];
    assert.equal(isAiReplyMessage(chat[1]), false);
    assert.equal(isAiReplyMessage(chat[1], true), true);
    assert.equal(calculateRoundForMessageIndex(chat, 2), 1);
    assert.equal(calculateRoundForMessageIndex(chat, 2, true), 2);
    assert.equal(collectPendingAiTurns(chat, -1, 2).length, 1);
    assert.equal(collectPendingAiTurns(chat, -1, 2, true).length, 2);
});

test("character aliases merge into one stable ledger entry", () => {
    const merged = mergeStateLedger(
        {
            time: "上午",
            characters: {
                苏晚: {
                    canonicalName: "苏晚",
                    aliases: ["晚晚"],
                    location: "客厅",
                    statusAndAction: "坐着",
                    wear: "长裙",
                    removedItemsLock: [],
                    inventory: ["钥匙"],
                    present: true,
                    lastSeenRound: 2,
                },
            },
            todosAndPromises: [],
        },
        {
            time: "下午",
            characters: {
                苏小姐: {
                    canonicalName: "苏晚",
                    aliases: ["苏小姐"],
                    location: "花园",
                    statusAndAction: "散步",
                    wear: "长裙",
                    removedItemsLock: [],
                    inventory: [],
                    present: true,
                },
            },
            todosAndPromises: [],
        },
        5,
    );
    assert.deepEqual(Object.keys(merged.characters), ["苏晚"]);
    assert.equal(merged.characters.苏晚.lastSeenRound, 5);
    assert.ok(merged.characters.苏晚.aliases.includes("苏小姐"));
});

test("omitted characters keep their away state instead of being resurrected", () => {
    const merged = mergeStateLedger(
        {
            time: "夜晚",
            characters: {
                苏晚: {
                    location: "门外",
                    statusAndAction: "离开",
                    wear: "长裙",
                    removedItemsLock: [],
                    inventory: [],
                    present: false,
                    lastSeenRound: 4,
                },
            },
            todosAndPromises: [],
        },
        {
            time: "清晨",
            characters: {
                阿青: {
                    location: "客厅",
                    statusAndAction: "等待",
                    wear: "长衣",
                    removedItemsLock: [],
                    inventory: [],
                    present: true,
                },
            },
            todosAndPromises: [],
        },
        5,
    );
    assert.equal(merged.characters.苏晚.present, false);
    assert.equal(merged.characters.苏晚.lastSeenRound, 4);
});

test("placeholder character keys are migrated without touching real names", () => {
    const data = createEmptyMemoryData();
    data.stateLedger.characters = {
        User: { location: "钟楼", statusAndAction: "观察", wear: "长衣", removedItemsLock: [], inventory: [] },
        Character: { location: "广场", statusAndAction: "等待", wear: "斗篷", removedItemsLock: [], inventory: [] },
        苏晚: { location: "门厅", statusAndAction: "阅读", wear: "长裙", removedItemsLock: [], inventory: [] },
    };
    assert.equal(cleanupPlaceholderCharacters(data, "玩家甲"), true);
    assert.deepEqual(Object.keys(data.stateLedger.characters).sort(), ["玩家甲", "苏晚"].sort());
});

test("large character ledgers keep player and recent entries", () => {
    const data = createEmptyMemoryData();
    for (let i = 0; i < 70; i++) {
        data.stateLedger.characters[`角色${i}`] = {
            location: "某地",
            statusAndAction: "在场",
            wear: "常服",
            removedItemsLock: [],
            inventory: [],
            present: true,
            lastSeenRound: i,
        };
    }
    data.stateLedger.characters.玩家甲 = {
        location: "钟楼",
        statusAndAction: "观察",
        wear: "长衣",
        removedItemsLock: [],
        inventory: [],
        present: true,
        lastSeenRound: 1,
    };
    assert.equal(pruneStaleCharacters(data, 100, { keepNames: ["玩家甲"], maxCharacters: 60 }), true);
    assert.equal(Object.keys(data.stateLedger.characters).length, 60);
    assert.ok(data.stateLedger.characters.玩家甲);
    assert.ok(data.stateLedger.characters.角色69);
    assert.equal(data.stateLedger.characters.角色0, undefined);
});

test("JSON mode falls back once when a provider rejects response_format", async () => {
    const bodies = [];
    globalThis.fetch = async (_url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        bodies.push(body);
        if (bodies.length === 1) {
            return new Response("response_format unsupported", { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    const reply = await callIndependentLLM(
        { ...SETTINGS, useJsonMode: true },
        [{ role: "user", content: "测试" }],
    );
    assert.equal(reply, "连接成功");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].response_format.type, "json_object");
    assert.equal(bodies[1].response_format, undefined);
});

test("summary API requests honor an external abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => callIndependentLLM(SETTINGS, [{ role: "user", content: "测试" }], {
            signal: controller.signal,
        }),
        error => error?.name === "AbortError" && /已停止/.test(error.message),
    );
});

test("external stop rejects even when the transport ignores abort", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Promise(() => {});
    const controller = new AbortController();
    try {
        const request = callIndependentLLM(SETTINGS, [{ role: "user", content: "测试" }], {
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 5);
        await assert.rejects(
            request,
            error => error?.name === "AbortError" && /已停止/.test(error.message),
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("rate limit responses expose Retry-After to the retry loop", async () => {
    globalThis.fetch = async () => new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "2" },
    });
    await assert.rejects(
        () => callIndependentLLM({ ...SETTINGS, useJsonMode: false }, [{ role: "user", content: "测试" }]),
        error => error.status === 429 && error.retryAfterMs === 2000,
    );
});

test("truncated model output is reported instead of parsed as a valid response", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{
            message: { content: "{\"l0_summary\":\"被截断" },
            finish_reason: "length",
        }],
        usage: { completion_tokens: 4000 },
    }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });

    await assert.rejects(
        () => callIndependentLLM(
            { ...SETTINGS, maxTokens: 4000, useJsonMode: false },
            [{ role: "user", content: "测试" }],
        ),
        error => error.code === "OUTPUT_TRUNCATED"
            && error.finishReason === "length"
            && /max_tokens=4000/.test(error.message),
    );
});

test("finish reason variants and provider-specific fields are recognized", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
        candidates: [{ finishReason: "MAX_TOKENS" }],
    }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
        () => callIndependentLLM(
            { ...SETTINGS, maxTokens: 2000, useJsonMode: false },
            [{ role: "user", content: "测试" }],
        ),
        error => error.code === "OUTPUT_TRUNCATED"
            && error.finishReason === "max_tokens"
            && /max_tokens=2000/.test(error.message),
    );
});

test("blocked provider responses are surfaced without retrying", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{
            message: { content: "" },
            finish_reason: "CONTENT_FILTER",
        }],
    }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
        () => callIndependentLLM(
            { ...SETTINGS, useJsonMode: false },
            [{ role: "user", content: "测试" }],
        ),
        error => error.code === "OUTPUT_BLOCKED"
            && error.finishReason === "content_filter",
    );
});

test("response body reads cannot hang after headers have arrived", async () => {
    const response = {
        body: { cancel: () => Promise.resolve() },
        text: () => new Promise(() => {}),
    };
    await assert.rejects(
        () => readResponseText(response, 100),
        /响应体读取超时/,
    );
});

test("round index computes every window in one pass", () => {
    const chat = [
        { is_user: false, name: "角色", mes: "开场白" },
        { is_user: true, mes: "第一句话" },
        { is_user: false, name: "角色", mes: "第一个回复" },
        { is_user: true, mes: "第二句话" },
        { is_user: false, name: "角色", mes: "第二个回复" },
    ];
    const index = buildRoundMessageIndex(chat);
    assert.equal(index.openingIndex, 0);
    assert.deepEqual(index.aiTurns.map(turn => [turn.idx, turn.round]), [[2, 1], [4, 2]]);
    assert.deepEqual(index.aiTurns[0].window, getRoundMessageWindow(chat, 2));
    assert.deepEqual(index.aiTurns[1].window, getRoundMessageWindow(chat, 4));
});

test("range resummarize invalidation removes only overlapping derived summaries", () => {
    const data = createEmptyMemoryData();
    data.levels[1] = [
        { id: "L1_a", level: 1, roundRange: "1-5", text: "保留" },
        { id: "L1_b", level: 1, roundRange: "6-10", text: "失效" },
        { id: "L1_c", level: 1, roundRange: "11-15", text: "保留" },
    ];
    data.pendingFarHistory = [
        { roundRange: "6-10", text: "失效待合并" },
        { roundRange: "16-20", text: "保留待合并" },
    ];
    data.farHistory = {
        text: "包含第 6-10 轮的旧远史",
        earliestRound: 1,
        latestRound: 10,
        updatedAt: 1,
    };
    data.fadedHistory = { earliestRound: 1, latestRound: 10, count: 2 };

    assert.equal(invalidateDerivedSummariesInRange(data, 6, 10), true);
    assert.deepEqual(data.levels[1].map(item => item.id), ["L1_a", "L1_c"]);
    assert.deepEqual(data.pendingFarHistory.map(item => item.roundRange), ["16-20"]);
    assert.equal(data.farHistory.text, "");
    assert.equal(data.fadedHistory.count, 0);
});
