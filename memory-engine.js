/**
 * 天道·溯微记忆引擎 (Tiandao Memory Engine) - 核心引擎模块
 *
 * 核心设计：
 * 1. 按“一问一答轮数 (Round)”进行叙事归档与时间线提炼（绝非生硬楼层，一问一答即为一轮）。
 * 2. 结构化人物物理状态账本：按在场各角色（不仅是 User）分别追踪：地点、状态与行动、衣着穿戴、已摘除饰品锁（防人设回滚）、随身道具。
 * 3. 纯故事叙事时间线记忆金字塔：用时间跨度与叙事文本串联剧情（例如：第1轮某年某月某日上午发生…，第5轮某日晚上…），告别冰冷代码感。
 * 4. 重Roll回滚快照与存量断点续传。
 */

export const DEFAULT_SETTINGS = {
    enabled: true,
    autoSummarizePerTurn: true,
    summarizeTiming: "on_next_send", // "on_next_send": 等玩家发送下一条消息时再总结上一轮(重Roll零浪费) | "after_reply": AI回复完立即总结
    autoHideOldMessages: true,       // 默认开启：只向主模型发送最近 N 轮完整一问一答原文，超出的旧轮次自动隐藏只看插件总结
    keepRecentRoundsCount: 3,        // 发送给主模型的最近完整一问一答轮数（默认3轮，即最近6条正文，超出部分自动隐藏）

    // 独立总结 API 设置 (OpenAI 兼容格式: DeepSeek / Gemini / 硅基流动 / OpenRouter / NewAPI 等)
    apiUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 2000,

    // 正文提取设置 (白名单优先：指定标签时直接提取内部正文；未匹配时走黑名单排除)
    targetContentTags: "content,story,reply", // 目标提取标签（逗号分隔，如 content, story, reply，匹配到则直接只提取内部正文）
    customStripTags: "thinking,think,report,options_engine,small_theater,status_bar", // 备用排除标签

    // 悬浮窗设置
    showFloatingWidget: true, // 是否在聊天窗口显示实时记忆悬浮看板

    // 递归合并树参数
    mergeChunkSize: 5, // 每满 5 轮向上合并为 1 条阶段脉络 (例如: 1~5轮 -> 1条L1, 5条L1 -> 1条L2)
    maxLevel: 3,       // 最大递归层级 (L0 -> L1 -> L2 -> L3)

    // 向量与关键词混合检索设置 (召回陈年小事)
    enableRetrieval: true,
    retrievalTopK: 3,  // 每轮最多召回几条陈年细节小事
    useEmbeddingApi: false,
    embeddingApiUrl: "https://api.siliconflow.cn/v1",
    embeddingApiKey: "",
    embeddingModel: "BAAI/bge-m3",

    // 注入位置设置
    injectionPosition: 1, // 0: 聊天历史后(In-Prompt), 1: 聊天历史中(In-chat @ depth), 2: 主提示词前(Before Main Prompt)
    injectionDepth: 4,
    injectionRole: 0,     // 0: system, 1: user, 2: assistant
};

/**
 * 深拷贝辅助函数
 */
export function deepClone(obj) {
    if (!obj || typeof obj !== "object") return obj;
    return JSON.parse(JSON.stringify(obj));
}

/**
 * 创建空白的聊天记忆元数据结构（绑定在当前 chat_metadata.tiandao_memory 上）
 */
export function createEmptyMemoryData() {
    return {
        version: 3,
        lastProcessedMessageId: -1,
        lastProcessedRound: 0,
        // 常驻动态状态账本（按人物深度追踪，永不因压缩丢失）
        stateLedger: {
            time: "未知时间",
            characters: {},
            todosAndPromises: [],
        },
        levels: {
            0: [],
            1: [],
            2: [],
            3: [],
        },
        archivePool: [],
    };
}

/**
 * 解析 roundRange 字符串（如 "1-5" 或 "3"）为起止数字
 */
