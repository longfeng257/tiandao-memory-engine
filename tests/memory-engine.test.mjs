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
    const text = "<thinking>内部推理</thinking>正文内容";
    assert.equal(cleanMessageText(text, "", ""), text);
    assert.equal(cleanMessageText(text, "", "thinking"), "正文内容");
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
