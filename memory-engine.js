/**
 * 天道·溯微记忆引擎 (Tiandao Memory Engine) - 核心引擎模块
 *
 * 核心能力：
 * 1. 零配置动态状态账本（自动追踪衣着穿脱、已摘除饰品防回滚锁、剧情新增/消耗物品、防全知信息隔离表、待办事项，内置防膨胀淘汰机制）
 * 2. 分层递归记忆树（L0单轮微摘要 -> 满N条合并为L1小阶段摘要 -> 满N条L1合并为L2大阶段摘要 -> 支持无限层级递归）
 * 3. 重Roll (Swipe) / 删楼 / 编辑自动回滚覆盖机制（每层 L0 保存状态账本快照，同层重新生成或删楼时自动回滚并替换旧记忆，绝不重复叠加）
 * 4. 混合检索回溯池（所有退居幕后的L0微摘要自动进入回溯池，支持独立Embedding向量检索 + 本地BM25/双字分词零成本混合唤醒）
 * 5. 存量历史一键回溯构建（支持中途暂停/继续、每批次实时存档断点续传）
 */

export const DEFAULT_SETTINGS = {
    enabled: true,
    autoSummarizePerTurn: true,
    summarizeTiming: "on_next_send", // "on_next_send": 等玩家发送下一条消息时再总结上一轮(重Roll零浪费) | "after_reply": AI回复完立即总结
    autoHideOldMessages: true,       // 默认开启：只向主模型发送最近 N 层原文，超出的旧楼层自动隐藏只看插件总结
    keepRecentMessagesCount: 6,      // 发送给主模型的最近完整原文楼层数（超出部分自动隐藏）

    // 独立总结 API 设置 (OpenAI 兼容格式: DeepSeek / Gemini / 硅基流动 / OpenRouter / NewAPI 等)
    apiUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 2000,

    // 正文提取与标签剥离设置
    customStripTags: "thinking,think,report,options_engine,small_theater,status_bar",

    // 递归合并树参数
    mergeChunkSize: 5, // 每满 5 条向上合并为 1 条 (例如: 5条L0 -> 1条L1, 5条L1 -> 1条L2)
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
        version: 2,
        lastProcessedMessageId: -1,
        // 常驻动态状态账本（每轮增量更新，永不因合并而压缩丢失）
        stateLedger: {
            timeAndPlace: "未知时间｜未知地点",
            characterWear: {},       // { "角色名": "当前穿戴的衣服与饰品" }
            removedItemsLock: [],    // ["角色A的金丝眼镜（已于卧室摘下未戴）", ...] 专门防初始人设回滚！
            inventoryAndProps: [],   // ["剧情中获得的物品/信物/道具及当前位置"]
            knowledgeIsolation: [],  // ["某私密事件/秘密：仅User与A知晓，B不在场不知情"] 防全知！
            todosAndPromises: [],    // ["待办事项、日程约定或未完成承诺"]
        },
        // 分层递归记忆树
        // levels[0] = L0 (当前尚未被合并的最新单层微摘要, 满5条则合并为1条推入 levels[1])
        // levels[1] = L1 (每条代表 5 层楼的阶段总结, 满5条则合并为1条推入 levels[2])
        // levels[2] = L2 (每条代表 25 层楼的大阶段总结)
        // levels[3] = L3 (每条代表 125 层楼的卷级总结)
        levels: {
            0: [],
            1: [],
            2: [],
            3: [],
        },
        // 全量 L0 历史小事回溯池（即使 L0 被合并进 L1 从常驻栏移除，原件依然保存在这里供向量/关键词随时捞取陈年小事）
        archivePool: [],
    };
}

/**
 * 解析 floorRange 字符串（如 "12-13" 或 "12"）为起止楼层数字
 */
export function parseFloorRange(floorRange) {
    const str = String(floorRange || "0").trim();
    const parts = str.split("-").map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n));
    if (parts.length === 0) return { start: 0, end: 0 };
    if (parts.length === 1) return { start: parts[0], end: parts[0] };
    return { start: Math.min(...parts), end: Math.max(...parts) };
}

