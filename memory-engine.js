/**
 * 溯微记忆引擎 (Tiandao Memory Engine) - 核心引擎模块
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
    keepRecentRoundsCount: 5,        // 默认向主模型发送最近 5 轮完整原文
    includeNativeHidden: false,      // 旧档迁移时可包含 SillyTavern 原生隐藏的 AI 楼层

    // 独立总结 API 设置 (留空，由用户根据自身渠道填写，支持一键拉取模型)
    apiUrl: "",
    apiKey: "",
    model: "",
    temperature: "",       // 留空时按 0.2 处理
    maxTokens: 4000,
    useJsonMode: true,     // 支持 response_format 的渠道优先使用 JSON 模式，不支持时自动回退
    summaryRetryCount: "", // 留空时按自动重试 2 次处理（不含首次请求）
    apiProfiles: [],       // 可切换的独立 API 配置档案；API Key 仅保存在酒馆扩展设置中
    activeApiProfileId: "",

    // 正文提取设置：留空即完全不启用对应规则
    targetContentTags: "", // 目标提取标签（逗号分隔，匹配到则只提取内部正文）
    customStripTags: "",   // 备用排除标签（留空则不内置任何排除标签）

    // 悬浮窗设置
    widgetTheme: "porcelain", // 内置看板主题: porcelain=瓷白精修 | journal=书页叙事
    widgetFontScale: 100,     // 悬浮窗字号百分比，100 保持当前显示大小
    widgetFontFamily: "inherit", // inherit=跟随酒馆 | sans=现代无衬线 | serif=书卷宋体

    // 递归合并树参数（留空时按内置默认值处理）
    mergeChunkSize: "", // 留空默认每满 5 轮向上合并为 1 条

    // 向量与关键词混合检索设置 (召回陈年小事)
    enableRetrieval: true,
    retrievalTopK: "", // 留空默认每轮召回 3 条
    useEmbeddingApi: false,
    embeddingApiUrl: "",
    embeddingApiKey: "",
    embeddingModel: "",

    // 注入位置设置（下拉选择，保留明确默认值）
    injectionPosition: 1, // 0: 聊天历史后(In-Prompt), 1: 聊天历史中(In-chat @ depth), 2: 主提示词前(Before Main Prompt)
    injectionDepth: "",   // 留空默认注入深度 4
    injectionRole: 0,     // 0: system, 1: user, 2: assistant
};

const LLM_REQUEST_TIMEOUT_MS = 60_000;
const EMBEDDING_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ARCHIVE_EMBEDDINGS = 500;
const MAX_MEMORY_LEVEL = 3;
const ACTIVE_LEVEL_MIN_KEEP = { 0: 6, 1: 4, 2: 3 };
const TOP_LEVEL_ANCHOR_COUNT = 4;
const TOP_LEVEL_RECENT_COUNT = 12;
const TOP_LEVEL_ACTIVE_CAP = TOP_LEVEL_ANCHOR_COUNT + TOP_LEVEL_RECENT_COUNT;
const STATE_KEYFRAME_INTERVAL = 20;
const STATE_STORAGE_VERSION = 2;
let embeddingFailureUntil = 0;
const jsonModeUnsupported = new Set();
const memorySearchTokenCache = new WeakMap();

function createAbortError() {
    const error = new Error("总结已停止");
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
}

function sleepWithAbort(delayMs, signal) {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener?.("abort", onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            reject(createAbortError());
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });
    });
}

function isSafeObjectKey(name) {
    return typeof name === "string"
        && name.length > 0
        && !["__proto__", "prototype", "constructor"].includes(name);
}

/**
 * 浏览器端带超时的 fetch。SillyTavern 的独立 API 或 Embedding 卡住时，
 * 不能让总结队列永久挂起。
 */
export async function fetchWithTimeout(
    url,
    options = {},
    timeoutMs = LLM_REQUEST_TIMEOUT_MS,
    externalSignal = null,
) {
    throwIfAborted(externalSignal);
    const controller = new AbortController();
    let timedOut = false;
    let rejectExternalAbort = null;
    const externalAbortPromise = externalSignal
        ? new Promise((_, reject) => {
            rejectExternalAbort = reject;
        })
        : new Promise(() => {});
    const onExternalAbort = () => {
        controller.abort();
        rejectExternalAbort?.(createAbortError());
    };
    externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, Math.max(1000, timeoutMs));
    try {
        return await Promise.race([
            fetch(url, { ...options, signal: controller.signal }),
            externalAbortPromise,
        ]);
    } catch (error) {
        if (externalSignal?.aborted) {
            throw createAbortError();
        }
        if (timedOut) {
            throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener?.("abort", onExternalAbort);
    }
}

/**
 * 这些生成类型尚未定稿，不应在生成前结算上一轮。
 */
export function shouldSettleBeforeGeneration(type, dryRun = false) {
    if (dryRun) return false;
    return !["swipe", "regenerate", "continue", "quiet"].includes(String(type || ""));
}

/**
 * 计算可由插件隐藏的消息上界。上界之后的消息必须保留原文；
 * 同时绝不越过 lastProcessedMessageId，避免隐藏尚未归档的剧情。
 */
export function isAiReplyMessage(msg, includeNativeHidden = false) {
    return Boolean(msg && !msg.is_user && (!msg.is_system || msg.extra?.tiandao_hidden || includeNativeHidden));
}

export function computeHiddenMessageCutoff(chat, keepRounds, lastProcessedMessageId, includeNativeHidden = false) {
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    const keep = Math.max(1, numOr(keepRounds, 5));
    let aiCount = 0;
    let cutoff = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (isAiReplyMessage(msg, includeNativeHidden)) {
            aiCount++;
            if (aiCount === keep) {
                cutoff = (i > 0 && chat[i - 1]?.is_user) ? i - 1 : i;
                break;
            }
        }
    }
    return Math.min(cutoff, numOr(lastProcessedMessageId, -1) + 1);
}

/**
 * 数值设置留空时回退到内置默认值（避免 "" 被 Number() 误转为 0）
 */