export function parseRoundRange(roundRange) {
    const str = String(roundRange || "0").trim();
    const parts = str.split("-").map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n));
    if (parts.length === 0) return { start: 0, end: 0 };
    if (parts.length === 1) return { start: parts[0], end: parts[0] };
    return { start: Math.min(...parts), end: Math.max(...parts) };
}

/**
 * 根据聊天记录计算某条 AI 消息对应的真实“第几轮 (Round)”
 * 规则：一问一答算一轮（统计该消息及之前出现的非 user、非纯 system 回复总数）
 */
export function calculateRoundForMessageIndex(chat, messageIndex) {
    if (!Array.isArray(chat) || messageIndex < 0 || messageIndex >= chat.length) return 1;
    let round = 0;
    for (let i = 0; i <= messageIndex; i++) {
        const msg = chat[i];
        if (msg && !msg.is_user && (!msg.is_system || msg.extra?.tiandao_hidden)) {
            round++;
        }
    }
    return Math.max(1, round);
}

/**
 * 当发生重Roll (Swipe)、编辑或删除楼层时，回滚并清理 >= cutoffMessageId 的 L0 记忆与状态账本
 */
export function rollbackMemoryFromMessageIndex(memoryData, cutoffMessageId) {
    if (!memoryData || typeof cutoffMessageId !== "number" || cutoffMessageId < 0) return false;

    const l0List = memoryData.levels?.[0] || [];
    const archiveList = memoryData.archivePool || [];

    const removedFromArchive = archiveList
        .filter(item => (item.endMessageId ?? parseRoundRange(item.roundRange).start) >= cutoffMessageId)
        .sort((a, b) => (a.startMessageId ?? 0) - (b.startMessageId ?? 0));

    let rolledBack = false;
    if (removedFromArchive.length > 0) {
        rolledBack = true;
        const earliestRemoved = removedFromArchive[0];
        if (earliestRemoved.preStateSnapshot) {
            memoryData.stateLedger = deepClone(earliestRemoved.preStateSnapshot);
        } else {
            const remainingBefore = archiveList
                .filter(item => (item.endMessageId ?? 0) < cutoffMessageId && item.postStateSnapshot);
            if (remainingBefore.length > 0) {
                memoryData.stateLedger = deepClone(remainingBefore[remainingBefore.length - 1].postStateSnapshot);
            }
        }
    }

    if (Array.isArray(memoryData.levels?.[0])) {
        memoryData.levels[0] = l0List.filter(item => (item.endMessageId ?? parseRoundRange(item.roundRange).start) < cutoffMessageId);
    }
    if (Array.isArray(memoryData.archivePool)) {
        memoryData.archivePool = archiveList.filter(item => (item.endMessageId ?? parseRoundRange(item.roundRange).start) < cutoffMessageId);
    }

    const remainingEnds = (memoryData.archivePool || []).map(item => item.endMessageId ?? 0);
    memoryData.lastProcessedMessageId = remainingEnds.length > 0 ? Math.max(...remainingEnds) : -1;
    
    const remainingRounds = (memoryData.archivePool || []).map(item => parseRoundRange(item.roundRange).end);
    memoryData.lastProcessedRound = remainingRounds.length > 0 ? Math.max(...remainingRounds) : 0;

    return rolledBack;
}

/**
 * 提取与清理模型输出的正文
 */
export function cleanMessageText(rawText, targetContentTagsStr = "", customStripTagsStr = "") {
    if (!rawText) return "";
    let text = String(rawText);

    const targetTags = String(targetContentTagsStr || "")
        .split(/[,，\s]+/)
        .map(t => t.trim().replace(/^<|>$/g, ""))
        .filter(Boolean);

    if (targetTags.length > 0) {
        for (const tag of targetTags) {
            const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const reg = new RegExp(`<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTag}>`, "i");
            const match = text.match(reg);
            if (match && match[1] && match[1].trim()) {
                return match[1].trim();
            }
        }
    }

    const defaultTags = ["thinking", "think", "report", "options_engine", "small_theater", "status_bar"];
    const customTags = String(customStripTagsStr || "")
        .split(/[,，\s]+/)
        .map(t => t.trim().replace(/^<|>$/g, ""))
        .filter(Boolean);
    const allTags = Array.from(new Set([...defaultTags, ...customTags]));

    for (const tag of allTags) {
        const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const reg = new RegExp(`<${safeTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${safeTag}>`, "gi");
        text = text.replace(reg, "");
    }

    text = text.replace(/<details[\s\S]*?<\/details>/gi, "").trim();
    return text;
}