/**
 * 当发生重Roll (Swipe)、编辑楼层或删除楼层时，回滚并清理 >= cutoffStartFloor 的 L0 记忆与状态账本
 */
export function rollbackMemoryFromFloor(memoryData, cutoffStartFloor) {
    if (!memoryData || typeof cutoffStartFloor !== "number" || cutoffStartFloor < 0) return false;

    const l0List = memoryData.levels?.[0] || [];
    const archiveList = memoryData.archivePool || [];

    // 找出需要被回滚移除的条目中最早的一条，若有 preStateSnapshot 则用它恢复状态账本
    const removedFromArchive = archiveList
        .filter(item => parseFloorRange(item.floorRange).start >= cutoffStartFloor)
        .sort((a, b) => parseFloorRange(a.floorRange).start - parseFloorRange(b.floorRange).start);

    let rolledBack = false;
    if (removedFromArchive.length > 0) {
        rolledBack = true;
        const earliestRemoved = removedFromArchive[0];
        if (earliestRemoved.preStateSnapshot) {
            memoryData.stateLedger = deepClone(earliestRemoved.preStateSnapshot);
        } else {
            // 如果没有 preStateSnapshot，尝试找早于 cutoffStartFloor 的最后一条记录的 postStateSnapshot
            const remainingBefore = archiveList
                .filter(item => parseFloorRange(item.floorRange).end < cutoffStartFloor && item.postStateSnapshot);
            if (remainingBefore.length > 0) {
                memoryData.stateLedger = deepClone(remainingBefore[remainingBefore.length - 1].postStateSnapshot);
            }
        }
    }

    // 清理 levels[0] 与 archivePool 中属于 >= cutoffStartFloor 的记录
    if (Array.isArray(memoryData.levels?.[0])) {
        memoryData.levels[0] = l0List.filter(item => parseFloorRange(item.floorRange).start < cutoffStartFloor);
    }
    if (Array.isArray(memoryData.archivePool)) {
        memoryData.archivePool = archiveList.filter(item => parseFloorRange(item.floorRange).start < cutoffStartFloor);
    }

    // 更新 lastProcessedMessageId
    const remainingEnds = (memoryData.archivePool || []).map(item => parseFloorRange(item.floorRange).end);
    memoryData.lastProcessedMessageId = remainingEnds.length > 0 ? Math.max(...remainingEnds) : -1;

    return rolledBack;
}

/**
 * 清理模型输出的正文（剥离 <thinking>, <report>, <options_engine>, <small_theater> 及用户自定义标签，避免干扰总结）
 */