export function numOr(value, fallback) {
    if (value === "" || value === null || value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

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
        stateStorageVersion: STATE_STORAGE_VERSION,
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
        fadedHistory: {
            earliestRound: 0,
            latestRound: 0,
            count: 0,
        },
        farHistory: {
            text: "",
            earliestRound: 0,
            latestRound: 0,
            updatedAt: 0,
        },
        pendingFarHistory: [],
        lastSummaryError: null,
    };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildStateDelta(previous, next) {
    if (isPlainObject(previous) && isPlainObject(next)) {
        const patch = {};
        const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
        for (const key of keys) {
            if (!(key in next)) {
                patch[key] = { t: "d" };
                continue;
            }
            if (!(key in previous)) {
                patch[key] = { t: "v", v: deepClone(next[key]) };
                continue;
            }
            const child = buildStateDelta(previous[key], next[key]);
            if (child) patch[key] = child;
        }
        return { t: "o", v: patch };
    }
    if (JSON.stringify(previous) === JSON.stringify(next)) return null;
    return { t: "v", v: deepClone(next) };
}

function applyStateDelta(base, delta) {
    if (!delta) return deepClone(base);
    if (delta.t === "v") return deepClone(delta.v);
    if (delta.t === "d") return undefined;
    if (delta.t !== "o") return deepClone(base);
    const result = isPlainObject(base) ? deepClone(base) : {};
    for (const [key, child] of Object.entries(delta.v || {})) {
        if (child?.t === "d") {
            delete result[key];
        } else {
            result[key] = applyStateDelta(result[key], child);
        }
    }
    return result;
}

/**
 * 从最近的状态关键帧 + 后续状态差异，恢复某条 L0 之后的状态账本。
 * 旧存档若每一轮都有 postStateSnapshot，则天然兼容，仍可直接命中关键帧。
 */
export function resolveStateLedgerAfterEntry(memoryData, targetEntry) {
    if (!memoryData || !targetEntry) return null;
    const l0Entries = (memoryData.archivePool || [])
        .filter(item => item && item.level === 0)
        .sort((a, b) =>
            numOr(a.endMessageId, parseRoundRange(a.roundRange).end)
            - numOr(b.endMessageId, parseRoundRange(b.roundRange).end)
        );
    const targetIndex = l0Entries.findIndex(item =>
        (targetEntry.id && item.id === targetEntry.id)
        || (item.startMessageId === targetEntry.startMessageId
            && item.endMessageId === targetEntry.endMessageId)
    );
    if (targetIndex < 0) return null;

    let keyframeIndex = -1;
    for (let i = targetIndex; i >= 0; i--) {
        if (l0Entries[i].postStateSnapshot) {
            keyframeIndex = i;
            break;
        }
    }
    let state = keyframeIndex >= 0
        ? deepClone(l0Entries[keyframeIndex].postStateSnapshot)
        : null;
    for (let i = keyframeIndex + 1; i <= targetIndex; i++) {
        if (!state) return null;
        if (l0Entries[i].postStateDelta) {
            state = applyStateDelta(state, l0Entries[i].postStateDelta);
        }
    }
    return state;
}

function compressLegacyStateSnapshots(memoryData) {
    if (numOr(memoryData.stateStorageVersion, 1) >= STATE_STORAGE_VERSION) return;
    const l0Entries = (memoryData.archivePool || [])
        .filter(item => item && item.level === 0)
        .sort((a, b) =>
            numOr(a.endMessageId, parseRoundRange(a.roundRange).end)
            - numOr(b.endMessageId, parseRoundRange(b.roundRange).end)
        );
    let previousState = null;
    for (const item of l0Entries) {
        if (item.postStateSnapshot) {
            const snapshot = deepClone(item.postStateSnapshot);
            const round = parseRoundRange(item.roundRange).end;
            const keepKeyframe = round === 1
                || round % STATE_KEYFRAME_INTERVAL === 0
                || !previousState;
            if (!keepKeyframe) {
                item.postStateDelta = buildStateDelta(previousState, snapshot);
                delete item.postStateSnapshot;
            }
            previousState = snapshot;
        } else if (item.postStateDelta && previousState) {
            previousState = applyStateDelta(previousState, item.postStateDelta);
        } else {
            previousState = null;
        }
    }
    memoryData.stateStorageVersion = STATE_STORAGE_VERSION;
}

export function normalizeMemoryData(memoryData) {
    if (!memoryData || typeof memoryData !== "object") {
        return createEmptyMemoryData();
    }

    const data = memoryData;
    data.version = numOr(data.version, 3);
    data.stateStorageVersion = numOr(data.stateStorageVersion, 1);
    data.lastProcessedMessageId = Number.isFinite(Number(data.lastProcessedMessageId))
        ? Number(data.lastProcessedMessageId)
        : -1;
    data.lastProcessedRound = Number.isFinite(Number(data.lastProcessedRound))
        ? Number(data.lastProcessedRound)
        : 0;
    if (!data.lastSummaryError || typeof data.lastSummaryError !== "object") {
        data.lastSummaryError = null;
    } else {
        data.lastSummaryError = {
            message: String(data.lastSummaryError.message || "总结失败").slice(0, 300),
            roundNumber: numOr(data.lastSummaryError.roundNumber, 0),
            at: numOr(data.lastSummaryError.at, 0),
        };
    }

    if (!data.stateLedger || typeof data.stateLedger !== "object") {
        data.stateLedger = { time: "未知时间", characters: {}, todosAndPromises: [] };
    }
    if (typeof data.stateLedger.time !== "string" || !data.stateLedger.time.trim()) {
        data.stateLedger.time = "未知时间";
    }
    if (!data.stateLedger.characters || typeof data.stateLedger.characters !== "object" || Array.isArray(data.stateLedger.characters)) {
        data.stateLedger.characters = {};
    }
    if (!Array.isArray(data.stateLedger.todosAndPromises)) {
        data.stateLedger.todosAndPromises = [];
    }

    data.stateLedger.characters = Object.fromEntries(
        Object.entries(data.stateLedger.characters)
            .filter(([name, info]) => isSafeObjectKey(name) && info && typeof info === "object")
            .map(([name, info]) => [
                name,
                {
                    canonicalName: asString(info.canonicalName, name),
                    aliases: normalizeStringList(info.aliases, 8).filter(alias => alias !== name),
                    location: typeof info.location === "string" ? info.location : "未知位置",
                    statusAndAction: typeof info.statusAndAction === "string" ? info.statusAndAction : "平静",
                    wear: typeof info.wear === "string" ? info.wear : "日常衣着",
                    removedItemsLock: Array.isArray(info.removedItemsLock)
                        ? info.removedItemsLock.filter(x => typeof x === "string" && x.trim()).slice(0, 10)
                        : [],
                    inventory: Array.isArray(info.inventory)
                        ? info.inventory.filter(x => typeof x === "string" && x.trim()).slice(0, 8)
                        : [],
                    present: info.present === false ? false : true,
                    lastSeenRound: numOr(info.lastSeenRound, 0),
                },
            ])
    );
    data.stateLedger.todosAndPromises = data.stateLedger.todosAndPromises
        .filter(x => typeof x === "string" && x.trim())
        .slice(0, 8);

    const hadLevelZero = Boolean(
        data.levels
        && typeof data.levels === "object"
        && !Array.isArray(data.levels)
        && Array.isArray(data.levels[0])
    );
    if (!data.levels || typeof data.levels !== "object" || Array.isArray(data.levels)) {
        data.levels = { 0: [], 1: [], 2: [], 3: [] };
    }
    const normalizedLevels = {};
    for (const [key, list] of Object.entries(data.levels)) {
        const level = Number(key);
        if (!Number.isInteger(level) || level < 0) continue;
        if (!Array.isArray(list)) continue;
        normalizedLevels[level] = list
            .filter(item => item && typeof item === "object")
            .sort((a, b) => {
                if (level === 0) {
                    return numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
                        - numOr(b.startMessageId, parseRoundRange(b.roundRange).start);
                }
                return parseRoundRange(a.roundRange).start - parseRoundRange(b.roundRange).start;
            });
    }
    data.levels = normalizedLevels;

    if (!Array.isArray(data.archivePool)) {
        data.archivePool = [];
    }
    data.archivePool = data.archivePool
        .filter(item => item && typeof item === "object")
        .map(item => {
            if (item.level === undefined) item.level = 0;
            return item;
        })
        .sort((a, b) => {
            return numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
                - numOr(b.startMessageId, parseRoundRange(b.roundRange).start);
        });

    if (!data.fadedHistory || typeof data.fadedHistory !== "object") {
        data.fadedHistory = { earliestRound: 0, latestRound: 0, count: 0 };
    } else {
        data.fadedHistory = {
            earliestRound: Math.max(0, numOr(data.fadedHistory.earliestRound, 0)),
            latestRound: Math.max(0, numOr(data.fadedHistory.latestRound, 0)),
            count: Math.max(0, numOr(data.fadedHistory.count, 0)),
        };
    }
    if (!data.farHistory || typeof data.farHistory !== "object") {
        data.farHistory = { text: "", earliestRound: 0, latestRound: 0, updatedAt: 0 };
    } else {
        data.farHistory = {
            text: typeof data.farHistory.text === "string" ? data.farHistory.text : "",
            earliestRound: Math.max(0, numOr(data.farHistory.earliestRound, 0)),
            latestRound: Math.max(0, numOr(data.farHistory.latestRound, 0)),
            updatedAt: Math.max(0, numOr(data.farHistory.updatedAt, 0)),
        };
    }
    data.pendingFarHistory = (Array.isArray(data.pendingFarHistory) ? data.pendingFarHistory : [])
        .filter(item => item && typeof item === "object" && typeof item.text === "string")
        .map(item => ({
            roundRange: String(item.roundRange || ""),
            text: String(item.text || "").slice(0, 4000),
            level: numOr(item.level, MAX_MEMORY_LEVEL),
        }));

    // 兼容旧数据：active L0 与 archivePool 可能只保留了一边。
    // 注意：正常情况下 levels[0] 可以为空（全部已合并），不能把 archive 里的
    // 历史 L0 无条件塞回活动窗口，否则每次读取都会重新触发合并。
    const archiveById = new Map(data.archivePool.filter(x => x.id).map(x => [x.id, x]));
    const hasSavedLevelZero = hadLevelZero;
    const levelZero = hasSavedLevelZero ? data.levels[0] : [];
    const hasHigherLevels = Object.entries(data.levels)
        .some(([level, list]) => Number(level) > 0 && Array.isArray(list) && list.length > 0);
    const repairedL0 = hasSavedLevelZero || hasHigherLevels
        ? [...levelZero]
        : data.archivePool.filter(item => item.level === 0);
    for (const item of repairedL0) {
        if (item && item.level === undefined) item.level = 0;
    }
    repairedL0.sort((a, b) => {
        return numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
            - numOr(b.startMessageId, parseRoundRange(b.roundRange).start);
    });
    data.levels[0] = repairedL0;

    const levelZeroById = new Map(repairedL0.filter(x => x.id).map(x => [x.id, x]));
    data.archivePool = data.archivePool.map(item => levelZeroById.get(item.id) || archiveById.get(item.id) || item);
    for (const item of repairedL0) {
        if (item.id && !data.archivePool.some(x => x.id === item.id)) {
            data.archivePool.push(item);
        }
    }

    if (data.lastProcessedMessageId < 0 && data.archivePool.length > 0) {
        data.lastProcessedMessageId = Math.max(...data.archivePool.map(item =>
            numOr(item.endMessageId, parseRoundRange(item.roundRange).end)
        ));
    }
    if (data.lastProcessedRound <= 0 && data.archivePool.length > 0) {
        data.lastProcessedRound = Math.max(...data.archivePool.map(item =>
            parseRoundRange(item.roundRange).end
        ));
    }

    compressLegacyStateSnapshots(data);
    capTopLevelEntries(data);
    return data;
}

const PLACEHOLDER_CHARACTER_KEYS = new Set(["user", "char", "character", "玩家", "主角"]);

function isPlaceholderCharacterKey(name) {
    return PLACEHOLDER_CHARACTER_KEYS.has(String(name || "").trim().toLowerCase());
}

/**
 * 一次性清理旧版本遗留的 User/Char/Character 占位人物键。
 * 有真实人物键时删除占位项；玩家昵称可安全对应时，把 User 迁移到真实昵称。
 */
export function cleanupPlaceholderCharacters(memoryData, userName = "") {
    if (!memoryData || typeof memoryData !== "object") return false;
    normalizeMemoryData(memoryData);
    const chars = memoryData.stateLedger?.characters || {};
    const name = String(userName || "").trim();
    let changed = false;

    const userPlaceholder = Object.keys(chars).find(key => key.toLowerCase() === "user");
    if (userPlaceholder && name && userPlaceholder !== name) {
        if (!chars[name]) {
            chars[name] = {
                ...chars[userPlaceholder],
                canonicalName: name,
                aliases: [...new Set([...(chars[userPlaceholder].aliases || []), userPlaceholder])],
            };
            delete chars[userPlaceholder];
            changed = true;
        } else {
            delete chars[userPlaceholder];
            changed = true;
        }
    }

    const realKeys = Object.keys(chars).filter(key => !isPlaceholderCharacterKey(key));
    if (realKeys.length > 0) {
        for (const key of Object.keys(chars)) {
            if (isPlaceholderCharacterKey(key)) {
                delete chars[key];
                changed = true;
            }
        }
    }
    return changed;
}

/**
 * 控制极长聊天中的账本规模：仅在人物数超过硬上限时，
 * 优先保留玩家、在场人物和最近出现的人物。
 */
export function pruneStaleCharacters(memoryData, currentRound = 0, options = {}) {
    if (!memoryData || typeof memoryData !== "object") return false;
    normalizeMemoryData(memoryData);
    const chars = memoryData.stateLedger?.characters || {};
    const entries = Object.entries(chars);
    const maxCharacters = Math.max(10, numOr(options.maxCharacters, 60));
    if (entries.length <= maxCharacters) return false;

    const keepNames = new Set((options.keepNames || []).map(x => String(x || "").trim()).filter(Boolean));
    entries.sort(([nameA, infoA], [nameB, infoB]) => {
        const aKeep = keepNames.has(nameA) ? 1 : 0;
        const bKeep = keepNames.has(nameB) ? 1 : 0;
        if (aKeep !== bKeep) return bKeep - aKeep;
        const aPresent = infoA?.present === false ? 0 : 1;
        const bPresent = infoB?.present === false ? 0 : 1;
        if (aPresent !== bPresent) return bPresent - aPresent;
        return numOr(infoB?.lastSeenRound, 0) - numOr(infoA?.lastSeenRound, 0);
    });

    for (const [name] of entries.slice(maxCharacters)) {
        delete chars[name];
    }
    return true;
}

function cloneMemoryForUpdate(memoryData) {
    const source = normalizeMemoryData(memoryData);
    const levels = {};
    for (const [level, list] of Object.entries(source.levels || {})) {
        levels[level] = Array.isArray(list) ? list.slice() : [];
    }
    return {
        ...source,
        stateLedger: deepClone(source.stateLedger),
        levels,
        archivePool: source.archivePool.slice(),
        fadedHistory: { ...source.fadedHistory },
        farHistory: { ...source.farHistory },
        pendingFarHistory: source.pendingFarHistory.map(item => ({ ...item })),
    };
}

function commitMemoryUpdate(target, working) {
    target.version = working.version;
    target.stateLedger = working.stateLedger;
    target.levels = working.levels;
    target.archivePool = working.archivePool;
    target.fadedHistory = working.fadedHistory;
    target.farHistory = working.farHistory;
    target.pendingFarHistory = working.pendingFarHistory;
}

function sampleArchiveEmbeddings(memoryData) {
    const archivePool = memoryData?.archivePool || [];
    if (archivePool.length <= MAX_ARCHIVE_EMBEDDINGS) return;
    const sampleIndexes = new Set(
        Array.from({ length: MAX_ARCHIVE_EMBEDDINGS }, (_, i) =>
            Math.floor((i * (archivePool.length - 1)) / Math.max(1, MAX_ARCHIVE_EMBEDDINGS - 1))
        )
    );
    memoryData.archivePool = archivePool.map((item, index) => {
        if (!item?.embedding || sampleIndexes.has(index)) return item;
        const copy = { ...item };
        copy.embedding = null;
        return copy;
    });
}

function selectTopLevelEntries(list) {
    if (!Array.isArray(list) || list.length <= TOP_LEVEL_ACTIVE_CAP) return list;
    return [
        ...list.slice(0, TOP_LEVEL_ANCHOR_COUNT),
        ...list.slice(-TOP_LEVEL_RECENT_COUNT),
    ];
}

function registerFadedHistory(memoryData, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const ranges = entries.map(item => parseRoundRange(item.roundRange));
    const earliest = Math.min(...ranges.map(range => range.start));
    const latest = Math.max(...ranges.map(range => range.end));
    const history = memoryData.fadedHistory || { earliestRound: 0, latestRound: 0, count: 0 };
    memoryData.fadedHistory = {
        earliestRound: history.count > 0
            ? Math.min(history.earliestRound || earliest, earliest)
            : earliest,
        latestRound: history.count > 0
            ? Math.max(history.latestRound || latest, latest)
            : latest,
        count: numOr(history.count, 0) + entries.length,
    };
}

function capTopLevelEntries(memoryData) {
    const topLevel = memoryData.levels?.[MAX_MEMORY_LEVEL];
    if (!Array.isArray(topLevel) || topLevel.length <= TOP_LEVEL_ACTIVE_CAP) return;
    const overflow = topLevel.slice(
        TOP_LEVEL_ANCHOR_COUNT,
        topLevel.length - TOP_LEVEL_RECENT_COUNT,
    );
    registerFadedHistory(memoryData, overflow);
    memoryData.pendingFarHistory = Array.isArray(memoryData.pendingFarHistory)
        ? memoryData.pendingFarHistory
        : [];
    for (const item of overflow) {
        const duplicate = memoryData.pendingFarHistory.some(pending =>
            pending.roundRange === item.roundRange
            && pending.text === item.text
        );
        if (!duplicate) {
            memoryData.pendingFarHistory.push({
                roundRange: String(item.roundRange || ""),
                text: String(item.text || "").slice(0, 4000),
                level: MAX_MEMORY_LEVEL,
            });
        }
    }
    memoryData.levels[MAX_MEMORY_LEVEL] = [
        ...topLevel.slice(0, TOP_LEVEL_ANCHOR_COUNT),
        ...topLevel.slice(-TOP_LEVEL_RECENT_COUNT),
    ];
}

async function flushFarHistory(settings, memoryData, { signal = null } = {}) {
    if (!Array.isArray(memoryData.pendingFarHistory) || memoryData.pendingFarHistory.length === 0) {
        return true;
    }

    while (memoryData.pendingFarHistory.length > 0) {
        throwIfAborted(signal);
        const batch = memoryData.pendingFarHistory.slice(0, 8);
        const previous = String(memoryData.farHistory?.text || "").trim();
        const source = batch
            .map(item => `[第 ${item.roundRange} 轮，仅用于排序] ${String(item.text || "").slice(0, 1000)}`)
            .join("\n");
        const systemPrompt = `你是角色扮演长线故事的编年史整理器。
请把旧阶段记忆整合为一段按剧情内时间推进的“远史摘要”。

要求：
1. 按剧情中的实际时间顺序叙述，优先使用“某年某月某日/某个季节/数日后/多年以前”等时间表达。
2. 只记录有原文依据的剧情时间；原文没有明确日期时使用相对时间或直接省略时间，严禁编造精确日期。
3. 严禁把楼层编号、现实发送时间戳当作剧情时间。
4. 保留世界背景、重大事件、人物关系变化、长期伏笔和仍未解决的历史约定。
5. 直接输出 300~700 字纯叙事文本，不要 JSON、标题、列表或格式说明。`;
        const userPrompt = `${previous ? `【已有远史摘要】\n${previous}\n\n` : ""}【需要并入远史的旧阶段】\n${source}\n\n请输出整合后的远史摘要：`;

        let merged = "";
        try {
            merged = await callIndependentLLM(settings, [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ], { jsonMode: false, signal });
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw createAbortError();
            return false;
        }
        merged = String(merged || "")
            .replace(/^```[\s\S]*?\n/, "")
            .replace(/```$/, "")
            .trim()
            .slice(0, 1400);
        if (!merged) return false;

        const ranges = batch.map(item => parseRoundRange(item.roundRange));
        const batchStart = Math.min(...ranges.map(range => range.start));
        const batchEnd = Math.max(...ranges.map(range => range.end));
        const existing = memoryData.farHistory || {};
        memoryData.farHistory = {
            text: merged,
            earliestRound: numOr(existing.earliestRound, 0) > 0
                ? Math.min(existing.earliestRound, batchStart)
                : batchStart,
            latestRound: Math.max(numOr(existing.latestRound, 0), batchEnd),
            updatedAt: Date.now(),
        };
        memoryData.pendingFarHistory.splice(0, batch.length);
    }
    return true;
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
export function calculateRoundForMessageIndex(chat, messageIndex, includeNativeHidden = false) {
    if (!Array.isArray(chat) || messageIndex < 0 || messageIndex >= chat.length) return 1;
    let round = 0;
    for (let i = 0; i <= messageIndex; i++) {
        const msg = chat[i];
        if (isAiReplyMessage(msg, includeNativeHidden)) {
            round++;
        }
    }
    return Math.max(1, round);
}

/**
 * 汇总尚未归档的 AI 轮次。upToIndex 用于“本轮回合之前先补齐旧轮次”，
 * 避免 after_reply 模式在失败后直接跨到新回复。
 */
export function collectPendingAiTurns(chat, lastProcessedMessageId = -1, upToIndex = Infinity, includeNativeHidden = false) {
    if (!Array.isArray(chat)) return [];
    const start = Math.max(0, numOr(lastProcessedMessageId, -1) + 1);
    const end = Math.min(chat.length - 1, Number.isFinite(Number(upToIndex)) ? Number(upToIndex) : chat.length - 1);
    const pending = [];
    let round = 0;
    for (let idx = 0; idx <= end; idx++) {
        const msg = chat[idx];
        if (!isAiReplyMessage(msg, includeNativeHidden)) continue;
        round++;
        if (idx >= start) pending.push({ idx, round, msg });
    }
    return pending;
}

/**
 * 当发生重Roll (Swipe)、编辑或删除楼层时，回滚并清理 >= cutoffMessageId 的 L0 记忆与状态账本
 */
export function rollbackMemoryFromMessageIndex(memoryData, cutoffMessageId) {
    if (!memoryData || typeof cutoffMessageId !== "number" || cutoffMessageId < 0) return false;
    normalizeMemoryData(memoryData);

    const archiveList = memoryData.archivePool || [];
    if (archiveList.length === 0) {
        const hasHigherLevels = Object.entries(memoryData.levels || {})
            .some(([level, list]) => Number(level) > 0 && Array.isArray(list) && list.length > 0);
        if (!hasHigherLevels) return false;
        memoryData.levels = { 0: [] };
        memoryData.stateLedger = { time: "未知时间", characters: {}, todosAndPromises: [] };
        memoryData.lastProcessedMessageId = -1;
        memoryData.lastProcessedRound = 0;
        return true;
    }
    const removedFromArchive = archiveList
        .filter(item => (item.endMessageId ?? parseRoundRange(item.roundRange).start) >= cutoffMessageId)
        .sort((a, b) => (a.startMessageId ?? 0) - (b.startMessageId ?? 0));

    const remainingArchive = archiveList.filter(item =>
        (item.endMessageId ?? parseRoundRange(item.roundRange).start) < cutoffMessageId
    );
    if (removedFromArchive.length === 0 && remainingArchive.length === archiveList.length) {
        return false;
    }

    // 高层摘要没有保存逐楼 ID。只要该合并块包含被回滚的轮次，就将该层及更高层整体重建。
    const removedRanges = removedFromArchive.map(item => parseRoundRange(item.roundRange));
    const minRemovedRound = removedRanges.length > 0
        ? Math.min(...removedRanges.map(r => r.start))
        : parseRoundRange(remainingArchive.at(-1)?.roundRange || "0").end + 1;
    const levels = {};
    let coveredRound = 0;
    for (const [level, list] of Object.entries(memoryData.levels || {})) {
        const n = Number(level);
        if (n === 0) {
            levels[0] = [];
            continue;
        }
        levels[n] = (Array.isArray(list) ? list : []).filter(item => {
            const range = parseRoundRange(item.roundRange);
            return range.end < minRemovedRound;
        });
        for (const item of levels[n]) {
            coveredRound = Math.max(coveredRound, parseRoundRange(item.roundRange).end);
        }
    }
    memoryData.levels = levels;

    const l0Entries = remainingArchive
        .filter(item => item.level === 0)
        .sort((a, b) =>
            numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
            - numOr(b.startMessageId, parseRoundRange(b.roundRange).start)
        );
    memoryData.archivePool = l0Entries;
    // 已由保留的高层摘要覆盖的 L0 不再放回活动窗口，避免下次合并重复生成。
    memoryData.levels[0] = l0Entries.filter(item =>
        parseRoundRange(item.roundRange).start > coveredRound
    );

    const lastL0 = l0Entries.at(-1);
    const resolvedState = lastL0 ? resolveStateLedgerAfterEntry(memoryData, lastL0) : null;
    if (resolvedState) {
        memoryData.stateLedger = resolvedState;
    } else {
        const earliestRemoved = removedFromArchive[0];
        if (earliestRemoved?.preStateSnapshot) {
            memoryData.stateLedger = deepClone(earliestRemoved.preStateSnapshot);
        } else if (l0Entries.length === 0) {
            memoryData.stateLedger = { time: "未知时间", characters: {}, todosAndPromises: [] };
        }
    }

    const remainingEnds = l0Entries.map(item => numOr(item.endMessageId, -1));
    memoryData.lastProcessedMessageId = remainingEnds.length > 0 ? Math.max(...remainingEnds) : -1;
    const remainingRounds = l0Entries.map(item => parseRoundRange(item.roundRange).end);
    memoryData.lastProcessedRound = remainingRounds.length > 0 ? Math.max(...remainingRounds) : 0;
    return true;
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

    const customTags = String(customStripTagsStr || "")
        .split(/[,，\s]+/)
        .map(t => t.trim().replace(/^<|>$/g, ""))
        .filter(Boolean);
    const allTags = Array.from(new Set(customTags));

    for (const tag of allTags) {
        const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const reg = new RegExp(`<${safeTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${safeTag}>`, "gi");
        text = text.replace(reg, "");
    }

    return text.trim();
}

/**
 * 调用独立配置的 OpenAI 兼容 Chat Completions API
 */
function parseRetryAfterMs(response) {
    const rawMs = response?.headers?.get?.("retry-after-ms");
    if (rawMs && Number.isFinite(Number(rawMs))) return Math.max(0, Number(rawMs));
    const raw = response?.headers?.get?.("retry-after");
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export async function callIndependentLLM(settings, messages, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
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

    const modelName = (settings.model || "").trim();
    if (!modelName) {
        throw new Error("请在悬浮窗【溯微设置】中填写或选择总结模型 (Model)");
    }

    const body = {
        model: modelName,
        messages: messages,
        temperature: numOr(settings.temperature, 0.2),
        max_tokens: numOr(settings.maxTokens, 4000),
    };
    const jsonModeKey = `${endpoint}|${modelName}`;
    const jsonModeRequested = options.jsonMode === undefined
        ? settings.useJsonMode !== false
        : Boolean(options.jsonMode);
    const useJsonMode = jsonModeRequested && !jsonModeUnsupported.has(jsonModeKey);

    const requestOptions = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${settings.apiKey.trim()}`,
        },
    };
    let response = await fetchWithTimeout(endpoint, {
        ...requestOptions,
        body: JSON.stringify(useJsonMode
            ? { ...body, response_format: { type: "json_object" } }
            : body),
    }, LLM_REQUEST_TIMEOUT_MS, signal);

    // 部分 OpenAI 兼容渠道不支持 response_format；仅在格式相关错误时静默回退。
    if (!response.ok && useJsonMode && [400, 404, 422].includes(response.status)) {
        jsonModeUnsupported.add(jsonModeKey);
        response = await fetchWithTimeout(endpoint, {
            ...requestOptions,
            body: JSON.stringify(body),
        }, LLM_REQUEST_TIMEOUT_MS, signal);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        const error = new Error(`独立 API 请求失败 (${response.status}): ${errText.slice(0, 200)}`);
        error.status = response.status;
        error.retryAfterMs = parseRetryAfterMs(response);
        throw error;
    }

    const data = await response.json().catch(() => null);
    const rawContent = data?.choices?.[0]?.message?.content;
    const content = Array.isArray(rawContent)
        ? rawContent.map(part => typeof part === "string" ? part : (part?.text || "")).join("")
        : String(rawContent || "");
    return content.trim();
}

function tryParseJsonObject(candidate) {
    const attempts = [candidate];
    // 兼容模型常见的轻微 JSON 瑕疵：尾逗号、中文引号包裹的键。
    attempts.push(candidate
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/[“”]([^“”\n]+)[“”]\s*:/g, '"$1":'));
    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch (_) { /* 尝试下一种修复方式 */ }
    }
    return null;
}

/**
 * 从独立 API 返回文本中安全解析 JSON。
 * 兼容 Markdown 代码块、前后说明文字以及少量尾逗号等常见格式漂移。
 */
export function safeParseJSON(text) {
    if (!text) return null;
    const source = String(text).trim();
    const cleaned = source.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const direct = tryParseJsonObject(cleaned);
    if (direct) return direct;

    let firstBrace = cleaned.indexOf("{");
    while (firstBrace !== -1) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = firstBrace; i < cleaned.length; i++) {
            const ch = cleaned[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === "\\") {
                    escaped = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
            } else if (ch === "{") {
                depth++;
            } else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    const candidate = cleaned.slice(firstBrace, i + 1);
                    const parsed = tryParseJsonObject(candidate);
                    if (parsed) return parsed;
                    break;
                }
            }
        }
        firstBrace = cleaned.indexOf("{", firstBrace + 1);
    }

    console.error(`[Tiandao Memory] JSON parse failed (${String(text).length} chars)`);
    return null;
}

function asString(value, fallback) {
    return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeStringList(value, limit) {
    if (!Array.isArray(value)) return [];
    return value
        .filter(x => typeof x === "string" && x.trim())
        .map(x => x.trim())
        .slice(0, limit);
}

function characterAliases(name, info) {
    return new Set([
        name,
        info?.canonicalName,
        ...(Array.isArray(info?.aliases) ? info.aliases : []),
    ].map(x => String(x || "").trim()).filter(Boolean));
}

function findCharacterKey(previousChars, incomingName, incomingInfo) {
    if (isSafeObjectKey(incomingName) && previousChars[incomingName]) return incomingName;
    const incomingAliases = new Set([...characterAliases(incomingName, incomingInfo)].map(x => x.toLowerCase()));
    for (const [previousName, previousInfo] of Object.entries(previousChars)) {
        if (!isSafeObjectKey(previousName) || !previousInfo || typeof previousInfo !== "object") continue;
        const previousAliases = new Set([...characterAliases(previousName, previousInfo)].map(x => x.toLowerCase()));
        for (const alias of incomingAliases) {
            if (previousAliases.has(alias)) return previousName;
        }
    }
    return null;
}

function mergeCharacterRecord(previousName, oldInfo, incoming, incomingName, roundNumber) {
    const oldLocks = normalizeStringList(oldInfo?.removedItemsLock, 10);
    const newLocks = normalizeStringList(incoming?.removedItemsLock, 10);
    const unlocked = normalizeStringList(incoming?.unlockedItems, 20).map(x => x.toLowerCase());
    const locks = [...new Set([...oldLocks, ...newLocks])]
        .filter(item => !unlocked.some(unlockedItem => item.toLowerCase().includes(unlockedItem)))
        .slice(0, 10);
    const oldInventory = normalizeStringList(oldInfo?.inventory, 8);
    const newInventory = normalizeStringList(incoming?.inventory, 8);
    const canonicalName = asString(oldInfo?.canonicalName, previousName) || incomingName;
    const aliases = [...new Set([
        ...normalizeStringList(oldInfo?.aliases, 8),
        ...normalizeStringList(incoming?.aliases, 8),
        incomingName,
        previousName,
    ])].filter(alias => alias && alias !== canonicalName);
    const seenRound = numOr(roundNumber, 0);
    const present = incoming
        ? incoming.present !== false
        : oldInfo?.present !== false;
    const lastSeenRound = present && seenRound > 0
        ? seenRound
        : numOr(oldInfo?.lastSeenRound, 0);

    return {
        canonicalName,
        aliases: aliases.slice(0, 8),
        location: asString(incoming?.location, asString(oldInfo?.location, "未知位置")),
        statusAndAction: asString(incoming?.statusAndAction, asString(oldInfo?.statusAndAction, "平静")),
        wear: asString(incoming?.wear, asString(oldInfo?.wear, "日常衣着")),
        removedItemsLock: locks,
        inventory: Array.isArray(incoming?.inventory) ? newInventory : oldInventory,
        present,
        lastSeenRound,
    };
}

/**
 * 将模型输出的状态账本与旧账本合并。已摘除饰品锁采用并集策略，
 * 只有模型明确返回 unlockedItems 时才允许解锁。角色通过 canonicalName/aliases
 * 做稳定匹配，避免同一人物换称号或昵称后生成重复卡片。
 */
export function mergeStateLedger(oldLedger, parsedLedger, roundNumber = 0) {
    const previous = oldLedger && typeof oldLedger === "object" ? oldLedger : {};
    const previousChars = previous.characters && typeof previous.characters === "object"
        ? previous.characters
        : {};
    const next = parsedLedger && typeof parsedLedger === "object" ? parsedLedger : {};
    const nextChars = next.characters && typeof next.characters === "object" && !Array.isArray(next.characters)
        ? next.characters
        : null;

    if (!nextChars) {
        return {
            time: asString(next.time, asString(previous.time, "未知时间")),
            characters: deepClone(previousChars),
            todosAndPromises: Array.isArray(next.todosAndPromises)
                ? normalizeStringList(next.todosAndPromises, 8)
                : normalizeStringList(previous.todosAndPromises, 8),
        };
    }

    const mergedChars = {};
    const consumedPreviousKeys = new Set();

    // 先按稳定身份匹配本轮返回的个体，命中别名时沿用旧键名。
    for (const [incomingName, incoming] of Object.entries(nextChars)) {
        if (!isSafeObjectKey(incomingName) || !incoming || typeof incoming !== "object") continue;
        const matchedKey = findCharacterKey(previousChars, incomingName, incoming);
        const previousName = matchedKey || incomingName;
        if (matchedKey) consumedPreviousKeys.add(matchedKey);
        mergedChars[previousName] = mergeCharacterRecord(
            previousName,
            matchedKey ? previousChars[matchedKey] : null,
            incoming,
            incomingName,
            roundNumber,
        );
    }

    // 本轮未返回的旧人物保留最后状态，避免模型遗漏导致状态凭空消失。
    for (const [name, oldInfo] of Object.entries(previousChars)) {
        if (!isSafeObjectKey(name) || !oldInfo || typeof oldInfo !== "object") continue;
        if (consumedPreviousKeys.has(name) || mergedChars[name]) continue;
        mergedChars[name] = mergeCharacterRecord(name, oldInfo, null, name, 0);
    }

    return {
        time: asString(next.time, asString(previous.time, "未知时间")),
        characters: mergedChars,
        todosAndPromises: Array.isArray(next.todosAndPromises)
            ? normalizeStringList(next.todosAndPromises, 8)
            : normalizeStringList(previous.todosAndPromises, 8),
    };
}

/**
 * 调用 Embedding API 获取向量
 */
export async function getEmbeddingVector(
    settings,
    inputText,
    timeoutMs = EMBEDDING_REQUEST_TIMEOUT_MS,
    signal = null,
) {
    throwIfAborted(signal);
    if (!settings.useEmbeddingApi || !settings.embeddingApiUrl || !settings.embeddingApiKey) {
        return null;
    }
    if (Date.now() < embeddingFailureUntil) return null;
    try {
        const baseUrl = settings.embeddingApiUrl.trim().replace(/\/+$/, "");
        const endpoint = baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
        const res = await fetchWithTimeout(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.embeddingApiKey.trim()}`,
            },
            body: JSON.stringify({
                model: settings.embeddingModel || "BAAI/bge-m3",
                input: inputText.slice(0, 1000),
            }),
        }, timeoutMs, signal);
        if (!res.ok) {
            embeddingFailureUntil = Date.now() + 60_000;
            return null;
        }
        const data = await res.json();
        embeddingFailureUntil = 0;
        return data?.data?.[0]?.embedding || null;
    } catch (e) {
        if (signal?.aborted || e?.name === "AbortError") throw createAbortError();
        console.warn("[Tiandao Memory] Embedding API fallback to local lexical search:", e);
        embeddingFailureUntil = Date.now() + 60_000;
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
    const signal = turnInfo.signal || null;
    throwIfAborted(signal);
    const parsedRound = Number(roundNumber);
    const currentRound = Number.isFinite(parsedRound) && parsedRound > 0 ? parsedRound : 1;
    normalizeMemoryData(memoryData);
    const working = cloneMemoryForUpdate(memoryData);

    if (working.lastProcessedMessageId >= startMessageId) {
        rollbackMemoryFromMessageIndex(working, startMessageId);
    }

    const currentStateJson = JSON.stringify(working.stateLedger, null, 2);

    const systemPrompt = `你是一个高精度的长线角色扮演状态追踪器与纯叙事记忆引擎。
请阅读【上一轮实体状态账本】与【最新一轮剧情原文】，输出严格的 JSON 格式结果。

身份识别原则（极其重要）：
- “玩家昵称”只是输入者署名，“角色卡名”只是当前卡片的名称；二者都不等于剧情内人物的姓名。
- 多人卡、群像卡、大世界卡的角色卡名可能代表世界、组织或多个角色，严禁把卡名硬套给某一个出场人物。
- 玩家可能以具体角色、旁白、系统、上帝视角或完全不在场的观察者身份参与。玩家不一定是角色，也不需要每轮都出现在账本中。
- 如果玩家本轮以某个具体角色身份行动，请把玩家控制的那个角色放在 characters 对象的第一位；如果玩家是旁白/系统/上帝视角，则不要为了排序而强行添加玩家条目。
- 只记录剧情中真实出场、且拥有独立行动/物理状态的个体，并优先使用剧情内最稳定、最明确的称呼作为键名。
- 不要使用“User”“Char”“Character”“玩家”“主角”等占位称呼作为人物名；使用剧情中的真实称呼。
- 若同一人物有本名、称号、昵称或别名，请沿用上一轮账本的键名，并在 aliases 中记录本轮出现的其他称呼；canonicalName 保持最稳定的本名。
- present 表示本轮该个体是否仍在场；暂时离开但仍会回归的人物保留条目并标记 present=false，不要直接删除。

核心要求：
1. **纯叙事时间线微摘要 (l0_summary)**：
   - 必须采用故事时间线口吻（拒绝任何代码感或“第X楼”等机械字眼）。
   - 范例：“[某年某月某日上午] 在客厅里，在场角色脱下外套并随手放在沙发上，与同行者商定了明天的行程，心情逐渐放松...”
   - 用剧情中的实际人物称呼叙述，不要套用“Char/User”占位名。
   - 只在剧情原文明确出现日期、时刻、相对时间或时间推进时记录时间；原文没有时间信息时使用“稍后/当夜/次日”等有依据的相对描述，或直接省略时间，严禁把楼层显示时间戳当作剧情时间，严禁编造精确日期。
   - 精炼保留时间流逝、地点、剧情推进、情感互动细节与关键动作（80~140字）。
   - 提取 3~5 个关键词 (keywords)。
2. **按实际出场个体追踪物理状态 (characters)**：
   - 只为本轮真实在场、且可辨认的具体角色/实体分别建立对象。旁白、系统提示、上帝视角观察者若没有独立物理状态，不要建立人物卡。
   - 同一人物沿用上一轮账本中的键名；上一轮账本中的条目若本轮未明确离场，应继续增量更新，不要无故删除。
     * **location**：该个体当前具体所在的地点/房间。
     * **statusAndAction**：当前神态动作、心理状态或正在进行的行动。
     * **wear**：当前身上的衣着与穿戴（根据剧情穿脱实时更新）。
     * **removedItemsLock（核心防回滚锁·极其重要）**：
       - 只要该个体在剧情中摘下了某件饰品（如眼镜、耳环、发卡）或脱下了衣物（如外套、鞋袜），必须加入此数组！注明状态（例："金丝眼镜（已摘下放床头柜，当前未佩戴）"）。
       - **继承铁律**：上轮账本中该个体已有的已摘除饰品锁，只要本轮剧情未明确描写重新戴上，**必须原封不动保留**，严禁擅自清空！
       - 只有剧情明确描写重新戴上某件物品时，才把该物品写入同一个个体的 unlockedItems 数组；不确定时不要写。
     * **inventory**：该个体随身携带的重要信物、道具、钥匙、手机或关键物品（随身道具，上限 6 条）。
3. **todosAndPromises**：尚未完成的约定、日程或待办（已完成的事项移除，新约定加入）。不要强行把约定归到某个角色名下。

请严格按以下 JSON 结构返回：
{
  "l0_summary": "[具体时间] 剧情纯叙事...",
  "keywords": ["关键词1", "关键词2"],
  "stateLedger": {
    "time": "具体日期与时间段（例：春季某日上午）",
    "characters": {
      "剧情内实际称呼": {
        "canonicalName": "该个体最稳定的本名",
        "aliases": ["本轮出现的别名/称号/昵称"],
        "location": "当前具体地点",
        "statusAndAction": "神态动作与当前正在做的事",
        "wear": "当前衣着与佩戴",
        "removedItemsLock": ["已摘下/脱下未重新穿戴的饰品或衣物（未重戴绝不清除）"],
        "unlockedItems": ["本轮明确重新戴上的物品；没有则留空数组"],
        "inventory": ["随身携带的关键道具/信物"],
        "present": true
      }
    },
    "todosAndPromises": [
      "未完成的约定或待办事项"
    ]
  }
}`;

    const userPrompt = `【当前剧情轮次】：第 ${currentRound} 轮
【发言标识，仅用于区分输入与回复，不代表剧情身份】：
- 玩家输入署名：${userName || "未设置"}
- 本条回复的发言者/角色卡名：${charName || "未设置"}

【上一轮实体状态账本 (请在此基础上增量更新，切勿丢失已摘除饰品锁)】：
${currentStateJson}

【第 ${currentRound} 轮剧情原文】：
${dialogueText}

请先根据剧情本身判断实际出场个体，再直接输出更新后的 JSON：`;

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
    ];
    const maxAttempts = 1 + Math.min(5, Math.max(0, Math.floor(numOr(settings.summaryRetryCount, 2))));
    let parsed = null;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt > 1) {
                const backoffMs = Math.min(4000, 500 * 2 ** (attempt - 2));
                const retryAfterMs = Math.min(60_000, Math.max(0, numOr(lastError?.retryAfterMs, 0)));
                const delayMs = Math.max(backoffMs, retryAfterMs);
                if (typeof turnInfo.onRetry === "function") {
                    turnInfo.onRetry(attempt, maxAttempts, lastError);
                }
                await sleepWithAbort(delayMs, signal);
            }

            const retryMessages = attempt === 1
                ? messages
                : [
                    { role: "system", content: systemPrompt },
                    {
                        role: "user",
                        content: `${userPrompt}\n\n【格式纠正】上一次返回无法解析为有效摘要 JSON。请重新阅读原文，只输出一个合法 JSON 对象，不要 Markdown 代码块、不要额外解释，并确保包含 l0_summary、keywords、stateLedger。上一次错误：${String(lastError?.message || "格式无法解析").slice(0, 300)}`,
                    },
                ];
            const rawOutput = await callIndependentLLM(settings, retryMessages, { signal });
            parsed = safeParseJSON(rawOutput);
            if (parsed && typeof parsed.l0_summary === "string" && parsed.l0_summary.trim()) {
                break;
            }
            parsed = null;
            lastError = new Error(`模型返回格式无法解析为有效摘要 JSON（响应长度 ${String(rawOutput).length}）`);
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw createAbortError();
            lastError = error;
            const message = String(error?.message || error);
            const status = Number(error?.status);
            if (/未配置/.test(message) || [400, 401, 403, 404, 422].includes(status)) {
                throw error;
            }
        }
    }

    if (!parsed) {
        const retried = maxAttempts > 1 ? `（已自动重试 ${maxAttempts - 1} 次）` : "";
        throw new Error(`${lastError?.message || "模型返回格式无法解析为有效摘要 JSON"}${retried}`);
    }

    const summaryText = parsed.l0_summary.trim().slice(0, 1200);
    const keywords = normalizeStringList(parsed.keywords, 8);
    const previousStateLedger = deepClone(working.stateLedger);
    working.stateLedger = parsed.stateLedger
        ? mergeStateLedger(working.stateLedger, parsed.stateLedger, currentRound)
        : working.stateLedger;

    const embedding = await getEmbeddingVector(
        settings,
        `${summaryText} ${keywords.join(" ")}`,
        EMBEDDING_REQUEST_TIMEOUT_MS,
        signal,
    );
    const isStateKeyframe = currentRound === 1 || currentRound % STATE_KEYFRAME_INTERVAL === 0;
    const stateDelta = isStateKeyframe ? null : buildStateDelta(previousStateLedger, working.stateLedger);
    const l0Entry = {
        id: `L0_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        level: 0,
        roundRange: String(currentRound),
        startMessageId: startMessageId,
        endMessageId: endMessageId,
        text: summaryText,
        keywords: keywords,
        timestamp: Date.now(),
        embedding: embedding,
        // 每 20 轮保存完整关键帧，其余轮次只保存相对上一轮的状态差异。
        ...(isStateKeyframe
            ? { postStateSnapshot: deepClone(working.stateLedger) }
            : { postStateDelta: stateDelta }),
    };

    if (!working.levels[0]) working.levels[0] = [];
    working.levels[0].push(l0Entry);
    working.archivePool.push(l0Entry);

    await checkAndCascadeMerge(settings, working, { signal });

    throwIfAborted(signal);
    if (typeof turnInfo.shouldCommit === "function" && !turnInfo.shouldCommit()) {
        return null;
    }
    sampleArchiveEmbeddings(working);
    commitMemoryUpdate(memoryData, working);
    return l0Entry;
}

/**
 * 递归金字塔合并引擎（按轮次归并）
 */
export async function checkAndCascadeMerge(settings, memoryData, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
    if (!memoryData.levels || typeof memoryData.levels !== "object") {
        memoryData.levels = { 0: [] };
    }
    const chunkSize = Math.min(20, Math.max(2, numOr(settings.mergeChunkSize, 5)));

    for (let lvl = 0; lvl < MAX_MEMORY_LEVEL; lvl++) {
        if (!Array.isArray(memoryData.levels[lvl])) {
            memoryData.levels[lvl] = [];
        }
        const keepRecent = ACTIVE_LEVEL_MIN_KEEP[lvl] ?? chunkSize - 1;
        const mergeThreshold = keepRecent + chunkSize;
        while (memoryData.levels[lvl].length >= mergeThreshold) {
            throwIfAborted(signal);
            const itemsToMerge = memoryData.levels[lvl].slice(0, chunkSize);
            const firstRound = parseRoundRange(itemsToMerge[0].roundRange).start;
            const lastRound = parseRoundRange(itemsToMerge[itemsToMerge.length - 1].roundRange).end;
            const mergedRoundRange = `${firstRound}-${lastRound}`;

            const mergedText = await mergeSummariesAtLevel(
                settings,
                lvl,
                itemsToMerge,
                mergedRoundRange,
                signal,
            );
            if (!mergedText) {
                throw new Error(`L${lvl + 1} 合并返回为空，已保留原 L${lvl} 条目`);
            }

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
            if (lvl + 1 === MAX_MEMORY_LEVEL) capTopLevelEntries(memoryData);
        }
    }

    if (!Array.isArray(memoryData.levels[MAX_MEMORY_LEVEL])) {
        memoryData.levels[MAX_MEMORY_LEVEL] = [];
    }
    capTopLevelEntries(memoryData);
    await flushFarHistory(settings, memoryData, { signal });
}

/**
 * 用 archivePool 中全部 L0 重建层级。用于手动编辑过 L0 文本后，
 * 让受影响的高层摘要重新由新文本合成。
 */
export async function rebuildMemoryHierarchy(settings, memoryData, shouldCommit = null, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
    normalizeMemoryData(memoryData);
    const working = cloneMemoryForUpdate(memoryData);
    const l0Entries = working.archivePool
        .filter(item => item && item.level === 0)
        .sort((a, b) =>
            numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
            - numOr(b.startMessageId, parseRoundRange(b.roundRange).start)
        );
    working.levels = { 0: l0Entries.slice() };
    working.fadedHistory = { earliestRound: 0, latestRound: 0, count: 0 };
    working.farHistory = { text: "", earliestRound: 0, latestRound: 0, updatedAt: 0 };
    working.pendingFarHistory = [];
    for (const item of l0Entries) item.level = 0;
    await checkAndCascadeMerge(settings, working, { signal });
    sampleArchiveEmbeddings(working);
    throwIfAborted(signal);
    if (typeof shouldCommit === "function" && !shouldCommit()) return false;
    commitMemoryUpdate(memoryData, working);
    return true;
}

/**
 * 将 N 条同级轮次摘要合成为 1 条大阶段故事脉络
 */
async function mergeSummariesAtLevel(settings, currentLevel, items, mergedRoundRange, signal = null) {
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
    ], { jsonMode: false, signal });

    return merged.replace(/^```[\s\S]*?\n/, "").replace(/```$/, "").trim().slice(0, 4000);
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

function getMemorySearchTokens(item) {
    if (!item || typeof item !== "object") return new Set();
    const text = String(item.text || "");
    const keywords = Array.isArray(item.keywords) ? item.keywords.join(" ") : "";
    const signature = `${text}\u0000${keywords}`;
    const cached = memorySearchTokenCache.get(item);
    if (cached?.signature === signature) return cached.tokens;
    const tokens = extractBigramsAndTokens(`${text} ${keywords}`);
    memorySearchTokenCache.set(item, { signature, tokens });
    return tokens;
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
    normalizeMemoryData(memoryData);

    const activeL0Ids = new Set((memoryData.levels[0] || []).map(x => x.id));
    const candidates = memoryData.archivePool.filter(item => !activeL0Ids.has(item.id));
    if (candidates.length === 0) return [];

    // 生成链路只给查询向量一个很小的预算；超时后立即回退到本地词法检索。
    const queryEmbedding = await getEmbeddingVector(settings, queryText, 2500);
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
        const itemBigrams = getMemorySearchTokens(item);
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

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return numOr(b.item.endMessageId, parseRoundRange(b.item.roundRange).end)
            - numOr(a.item.endMessageId, parseRoundRange(a.item.roundRange).end);
    });
    const topK = Math.min(20, Math.max(1, numOr(settings.retrievalTopK, 3)));
    return scored
        .filter(x => x.score >= 0.12)
        .slice(0, topK)
        .map(x => x.item);
}

/**
 * 组装给主模型的记忆注入块（纯轮次时间线 + 各人物物理状态）
 */
export function estimatePromptTokens(text) {
    const source = String(text || "");
    const cjkCount = (source.match(/[\u3400-\u9fff]/g) || []).length;
    const otherCount = Math.max(0, source.length - cjkCount);
    return Math.ceil(cjkCount + otherCount / 3.5);
}

function truncatePromptToBudget(text, budget) {
    const source = String(text || "");
    if (estimatePromptTokens(source) <= budget) return source;
    const suffix = "\n</tiandao_memory_system>";
    let low = 0;
    let high = source.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimatePromptTokens(source.slice(0, mid) + suffix) <= budget) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return source.slice(0, low) + suffix;
}

export function buildInjectedMemoryPrompt(
    memoryData,
    retrievedSnacks = [],
    primaryName = "",
    tokenBudget = 5000,
    options = {},
) {
    if (!memoryData) return "";
    const budget = Math.max(1000, numOr(tokenBudget, 5000));
    const ledger = memoryData.stateLedger || {};
    const chars = ledger.characters || {};

    const charBlocks = [];
    const entries = Object.entries(chars);
    entries.sort(([nameA], [nameB]) => {
        const aFirst = Boolean(primaryName) && nameA === primaryName;
        const bFirst = Boolean(primaryName) && nameB === primaryName;
        if (aFirst !== bFirst) return aFirst ? -1 : 1;
        const aPresent = chars[nameA]?.present === false ? 0 : 1;
        const bPresent = chars[nameB]?.present === false ? 0 : 1;
        if (aPresent !== bPresent) return bPresent - aPresent;
        const aSeen = numOr(chars[nameA]?.lastSeenRound, 0);
        const bSeen = numOr(chars[nameB]?.lastSeenRound, 0);
        if (aSeen !== bSeen) return bSeen - aSeen;
        return 0;
    });
    const primaryKey = primaryName && chars[primaryName] ? primaryName : "";
    for (const [name, info] of entries) {
        if (!info) continue;
        const removed = (info.removedItemsLock || []).length > 0
            ? `\n    - 已摘除/脱下饰品(锁): ${info.removedItemsLock.join("; ")} [未描写重戴前严禁出现!]`
            : "";
        const inv = (info.inventory || []).length > 0
            ? `\n    - 随身携带道具: ${info.inventory.join("; ")}`
            : "";
        const aliasText = (info.aliases || []).length > 0
            ? `\n    - 别名/称号: ${info.aliases.join("; ")}`
            : "";
        const presence = info.present === false ? "（暂离场）" : "";

        charBlocks.push({
            primary: name === primaryKey,
            away: info.present === false,
            text: `- **【${name}】**${presence}${aliasText}
    - 当前地点: ${info.location || "未知"}
    - 状态与行动: ${info.statusAndAction || "无"}
    - 当前穿戴: ${info.wear || "常规穿戴"}${removed}${inv}`,
        });
    }

    const todoLines = (ledger.todosAndPromises || []).length > 0
        ? ledger.todosAndPromises.map(x => `  * 📌 ${x}`).join("\n")
        : "  * 无";

    const timelineItems = [];
    const maxLvl = Math.max(...Object.keys(memoryData.levels || {}).map(Number), MAX_MEMORY_LEVEL);
    const farHistoryText = String(memoryData.farHistory?.text || "").trim();
    if (farHistoryText) {
        timelineItems.push({
            text: farHistoryText,
            level: -1,
            anchor: false,
            removePriority: 15,
        });
    }

    for (let lvl = maxLvl; lvl >= 1; lvl--) {
        const list = [...(memoryData.levels?.[lvl] || [])].sort((a, b) => {
            return numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
                - numOr(b.startMessageId, parseRoundRange(b.roundRange).start);
        });
        // 最高层保留开头与最近一段，避免极长聊天让顶部脉络无限膨胀。
        const visibleList = lvl >= 3 ? selectTopLevelEntries(list) : list;
        visibleList.forEach((item, index) => {
            const anchor = lvl === MAX_MEMORY_LEVEL && index < TOP_LEVEL_ANCHOR_COUNT;
            const removePriority = lvl === 1 ? 40 : (lvl === 2 ? 20 : (anchor ? 25 : 30));
            timelineItems.push({
                text: `• [第 ${item.roundRange} 轮阶段总览] ${String(item.text || "")}`,
                level: lvl,
                anchor,
                removePriority,
            });
        });
    }

    const recentRawRounds = Math.max(0, numOr(options.recentRawRounds, 0));
    const currentRound = Math.max(0, numOr(options.currentRound, 0));
    const rawWindowStart = currentRound > 0 ? currentRound - recentRawRounds + 1 : Infinity;
    const l0List = [...(memoryData.levels?.[0] || [])].filter(item => {
        if (recentRawRounds <= 0 || currentRound <= 0) return true;
        const range = parseRoundRange(item.roundRange);
        return range.end < rawWindowStart || range.start > currentRound;
    }).sort((a, b) => {
        return numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
            - numOr(b.startMessageId, parseRoundRange(b.roundRange).start);
    });
    if (l0List.length > 0) {
        for (const item of l0List) {
            timelineItems.push({
                text: `• [第 ${item.roundRange} 轮] ${String(item.text || "")}`,
                level: 0,
                anchor: false,
                removePriority: 50,
            });
        }
    }

    const renderedRetrieved = (retrievedSnacks || []).map(item => ({
        text: `• [过往回忆·第 ${item.roundRange} 轮] ${String(item.text || "")}`,
        removePriority: 10,
    }));

    const renderPrompt = (blocks, timeline, retrieved) => {
        const timelineByLevel = new Map();
        for (const item of timeline) {
            if (!timelineByLevel.has(item.level)) timelineByLevel.set(item.level, []);
            timelineByLevel.get(item.level).push(item.text);
        }
        const timelineSections = [];
        const farLines = timelineByLevel.get(-1) || [];
        if (farLines.length > 0) {
            timelineSections.push(`### 远史编年（按剧情内时间整理）\n${farLines.join("\n")}`);
        }
        for (let lvl = maxLvl; lvl >= 1; lvl--) {
            const lines = timelineByLevel.get(lvl) || [];
            if (lines.length === 0) continue;
            const title = lvl === 1 ? "阶段剧情脉络 (近期)" : "长线剧情大阶段脉络";
            timelineSections.push(`### ${title}\n${lines.join("\n")}`);
        }
        const l0Lines = timelineByLevel.get(0) || [];
        if (l0Lines.length > 0) {
            timelineSections.push(`### 最近单轮剧情时间线\n${l0Lines.join("\n")}`);
        }

        const retrievedSection = retrieved.length > 0
            ? `\n## 三、当前话题相关的过往回忆片段（按需唤醒）\n${retrieved.map(item => item.text).join("\n")}\n`
            : "";

        return `<tiandao_memory_system>
# 溯微剧情时间线与出场个体动态状态（最高事实基准）

## 一、当前各出场个体实时物理状态账本（绝对优先于角色卡初始设定）
- **当前故事时间**: ${ledger.time || "未知"}
${blocks.map(block => block.text).join("\n\n") || "（暂无出场个体状态）"}
- **未完成约定与待办**:
${todoLines}

## 二、剧情时间线叙事脉络（由远及近·按轮数推进）
${timelineSections.join("\n\n") || "（尚无归档时间线）"}
${retrievedSection}</tiandao_memory_system>`;
    };

    let fittedBlocks = charBlocks.slice();
    let fittedTimeline = timelineItems.slice();
    let fittedRetrieved = renderedRetrieved.slice();
    let prompt = renderPrompt(fittedBlocks, fittedTimeline, fittedRetrieved);

    while (estimatePromptTokens(prompt) > budget && fittedRetrieved.length > 0) {
        fittedRetrieved.pop();
        prompt = renderPrompt(fittedBlocks, fittedTimeline, fittedRetrieved);
    }

    while (estimatePromptTokens(prompt) > budget && fittedTimeline.length > 0) {
        let removeIndex = 0;
        for (let i = 1; i < fittedTimeline.length; i++) {
            if (fittedTimeline[i].removePriority < fittedTimeline[removeIndex].removePriority) {
                removeIndex = i;
            }
        }
        fittedTimeline.splice(removeIndex, 1);
        prompt = renderPrompt(fittedBlocks, fittedTimeline, fittedRetrieved);
    }

    while (estimatePromptTokens(prompt) > budget && fittedBlocks.length > 1) {
        let removeIndex = fittedBlocks.length - 1;
        while (removeIndex > 0 && fittedBlocks[removeIndex].primary) removeIndex--;
        if (fittedBlocks[removeIndex]?.primary) break;
        fittedBlocks.splice(removeIndex, 1);
        prompt = renderPrompt(fittedBlocks, fittedTimeline, fittedRetrieved);
    }

    return truncatePromptToBudget(prompt, budget);
}