/**
 * 调用独立配置的 OpenAI 兼容 Chat Completions API
 */
export async function callIndependentLLM(settings, messages) {
    const baseUrl = (settings.apiUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl) {
        throw new Error("未配置独立总结 API 地址 (API URL)");
    }
    if (!settings.apiKey || !settings.apiKey.trim()) {
        throw new Error("未配置独立总结 API Key");
    }

    const endpoint = baseUrl.endsWith("/chat/completions")
        ? baseUrl
        : `${baseUrl}/chat/completions`;

    const body = {
        model: settings.model || "deepseek-chat",
        messages: messages,
        temperature: Number(settings.temperature ?? 0.2),
        max_tokens: Number(settings.maxTokens ?? 2000),
    };

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${settings.apiKey.trim()}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`独立 API 请求失败 (${response.status}): ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return content.trim();
}

/**
 * 从独立 API 返回文本中安全解析 JSON
 */
export function safeParseJSON(text) {
    if (!text) return null;
    let cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            try {
                return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
            } catch (e2) {
                console.error("[Tiandao Memory] JSON parse failed:", e2, text);
                return null;
            }
        }
        return null;
    }
}

/**
 * 调用 Embedding API 获取向量
 */
export async function getEmbeddingVector(settings, inputText) {
    if (!settings.useEmbeddingApi || !settings.embeddingApiUrl || !settings.embeddingApiKey) {
        return null;
    }
    try {
        const baseUrl = settings.embeddingApiUrl.trim().replace(/\/+$/, "");
        const endpoint = baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
        const res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.embeddingApiKey.trim()}`,
            },
            body: JSON.stringify({
                model: settings.embeddingModel || "BAAI/bge-m3",
                input: inputText.slice(0, 1000),
            }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.data?.[0]?.embedding || null;
    } catch (e) {
        console.warn("[Tiandao Memory] Embedding API fallback to local lexical search:", e);
        return null;
    }
}

/**
 * 单轮处理（一问一答算一轮）：
 * 1. 提取时间线纯叙事微摘要（格式：某年某月某日...发生在...）
 * 2. 按人物分别追踪：地点、状态与行动、衣着穿戴、已摘除饰品锁、随身道具
 */