export function cleanMessageText(rawText, customStripTagsStr = "") {
    if (!rawText) return "";
    let text = String(rawText);
    // 如果包含 <content>...</content>，优先提取 <content> 内部正文
    const contentMatch = text.match(/<content>([\s\S]*?)<\/content>/i);
    if (contentMatch && contentMatch[1].trim()) {
        text = contentMatch[1].trim();
    }

    // 默认剥离标签 + 用户自定义剥离标签
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

    // 剥离 <details> 折叠块
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
 * 调用 Embedding API 获取向量（可选，用于高精度语义检索）
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
 * 单轮处理：提取本轮 L0 微摘要 + 增量更新状态账本（零配置自动追踪饰品穿脱、物品增减、知情权、待办）
 * 若检测到当前楼层已被总结过（如重Roll/编辑），会自动先回滚该楼层旧状态再重新总结
 */
export async function summarizeSingleTurn(settings, memoryData, turnInfo) {
    const { floorRange, userName, charName, dialogueText } = turnInfo;
    const { start: startFloor } = parseFloorRange(floorRange);

    // 如果当前总结的起始楼层 <= 已处理过的最大楼层，说明是重Roll(Swipe)或重跑，自动回滚旧的同层/后续记录
    if (memoryData.lastProcessedMessageId >= startFloor) {
        rollbackMemoryFromFloor(memoryData, startFloor);
    }

    // 保存本轮更新前的状态账本快照（用于未来可能的重Roll回滚）
    const preStateSnapshot = deepClone(memoryData.stateLedger);
    const currentStateJson = JSON.stringify(memoryData.stateLedger, null, 2);

    const systemPrompt = `你是一个高精度的角色扮演叙事状态追踪器与微摘要引擎。
请阅读【上一轮状态账本】与【最新一轮剧情文本】，输出严格的 JSON 格式结果（不要输出任何多余解释或 Markdown 代码块包裹之外的文字）。

核心要求：
1. **单轮微摘要 (l0_summary)**：
   - 用 60~120 字精准记录本轮发生的具体事件、时间地点、情感互动细节以及看似微小但值得纪念的生活小事（如顺手买的食物、聊到的过往、环境小插曲）。
   - 提取 3~6 个检索关键词 (keywords)，方便日后几百层后聊到相关话题时唤醒。
2. **零配置动态状态账本更新与防膨胀法则 (stateLedger)**：
   - **timeAndPlace**：更新当前具体日期、时间点、距上轮的时间流逝与当前地点。
   - **characterWear**：记录在场人物当前的穿着与佩戴饰品（若已经离开场景的不在场次要人物可移除）。
   - **removedItemsLock（核心防回滚锁·极其重要）**：
     * 只要人物在剧情中摘下了某件饰品（如眼镜、耳环、项链、发圈、手表）或脱下了某件衣物（如外套、鞋袜），必须立刻将其加入此数组，并注明状态（例："${charName}的金丝眼镜（已摘下放在床头柜，当前未佩戴）"）。
     * **继承铁律**：上一轮状态账本 \`removedItemsLock\` 中已有的条目，只要本轮剧情中没有明确描写“重新戴上/重新穿上”，**必须原封不动继续保留在数组中**，绝对禁止擅自清空！只有明确重写穿戴后才可从中移除。
   - **inventoryAndProps（上限最多保留10条·自动淘汰过时杂物）**：记录剧情中新获得、赠送、转移的重要信物/随身道具及当前场景关键物品位置；已经吃完用完的消耗品、或早已离开的旧场景普通杂物请及时清理，保持精炼。
   - **knowledgeIsolation（防全知隔离锁·上限最多保留8条）**：记录私密事件或独处行为的知情者边界（例："卧室内的亲密互动与某秘密仅${userName}与${charName}知晓，其他不在场角色完全不知情"）。已公开或不再具备保密意义的旧条目请及时合并或移除。
   - **todosAndPromises（上限最多保留8条）**：更新角色接下来的日程、工作课业待办或双方约定的事项（已完成的事项立刻移除，新约定及时加入）。

请严格按以下 JSON 结构返回：
{
  "l0_summary": "[时间·地点] 本轮核心事件与生活小细节...",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "stateLedger": {
    "timeAndPlace": "具体时间｜具体地点",
    "characterWear": {
      "${charName}": "当前衣着与穿戴",
      "${userName}": "当前衣着与穿戴"
    },
    "removedItemsLock": [
      "已摘下/已脱去且尚未重新穿戴的饰品或衣物（未重戴则一直保留）"
    ],
    "inventoryAndProps": [
      "关键物品/剧情新增道具及当前位置"
    ],
    "knowledgeIsolation": [
      "私密事件/独处秘密的知情范围界定"
    ],
    "todosAndPromises": [
      "待办日程与约定"
    ]
  }
}`;

    const userPrompt = `【当前楼层范围】：第 ${floorRange} 楼
【主角与角色】：User = ${userName}, Char = ${charName}

【上一轮状态账本 (请在此基础上增量更新，切勿丢失未恢复的已摘除饰品锁)】：
${currentStateJson}

【最新一轮剧情文本】：
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

    // 更新状态账本（带长度兜底截断，防止几百层后无限膨胀）
    if (parsed.stateLedger) {
        memoryData.stateLedger = {
            timeAndPlace: parsed.stateLedger.timeAndPlace || memoryData.stateLedger.timeAndPlace,
            characterWear: parsed.stateLedger.characterWear || memoryData.stateLedger.characterWear,
            removedItemsLock: Array.isArray(parsed.stateLedger.removedItemsLock)
                ? parsed.stateLedger.removedItemsLock.slice(0, 15)
                : memoryData.stateLedger.removedItemsLock,
            inventoryAndProps: Array.isArray(parsed.stateLedger.inventoryAndProps)
                ? parsed.stateLedger.inventoryAndProps.slice(0, 12)
                : memoryData.stateLedger.inventoryAndProps,
            knowledgeIsolation: Array.isArray(parsed.stateLedger.knowledgeIsolation)
                ? parsed.stateLedger.knowledgeIsolation.slice(0, 10)
                : memoryData.stateLedger.knowledgeIsolation,
            todosAndPromises: Array.isArray(parsed.stateLedger.todosAndPromises)
                ? parsed.stateLedger.todosAndPromises.slice(0, 10)
                : memoryData.stateLedger.todosAndPromises,
        };
    }

    // 生成 L0 节点（附带前后状态快照以支持无损回滚）
    const embedding = await getEmbeddingVector(settings, `${parsed.l0_summary} ${(parsed.keywords || []).join(" ")}`);
    const l0Entry = {
        id: `L0_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        level: 0,
        floorRange: String(floorRange),
        text: parsed.l0_summary.trim(),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        timestamp: Date.now(),
        embedding: embedding,
        preStateSnapshot: preStateSnapshot,
        postStateSnapshot: deepClone(memoryData.stateLedger),
    };

    // 推入 L0 队列，同时永久备份进 archivePool（供未来检索小事）
    if (!memoryData.levels[0]) memoryData.levels[0] = [];
    memoryData.levels[0].push(l0Entry);
    memoryData.archivePool.push(l0Entry);

    // 清理过早的历史状态快照（只保留最近 10 条 L0 的状态快照即可，节省存档体积）
    if (memoryData.archivePool.length > 10) {
        for (let i = 0; i < memoryData.archivePool.length - 10; i++) {
            delete memoryData.archivePool[i].preStateSnapshot;
            delete memoryData.archivePool[i].postStateSnapshot;
        }
    }

    // 检查是否触发递归向上合并 (例如 L0 满 5 条 -> 合并为 1 条 L1；L1 满 5 条 -> 合并为 1 条 L2)
    await checkAndCascadeMerge(settings, memoryData);

    return l0Entry;
}