/**
 * 组装纯叙事时间线总览（按轮数展示）
 */
export function buildNarrativeStoryView(memoryData) {
    if (!memoryData) return "暂无记忆记录。";
    const ledger = memoryData.stateLedger || {};
    const chars = ledger.characters || {};

    const charList = Object.entries(chars).map(([name, info]) => {
        // 已摘除的饰品并入随身道具展示（标注“已摘下”），不再单独列出
        const removedParts = (info.removedItemsLock || []).map(x => {
            const text = String(x);
            return /已摘|未佩戴|已脱/.test(text) ? text : `${text}（已摘下）`;
        });
        const allItems = [...(info.inventory || []), ...removedParts];
        const inv = allItems.length > 0
            ? `\n  - 随身道具: ${allItems.join(", ")}`
            : "";
        const alias = (info.aliases || []).length > 0 ? `（别名: ${info.aliases.join(", ")}）` : "";
        const presence = info.present === false ? "（暂离场）" : "";
        return `【${name}】${presence}${alias}
  - 所在地点: ${info.location || "未知"}
  - 状态与行动: ${info.statusAndAction || "正常"}
  - 衣着穿戴: ${info.wear || "未记录"}${inv}`;
    }).join("\n\n");

    const lines = [];
    lines.push(`📖 当前故事时间：${ledger.time || "未知"}\n`);
    lines.push(`👥 在场各人物当前状态：\n${charList || "暂无出场人物"}\n`);

    const farHistoryText = String(memoryData.farHistory?.text || "").trim();
    if (farHistoryText) {
        lines.push(`🕰 远史编年：\n${farHistoryText}\n`);
    }

    if ((ledger.todosAndPromises || []).length > 0) {
        lines.push(`📌 待办与约定事项：\n${ledger.todosAndPromises.map(x => "  • " + x).join("\n")}\n`);
    }

    lines.push(`📜 剧情时间线脉络（按一问一答轮数）：`);

    const allSummaries = [];
    const maxLvl = Math.max(...Object.keys(memoryData.levels || {}).map(Number), 3);
    for (let lvl = maxLvl; lvl >= 1; lvl--) {
        const list = [...(memoryData.levels?.[lvl] || [])].sort((a, b) => {
            return numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
                - numOr(b.startMessageId, parseRoundRange(b.roundRange).start);
        });
        const visibleList = lvl >= 3 ? selectTopLevelEntries(list) : list;
        for (const it of visibleList) {
            allSummaries.push(`• [第 ${it.roundRange} 轮阶段总览]\n  ${String(it.text || "")}`);
        }
    }
    const sortedL0 = [...(memoryData.levels?.[0] || [])].sort((a, b) => {
        return numOr(a.startMessageId, parseRoundRange(a.roundRange).start)
            - numOr(b.startMessageId, parseRoundRange(b.roundRange).start);
    });
    for (const it of sortedL0) {
        allSummaries.push(`• [第 ${it.roundRange} 轮]\n  ${String(it.text || "")}`);
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
                delete item.postStateDelta;
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
                    postStateDelta: item.postStateDelta,
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
                if (!item.postStateDelta && cached.postStateDelta) item.postStateDelta = cached.postStateDelta;
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
    const {
        onProgress,
        onChunkSaved,
        onRetry,
        shouldAbort,
        shouldCommitTurn,
        signal = null,
        saveEvery = 5,
    } = options;
    throwIfAborted(signal);
    const batchSaveSize = Math.min(20, Math.max(1, numOr(saveEvery, 5)));

    if (!Array.isArray(chatMessages) || chatMessages.length === 0) {
        throw new Error("当前聊天没有可扫描的历史消息");
    }
    normalizeMemoryData(memoryData);

    // 找出所有配对的有效 AI 回复楼层
    const aiMessageIndices = [];
    for (let idx = 0; idx < chatMessages.length; idx++) {
        const m = chatMessages[idx];
        if (isAiReplyMessage(m, settings.includeNativeHidden)) {
            aiMessageIndices.push(idx);
        }
    }

    if (aiMessageIndices.length === 0) {
        return { processedCount: 0, aborted: false };
    }

    const lastProcessedMessageId = memoryData.lastProcessedMessageId ?? -1;
    const pendingAiIndices = aiMessageIndices.filter(i => i > lastProcessedMessageId);
    const roundByMessageId = new Map(aiMessageIndices.map((idx, position) => [idx, position + 1]));

    if (pendingAiIndices.length === 0) {
        return { processedCount: 0, aborted: false };
    }

    let processedCount = 0;
    const totalRounds = pendingAiIndices.length;

    for (let i = 0; i < pendingAiIndices.length; i++) {
        throwIfAborted(signal);
        if (typeof shouldAbort === "function" && shouldAbort()) {
            return { processedCount, aborted: true };
        }

        const msgIdx = pendingAiIndices[i];
        const roundNumber = roundByMessageId.get(msgIdx) || 1;

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
            const result = await summarizeSingleTurn(settings, memoryData, {
                roundNumber,
                startMessageId: startFloor,
                endMessageId: msgIdx,
                userName,
                charName,
                dialogueText: batchMsgs.join("\n\n"),
                onRetry: typeof onRetry === "function"
                    ? (attempt, total, error) => onRetry(attempt, total, error, roundNumber)
                    : null,
                shouldCommit: shouldCommitTurn,
                signal,
            });
            if (!result) {
                return { processedCount, aborted: true };
            }
        }

        memoryData.lastProcessedMessageId = msgIdx;
        memoryData.lastProcessedRound = roundNumber;
        processedCount++;

        if (typeof onChunkSaved === "function"
            && ((i + 1) % batchSaveSize === 0 || i === pendingAiIndices.length - 1)) {
            await onChunkSaved(msgIdx);
        }
    }

    return { processedCount, aborted: false };
}