export async function summarizeSingleTurn(settings, memoryData, turnInfo) {
    const { roundNumber, startMessageId, endMessageId, userName, charName, dialogueText } = turnInfo;
    const currentRound = Number(roundNumber || 1);

    if (memoryData.lastProcessedMessageId >= startMessageId) {
        rollbackMemoryFromMessageIndex(memoryData, startMessageId);
    }

    const preStateSnapshot = deepClone(memoryData.stateLedger);
    const currentStateJson = JSON.stringify(memoryData.stateLedger, null, 2);

    const systemPrompt = `你是一个高精度的长线角色扮演状态追踪器与纯叙事记忆引擎。
请阅读【上一轮各人物状态账本】与【最新一轮一问一答剧情】，输出严格的 JSON 格式结果。

核心要求：
1. **纯叙事时间线微摘要 (l0_summary)**：
   - 必须采用故事时间线口吻（拒绝任何代码感或“第X楼”等机械字眼）。
   - 范例：“[某年某月某日上午] 在客厅里，${charName}脱下外套并随手放在沙发上，与${userName}商定了明天的行程，心情逐渐放松...”
   - 精炼保留时间流逝、地点、剧情推进、情感互动细节与关键动作（80~140字）。
   - 提取 3~5 个关键词 (keywords)。
2. **按人物分别追踪物理状态 (characters)**：
   - 为出场的各个角色（包括主角 ${userName}、女/男主 ${charName}、以及其他重要在场配角）分别建立对象：
     * **location**：该角色当前具体所在的地点/房间。
     * **statusAndAction**：当前神态动作、心理状态或正在进行的行动。
     * **wear**：当前身上的衣着与穿戴（根据剧情穿脱实时更新）。
     * **removedItemsLock（核心防回滚锁·极其重要）**：
       - 只要该角色在剧情中摘下了某件饰品（如眼镜、耳环、发卡）或脱下了衣物（如外套、鞋袜），必须加入此数组！注明状态（例："金丝眼镜（已摘下放床头柜，当前未佩戴）"）。
       - **继承铁律**：上轮账本中该角色已有的已摘除饰品锁，只要本轮剧情未明确描写重新戴上，**必须原封不动保留**，严禁擅自清空！
     * **inventory**：该角色随身携带的重要信物、道具、钥匙、手机或关键物品（随身道具，上限 6 条）。
3. **todosAndPromises**：各角色间尚未完成的约定、日程或待办（已完成的事项移除，新约定加入）。

请严格按以下 JSON 结构返回：
{
  "l0_summary": "[具体时间] 剧情纯叙事...",
  "keywords": ["关键词1", "关键词2"],
  "stateLedger": {
    "time": "具体日期与时间段（例：春季某日上午）",
    "characters": {
      "${charName}": {
        "location": "当前具体地点",
        "statusAndAction": "神态动作与当前正在做的事",
        "wear": "当前衣着与佩戴",
        "removedItemsLock": ["已摘下/脱下未重新穿戴的饰品或衣物（未重戴绝不清除）"],
        "inventory": ["随身携带的关键道具/信物"]
      },
      "${userName}": {
        "location": "当前具体地点",
        "statusAndAction": "当前神态动作与行动",
        "wear": "当前衣着",
        "removedItemsLock": [],
        "inventory": ["随身携带的道具"]
      }
    },
    "todosAndPromises": [
      "未完成的约定或待办事项"
    ]
  }
}`;

    const userPrompt = `【当前剧情轮次】：第 ${currentRound} 轮
【主要在场人物】：User = ${userName}, Char = ${charName}

【上一轮人物状态账本 (请在此基础上增量更新，切勿丢失各角色的已摘除饰品锁)】：
${currentStateJson}

【第 ${currentRound} 轮一问一答剧情】：
${dialogueText}

请直接输出更新后的 JSON：`;

    const rawOutput = await callIndependentLLM(settings, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
    ]);

    const parsed = safeParseJSON(rawOutput);
    if (!parsed || !parsed.l0_summary) {
        throw new Error("模型返回格式无法解析为有效摘要 JSON: " + rawOutput.slice(0, 150));
    }

    if (parsed.stateLedger) {
        const nextChars = parsed.stateLedger.characters || {};
        const oldChars = memoryData.stateLedger.characters || {};
        const mergedChars = {};

        for (const [name, charData] of Object.entries(nextChars)) {
            mergedChars[name] = {
                location: charData.location || "未知位置",
                statusAndAction: charData.statusAndAction || "平静",
                wear: charData.wear || "日常衣着",
                removedItemsLock: Array.isArray(charData.removedItemsLock) ? charData.removedItemsLock.slice(0, 10) : [],
                inventory: Array.isArray(charData.inventory) ? charData.inventory.slice(0, 8) : [],
            };
        }

        for (const [name, oldData] of Object.entries(oldChars)) {
            if (!mergedChars[name] && oldData && (oldData.removedItemsLock || []).length > 0) {
                mergedChars[name] = oldData;
            }
        }

        memoryData.stateLedger = {
            time: parsed.stateLedger.time || memoryData.stateLedger.time || "未知时间",
            characters: mergedChars,
            todosAndPromises: Array.isArray(parsed.stateLedger.todosAndPromises)
                ? parsed.stateLedger.todosAndPromises.slice(0, 8)
                : (memoryData.stateLedger.todosAndPromises || []),
        };
    }

    const embedding = await getEmbeddingVector(settings, `${parsed.l0_summary} ${(parsed.keywords || []).join(" ")}`);
    const l0Entry = {
        id: `L0_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        level: 0,
        roundRange: String(currentRound),
        startMessageId: startMessageId,
        endMessageId: endMessageId,
        text: parsed.l0_summary.trim(),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        timestamp: Date.now(),
        embedding: embedding,
        preStateSnapshot: preStateSnapshot,
        postStateSnapshot: deepClone(memoryData.stateLedger),
    };

    if (!memoryData.levels[0]) memoryData.levels[0] = [];
    memoryData.levels[0].push(l0Entry);
    memoryData.archivePool.push(l0Entry);

    if (memoryData.archivePool.length > 10) {
        for (let i = 0; i < memoryData.archivePool.length - 10; i++) {
            delete memoryData.archivePool[i].preStateSnapshot;
            delete memoryData.archivePool[i].postStateSnapshot;
        }
    }

    await checkAndCascadeMerge(settings, memoryData);

    return l0Entry;
}

/**
 * 递归金字塔合并引擎（按轮次归并）
 */
export async function checkAndCascadeMerge(settings, memoryData) {
    const chunkSize = Math.max(2, Number(settings.mergeChunkSize || 5));
    const maxLevel = Math.max(2, Number(settings.maxLevel || 3));

    for (let lvl = 0; lvl < maxLevel; lvl++) {
        if (!Array.isArray(memoryData.levels[lvl])) {
            memoryData.levels[lvl] = [];
        }
        while (memoryData.levels[lvl].length >= chunkSize) {
            const itemsToMerge = memoryData.levels[lvl].slice(0, chunkSize);
            const firstRound = parseRoundRange(itemsToMerge[0].roundRange).start;
            const lastRound = parseRoundRange(itemsToMerge[itemsToMerge.length - 1].roundRange).end;
            const mergedRoundRange = `${firstRound}-${lastRound}`;

            const mergedText = await mergeSummariesAtLevel(settings, lvl, itemsToMerge, mergedRoundRange);

            memoryData.levels[lvl].splice(0, chunkSize);
            if (!Array.isArray(memoryData.levels[lvl + 1])) {
                memoryData.levels[lvl + 1] = [];
            }
            memoryData.levels[lvl + 1].push({
                id: `L${lvl + 1}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                level: lvl + 1,
                roundRange: mergedRoundRange,
                text: mergedText,
                timestamp: Date.now(),
            });
        }
    }
}