/**
 * 递归金字塔合并引擎：
 * 当第 k 层的条目数 >= mergeChunkSize (如 5 条) 时，取出最早的 5 条合并为第 k+1 层的 1 条摘要。
 * 如：1~5条 L0 -> 第1条 L1；6~10条 L0 -> 第2条 L1... 当 L1 攒满 5 条 (即 1~25层) -> 合并为第1条 L2！
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
            const firstFloor = itemsToMerge[0].floorRange.split("-")[0];
            const lastFloorPart = itemsToMerge[itemsToMerge.length - 1].floorRange.split("-");
            const lastFloor = lastFloorPart[lastFloorPart.length - 1];
            const mergedFloorRange = `${firstFloor}-${lastFloor}`;

            const mergedText = await mergeSummariesAtLevel(settings, lvl, itemsToMerge, mergedFloorRange);

            memoryData.levels[lvl].splice(0, chunkSize);
            if (!Array.isArray(memoryData.levels[lvl + 1])) {
                memoryData.levels[lvl + 1] = [];
            }
            memoryData.levels[lvl + 1].push({
                id: `L${lvl + 1}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                level: lvl + 1,
                floorRange: mergedFloorRange,
                text: mergedText,
                timestamp: Date.now(),
            });
        }
    }
}

/**
 * 调用独立 API 将 N 条同级摘要合成为 1 条高一级摘要
 */
async function mergeSummariesAtLevel(settings, currentLevel, items, mergedFloorRange) {
    const targetLevel = currentLevel + 1;
    const wordLimit = targetLevel === 1 ? "150~250字" : "250~400字";

    const systemPrompt = `你是一个叙事记忆金字塔压缩引擎。
请将以下连续的 ${items.length} 条【L${currentLevel} 阶段摘要】（涵盖第 ${mergedFloorRange} 楼）合并浓缩为一条连贯、高信息密度的【L${targetLevel} 汇总摘要】（篇幅控制在 ${wordLimit}）。

合并要求：
1. **严格保留时间跨度与起止节点**：在开头用 \`[起止时间跨度]\` 标明这段剧情经历的具体时间范围。
2. **保留关键剧情脉络、情感升温节点与有代表性的生活细节**：不要写成空洞的流水账，保留具体发生过的重要事件、去过的地点、关键对话结论与关系转折。
3. **直接输出合并后的摘要纯文本**，不要输出任何前缀解释。`;

    const listText = items
        .map((it, idx) => `${idx + 1}. [第${it.floorRange}楼] ${it.text}`)
        .join("\n");

    const merged = await callIndependentLLM(settings, [
        { role: "system", content: systemPrompt },
        { role: "user", content: `请合并以下 ${items.length} 条摘要：\n\n${listText}` },
    ]);

    return merged.replace(/^```[\s\S]*?\n/, "").replace(/```$/, "").trim();
}

/**
 * 混合检索引擎（余弦相似度向量检索 + 中文双字Bigram与关键词匹配保底）
 * 用于在几百层后根据当前最新话题，从 archivePool 中精准捞取某个时间段发生过的小事！
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

    // 已经在当前活跃 L0 队列中的最新摘要不需要重复召回
    const activeL0Ids = new Set((memoryData.levels[0] || []).map(x => x.id));
    const candidates = memoryData.archivePool.filter(item => !activeL0Ids.has(item.id));
    if (candidates.length === 0) return [];

    const queryEmbedding = await getEmbeddingVector(settings, queryText);
    const queryBigrams = extractBigramsAndTokens(queryText);

    const scored = candidates.map(item => {
        let score = 0;
        // 1. 关键词命中加分
        if (Array.isArray(item.keywords)) {
            for (const kw of item.keywords) {
                if (kw && queryText.includes(kw)) {
                    score += 0.45;
                }
            }
        }
        // 2. 字符 Bigram 局部重叠度
        const itemBigrams = extractBigramsAndTokens(item.text + " " + (item.keywords || []).join(" "));
        if (queryBigrams.size > 0 && itemBigrams.size > 0) {
            let overlap = 0;
            for (const bg of queryBigrams) {
                if (itemBigrams.has(bg)) overlap++;
            }
            score += (overlap / Math.sqrt(queryBigrams.size * itemBigrams.size)) * 0.6;
        }
        // 3. 若开启了 Embedding 向量且存在向量，叠加语义余弦相似度
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
 * 组装最终注入给主写作模型的上下文提示词块 `<tiandao_memory_system>`
 */
export function buildInjectedMemoryPrompt(memoryData, retrievedSnacks = []) {
    if (!memoryData) return "";
    const ledger = memoryData.stateLedger || {};

    const wearLines = Object.entries(ledger.characterWear || {})
        .map(([k, v]) => `  * ${k}: ${v}`)
        .join("\n") || "  * 暂无记录";

    const removedLines = (ledger.removedItemsLock || []).length > 0
        ? ledger.removedItemsLock.map(x => `  * ⚠️ ${x}`).join("\n")
        : "  * 无";

    const propLines = (ledger.inventoryAndProps || []).length > 0
        ? ledger.inventoryAndProps.map(x => `  * ${x}`).join("\n")
        : "  * 无";

    const isoLines = (ledger.knowledgeIsolation || []).length > 0
        ? ledger.knowledgeIsolation.map(x => `  * 🔒 ${x}`).join("\n")
        : "  * 无特殊隔离";

    const todoLines = (ledger.todosAndPromises || []).length > 0
        ? ledger.todosAndPromises.map(x => `  * 📌 ${x}`).join("\n")
        : "  * 无";

    // 组装分层递归记忆树（从高层级宏观脉络 到 低层级近期细节）
    const treeSections = [];
    const maxLvl = Math.max(...Object.keys(memoryData.levels || {}).map(Number), 3);

    for (let lvl = maxLvl; lvl >= 1; lvl--) {
        const list = memoryData.levels?.[lvl] || [];
        if (list.length > 0) {
            const title = lvl === 1 ? "近期阶段脉络 (L1)" : lvl === 2 ? "中远期大阶段脉络 (L2)" : `远期卷级总览 (L${lvl})`;
            const lines = list.map(it => `- [第${it.floorRange}楼] ${it.text}`).join("\n");
            treeSections.push(`### ${title}\n${lines}`);
        }
    }

    const l0List = memoryData.levels?.[0] || [];
    if (l0List.length > 0) {
        const lines = l0List.map(it => `- [第${it.floorRange}楼] ${it.text}`).join("\n");
        treeSections.push(`### 最近单轮微摘要 (L0)\n${lines}`);
    }

    let retrievedSection = "";
    if (retrievedSnacks && retrievedSnacks.length > 0) {
        const rLines = retrievedSnacks
            .map(it => `- [回忆闪回·第${it.floorRange}楼] ${it.text}`)
            .join("\n");
        retrievedSection = `\n## 三、与当前话题相关的过往细节回忆（按需唤醒）\n${rLines}\n`;
    }

    return `<tiandao_memory_system>
# 天道·溯微长线记忆与当前物理状态账本（最高事实基准）

## 一、当前实时物理状态账本（每轮动态更新·绝对优先于角色卡默认穿戴）
- **当前时间与地点**: ${ledger.timeAndPlace || "未知"}
- **当前在场人物穿戴**:
${wearLines}
- **已摘除/已脱下/不在身物品锁（未明确重写穿戴前严禁凭空出现在身上！）**:
${removedLines}
- **剧情关键物品与当前位置**:
${propLines}
- **防全知信息隔离表（不在知情名单内的角色绝对禁止知晓！）**:
${isoLines}
- **待办日程与约定事项**:
${todoLines}

## 二、分层递归剧情记忆树（由远及近）
${treeSections.join("\n\n") || "（尚无历史归档摘要）"}
${retrievedSection}</tiandao_memory_system>`;
}