/**
 * 将 N 条同级轮次摘要合成为 1 条大阶段故事脉络
 */
async function mergeSummariesAtLevel(settings, currentLevel, items, mergedRoundRange) {
    const targetLevel = currentLevel + 1;
    const wordLimit = targetLevel === 1 ? "150~250字" : "250~400字";

    const systemPrompt = `你是一个叙事剧情时间线提炼引擎。
请将连续的 ${items.length} 轮【第 ${mergedRoundRange} 轮剧情微摘要】合并为一条连贯、高信息密度的【L${targetLevel} 故事脉络时间线】（篇幅 ${wordLimit}）。

合并要求：
1. **纯故事叙述，充满时间感**：用故事口吻描述这段时间的起承转合（例：“从某月某日上午...经过几番波折，直到当晚...”）。
2. 保留重要事件、人物关系情感转折、以及关键承诺或随身道具变动。
3. **直接输出合并后的纯叙事文本**，严禁包含任何代码或格式说明。`;

    const listText = items
        .map((it, idx) => `${idx + 1}. [第${it.roundRange}轮] ${it.text}`)
        .join("\n");

    const merged = await callIndependentLLM(settings, [
        { role: "system", content: systemPrompt },
        { role: "user", content: `请将以下时间线的各轮剧情摘要合并为一段连贯故事脉络：\n\n${listText}` },
    ]);

    return merged.replace(/^```[\s\S]*?\n/, "").replace(/```$/, "").trim();
}

/**
 * 混合检索回溯池
 */