/**
 * 为可视化 JSON 编辑器剥离冗长的 embedding 数组与内部状态快照，避免文本框被数万行浮点数撑爆
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
 * 将用户在 JSON 编辑器中修改后的数据与原有的 embedding 向量及快照无损合并还原
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
 * 存量历史一键回溯构建器（支持中途安全暂停 + 每完成一批次立即持久化保存断点）
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

    const startIdx = Math.max(0, (memoryData.lastProcessedMessageId ?? -1) + 1);
    const endIdx = chatMessages.length - 1;
    if (startIdx > endIdx) {
        return { processedCount: 0, aborted: false };
    }

    const totalToProcess = endIdx - startIdx + 1;
    const stepSize = totalToProcess > 40 ? 4 : 2;
    let processedChunks = 0;
    let processedMessages = 0;
    const totalChunks = Math.ceil(totalToProcess / stepSize);

    for (let i = startIdx; i <= endIdx; i += stepSize) {
        if (typeof shouldAbort === "function" && shouldAbort()) {
            return { processedCount: processedMessages, aborted: true };
        }

        const sliceEnd = Math.min(i + stepSize - 1, endIdx);
        const batchMsgs = [];
        for (let j = i; j <= sliceEnd; j++) {
            const m = chatMessages[j];
            if (!m) continue;
            // 仅跳过非天道隐藏的纯系统提示消息，天道自身隐藏的历史楼层仍需正常扫描
            if (m.is_system && !m.extra?.tiandao_hidden) continue;
            const speaker = m.is_user ? userName : (m.name || charName);
            const cleaned = cleanMessageText(m.mes, settings.customStripTags);
            if (cleaned) {
                batchMsgs.push(`【第${j}楼 · ${speaker}】：\n${cleaned}`);
            }
        }

        if (batchMsgs.length > 0) {
            const floorRange = i === sliceEnd ? `${i}` : `${i}-${sliceEnd}`;
            if (typeof onProgress === "function") {
                onProgress(processedChunks + 1, totalChunks, floorRange);
            }
            await summarizeSingleTurn(settings, memoryData, {
                floorRange,
                userName,
                charName,
                dialogueText: batchMsgs.join("\n\n"),
            });
        }

        memoryData.lastProcessedMessageId = sliceEnd;
        processedChunks++;
        processedMessages += (sliceEnd - i + 1);

        // 每批次完成后立即触发持久化保存，防止中途刷新或断网丢失进度
        if (typeof onChunkSaved === "function") {
            await onChunkSaved(sliceEnd);
        }
    }

    return { processedCount: processedMessages, aborted: false };
}