function extractBigramsAndTokens(text) {
    if (!text) return new Set();
    const cleaned = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "");
    const set = new Set();
    for (let i = 0; i < cleaned.length - 1; i++) {
        set.add(cleaned.slice(i, i + 2));
    }
    const words = text.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    words.forEach(w => set.add(w));
    return set;
}

function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

export async function retrieveRelevantArchivedMemories(settings, memoryData, queryText) {
    if (!settings.enableRetrieval || !queryText || !Array.isArray(memoryData.archivePool)) {
        return [];
    }

    const activeL0Ids = new Set((memoryData.levels[0] || []).map(x => x.id));
    const candidates = memoryData.archivePool.filter(item => !activeL0Ids.has(item.id));
    if (candidates.length === 0) return [];

    const queryEmbedding = await getEmbeddingVector(settings, queryText);
    const queryBigrams = extractBigramsAndTokens(queryText);

    const scored = candidates.map(item => {
        let score = 0;
        if (Array.isArray(item.keywords)) {
            for (const kw of item.keywords) {
                if (kw && queryText.includes(kw)) {
                    score += 0.45;
                }
            }
        }
        const itemBigrams = extractBigramsAndTokens(item.text + " " + (item.keywords || []).join(" "));
        if (queryBigrams.size > 0 && itemBigrams.size > 0) {
            let overlap = 0;
            for (const bg of queryBigrams) {
                if (itemBigrams.has(bg)) overlap++;
            }
            score += (overlap / Math.sqrt(queryBigrams.size * itemBigrams.size)) * 0.6;
        }
        if (queryEmbedding && item.embedding) {
            const cos = cosineSimilarity(queryEmbedding, item.embedding);
            score += Math.max(0, cos) * 1.2;
        }
        return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const topK = Math.max(1, Number(settings.retrievalTopK || 3));
    return scored
        .filter(x => x.score >= 0.12)
        .slice(0, topK)
        .map(x => x.item);
}

/**
 * 组装给主模型的记忆注入块（纯轮次时间线 + 各人物物理状态）
 */
export function buildInjectedMemoryPrompt(memoryData, retrievedSnacks = []) {
    if (!memoryData) return "";
    const ledger = memoryData.stateLedger || {};
    const chars = ledger.characters || {};

    const charBlocks = [];
    for (const [name, info] of Object.entries(chars)) {
        if (!info) continue;
        const removed = (info.removedItemsLock || []).length > 0
            ? `\n    - 已摘除/脱下饰品(锁): ${info.removedItemsLock.join("; ")} [未描写重戴前严禁出现!]`
            : "";
        const inv = (info.inventory || []).length > 0
            ? `\n    - 随身携带道具: ${info.inventory.join("; ")}`
            : "";

        charBlocks.push(`- **【${name}】**
    - 当前地点: ${info.location || "未知"}
    - 状态与行动: ${info.statusAndAction || "无"}
    - 当前穿戴: ${info.wear || "常规穿戴"}${removed}${inv}`);
    }

    const todoLines = (ledger.todosAndPromises || []).length > 0
        ? ledger.todosAndPromises.map(x => `  * 📌 ${x}`).join("\n")
        : "  * 无";

    const timelineSections = [];
    const maxLvl = Math.max(...Object.keys(memoryData.levels || {}).map(Number), 3);

    for (let lvl = maxLvl; lvl >= 1; lvl--) {
        const list = memoryData.levels?.[lvl] || [];
        if (list.length > 0) {
            const title = lvl === 1 ? "阶段剧情脉络 (近期)" : `长线剧情大阶段脉络`;
            const lines = list.map(it => `• [第 ${it.roundRange} 轮阶段总览] ${it.text}`).join("\n");
            timelineSections.push(`### ${title}\n${lines}`);
        }
    }

    const l0List = memoryData.levels?.[0] || [];
    if (l0List.length > 0) {
        const lines = l0List.map(it => `• [第 ${it.roundRange} 轮] ${it.text}`).join("\n");
        timelineSections.push(`### 最近单轮剧情时间线\n${lines}`);
    }

    let retrievedSection = "";
    if (retrievedSnacks && retrievedSnacks.length > 0) {
        const rLines = retrievedSnacks
            .map(it => `• [过往回忆·第 ${it.roundRange} 轮] ${it.text}`)
            .join("\n");
        retrievedSection = `\n## 三、当前话题相关的过往回忆片段（按需唤醒）\n${rLines}\n`;
    }

    return `<tiandao_memory_system>
# 天道·溯微剧情时间线与人物动态状态（最高事实基准）

## 一、当前各人物实时物理状态账本（绝对优先于角色卡初始设定）
- **当前故事时间**: ${ledger.time || "未知"}
${charBlocks.join("\n\n") || "（暂无出场人物状态）"}
- **各角色未完成约定与待办**:
${todoLines}

## 二、剧情时间线叙事脉络（由远及近·按轮数推进）
${timelineSections.join("\n\n") || "（尚无归档时间线）"}
${retrievedSection}</tiandao_memory_system>`;
}

/**
 * 组装纯叙事时间线总览（按轮数展示）
 */
export function buildNarrativeStoryView(memoryData) {
    if (!memoryData) return "暂无记忆记录。";
    const ledger = memoryData.stateLedger || {};
    const chars = ledger.characters || {};

    const charList = Object.entries(chars).map(([name, info]) => {
        const removed = (info.removedItemsLock || []).length > 0
            ? `\n  - ⚠️ 已摘除饰品锁: ${info.removedItemsLock.join(", ")}`
            : "";
        const inv = (info.inventory || []).length > 0
            ? `\n  - 随身道具: ${info.inventory.join(", ")}`
            : "";
        return `【${name}】
  - 所在地点: ${info.location || "未知"}
  - 状态与行动: ${info.statusAndAction || "正常"}
  - 衣着穿戴: ${info.wear || "未记录"}${removed}${inv}`;
    }).join("\n\n");

    const lines = [];
    lines.push(`📖 当前故事时间：${ledger.time || "未知"}\n`);
    lines.push(`👥 在场各人物当前状态：\n${charList || "暂无出场人物"}\n`);

    if ((ledger.todosAndPromises || []).length > 0) {
        lines.push(`📌 待办与约定事项：\n${ledger.todosAndPromises.map(x => "  • " + x).join("\n")}\n`);
    }

    lines.push(`📜 剧情时间线脉络（按一问一答轮数）：`);

    const allSummaries = [];
    const maxLvl = Math.max(...Object.keys(memoryData.levels || {}).map(Number), 3);
    for (let lvl = maxLvl; lvl >= 1; lvl--) {
        const list = memoryData.levels?.[lvl] || [];
        for (const it of list) {
            allSummaries.push(`• [第 ${it.roundRange} 轮阶段总览]\n  ${it.text}`);
        }
    }
    for (const it of (memoryData.levels?.[0] || [])) {
        allSummaries.push(`• [第 ${it.roundRange} 轮]\n  ${it.text}`);
    }

    if (allSummaries.length === 0) {
        lines.push("  （暂无剧情总结）");
    } else {
        lines.push(allSummaries.join("\n\n"));
    }

    return lines.join("\n");
}

/**
 * 剥离 embedding
 */
export function createEditableMemoryCopy(memoryData) {
    const copy = deepClone(memoryData);
    const stripInternalFields = (list) => {
        if (!Array.isArray(list)) return;
        for (const item of list) {
            if (item && typeof item === "object") {
                delete item.embedding;
                delete item.preStateSnapshot;
                delete item.postStateSnapshot;
            }
        }
    };
    if (copy.levels && copy.levels[0]) stripInternalFields(copy.levels[0]);
    if (copy.archivePool) stripInternalFields(copy.archivePool);
    return copy;
}

/**
 * 还原 embedding
 */
export function mergeEditedMemoryWithEmbeddings(originalData, editedData) {
    if (!originalData || !editedData) return editedData;
    const internalMap = new Map();
    const collectInternal = (list) => {
        if (!Array.isArray(list)) return;
        for (const item of list) {
            if (item && item.id) {
                internalMap.set(item.id, {
                    embedding: item.embedding || null,
                    preStateSnapshot: item.preStateSnapshot,
                    postStateSnapshot: item.postStateSnapshot,
                });
            }
        }
    };
    collectInternal(originalData.archivePool);
    collectInternal(originalData.levels?.[0]);

    const restoreInternal = (list) => {
        if (!Array.isArray(list)) return;
        for (const item of list) {
            if (item && item.id && internalMap.has(item.id)) {
                const cached = internalMap.get(item.id);
                if (!item.embedding && cached.embedding) item.embedding = cached.embedding;
                if (!item.preStateSnapshot && cached.preStateSnapshot) item.preStateSnapshot = cached.preStateSnapshot;
                if (!item.postStateSnapshot && cached.postStateSnapshot) item.postStateSnapshot = cached.postStateSnapshot;
            }
        }
    };
    restoreInternal(editedData.archivePool);
    restoreInternal(editedData.levels?.[0]);
    return editedData;
}

/**
 * 存量历史一键回溯构建器（按一问一答轮次扫描）
 */
export async function backfillExistingChatHistory(
    settings,
    memoryData,
    chatMessages,
    userName,
    charName,
    options = {}
) {
    const { onProgress, onChunkSaved, shouldAbort } = options;

    if (!Array.isArray(chatMessages) || chatMessages.length === 0) {
        throw new Error("当前聊天没有可扫描的历史消息");
    }

    // 找出所有配对的有效 AI 回复楼层
    const aiMessageIndices = [];
    for (let idx = 0; idx < chatMessages.length; idx++) {
        const m = chatMessages[idx];
        if (m && !m.is_user && (!m.is_system || m.extra?.tiandao_hidden)) {
            aiMessageIndices.push(idx);
        }
    }

    if (aiMessageIndices.length === 0) {
        return { processedCount: 0, aborted: false };
    }

    const startAiIdx = Math.max(0, (memoryData.lastProcessedMessageId ?? -1));
    const pendingAiIndices = aiMessageIndices.filter(i => i > startAiIdx);

    if (pendingAiIndices.length === 0) {
        return { processedCount: 0, aborted: false };
    }

    let processedCount = 0;
    const totalRounds = pendingAiIndices.length;

    for (let i = 0; i < pendingAiIndices.length; i++) {
        if (typeof shouldAbort === "function" && shouldAbort()) {
            return { processedCount, aborted: true };
        }

        const msgIdx = pendingAiIndices[i];
        const roundNumber = aiMessageIndices.indexOf(msgIdx) + 1;

        let startFloor = msgIdx;
        const batchMsgs = [];
        if (msgIdx > 0 && chatMessages[msgIdx - 1]?.is_user) {
            startFloor = msgIdx - 1;
            const uClean = cleanMessageText(chatMessages[msgIdx - 1].mes, settings.targetContentTags, settings.customStripTags);
            if (uClean) batchMsgs.push(`【${userName}】：\n${uClean}`);
        }
        const aClean = cleanMessageText(chatMessages[msgIdx].mes, settings.targetContentTags, settings.customStripTags);
        if (aClean) batchMsgs.push(`【${chatMessages[msgIdx].name || charName}】：\n${aClean}`);

        if (batchMsgs.length > 0) {
            if (typeof onProgress === "function") {
                onProgress(i + 1, totalRounds, roundNumber);
            }
            await summarizeSingleTurn(settings, memoryData, {
                roundNumber,
                startMessageId: startFloor,
                endMessageId: msgIdx,
                userName,
                charName,
                dialogueText: batchMsgs.join("\n\n"),
            });
        }

        memoryData.lastProcessedMessageId = msgIdx;
        memoryData.lastProcessedRound = roundNumber;
        processedCount++;

        if (typeof onChunkSaved === "function") {
            await onChunkSaved(msgIdx);
        }
    }

    return { processedCount, aborted: false };
}
