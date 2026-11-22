import { normalizeMemoryData } from "./memory-engine.js";
import { normalizeCharacterMemory } from "./character-memory.js";

export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 50_000;
const FORMAT = "suwei-memory";
const FORMAT_VERSION = 1;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isText = value => typeof value === "string";
const isNonemptyText = value => isText(value) && value.trim().length > 0;
const isInt = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const isBoolean = value => typeof value === "boolean";
const isTextList = value => Array.isArray(value) && value.every(isText);

function requireValid(condition, field) {
    if (!condition) throw new Error(`${field} 格式无效`);
}

function optional(record, key, test, path) {
    if (owns(record, key)) requireValid(test(record[key]), `${path}.${key}`);
}

// JSON objects are detached, but unsafe keys and excessive nesting must be rejected before normalization.
function validateJsonTree(value, depth = 0) {
    if (depth > 64) throw new Error("记忆数据嵌套过深");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("记忆数据包含无效数字");
    if (Array.isArray(value)) {
        for (const item of value) validateJsonTree(item, depth + 1);
    } else if (isRecord(value)) {
        for (const key of Object.keys(value)) {
            if (UNSAFE_KEYS.has(key)) throw new Error(`记忆数据包含不安全的字段名 ${key}`);
            validateJsonTree(value[key], depth + 1);
        }
    }
}

function validateLedger(value, path) {
    requireValid(isRecord(value), path);
    optional(value, "time", isText, path);
    if (owns(value, "characters")) {
        requireValid(isRecord(value.characters), `${path}.characters`);
        for (const [name, info] of Object.entries(value.characters)) {
            const field = `${path}.characters[${name.slice(0, 100)}]`;
            requireValid(name.trim().length > 0 && name.length <= 100 && isRecord(info), field);
            for (const key of ["canonicalName", "location", "statusAndAction", "wear", "viewTarget"]) optional(info, key, isText, field);
            for (const key of ["aliases", "inventory", "removedItemsLock"]) optional(info, key, isTextList, field);
            for (const key of ["present", "viewTargetVisible"]) optional(info, key, isBoolean, field);
            for (const key of ["lastSeenRound", "viewSeenRound"]) optional(info, key, isInt, field);
            try {
                normalizeCharacterMemory(info, { strict: true });
            } catch (error) {
                throw new Error(`${field}：${error.message}`);
            }
            for (const entry of info.growth || []) optional(entry, "sourceRound", isInt, `${field}.growth`);
        }
    }
    if (owns(value, "todosAndPromises")) {
        const field = `${path}.todosAndPromises`;
        requireValid(Array.isArray(value.todosAndPromises), field);
        for (const todo of value.todosAndPromises) {
            // Legacy ledgers also stored plain strings and used title/content/task for the text.
            if (isNonemptyText(todo)) continue;
            requireValid(isRecord(todo) && isNonemptyText(todo.text ?? todo.title ?? todo.content ?? todo.task), field);
            for (const key of ["id", "text", "title", "content", "task", "status", "completedBy"]) optional(todo, key, isText, field);
            for (const key of ["completed", "done"]) optional(todo, key, isBoolean, field);
            optional(todo, "completedRound", isInt, field);
        }
    }
}

function validateStateDelta(value, path, depth = 0) {
    requireValid(isRecord(value) && depth <= 24, path);
    if (value.t === "d") {
        requireValid(!owns(value, "v"), path);
    } else if (value.t === "v") {
        requireValid(owns(value, "v"), path);
    } else {
        requireValid(value.t === "o" && isRecord(value.v), path);
        for (const child of Object.values(value.v)) validateStateDelta(child, path, depth + 1);
    }
}

function validateEntryState(entry, path) {
    if (owns(entry, "postStateSnapshot")) validateLedger(entry.postStateSnapshot, `${path}.postStateSnapshot`);
    if (owns(entry, "postStateDelta")) validateStateDelta(entry.postStateDelta, `${path}.postStateDelta`);
    requireValid(!(owns(entry, "postStateSnapshot") && owns(entry, "postStateDelta")), path);
}

function isRoundRange(value) {
    if (!isText(value)) return false;
    const bounds = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(value);
    if (!bounds) return false;
    const start = Number(bounds[1]), end = Number(bounds[2] ?? bounds[1]);
    return isInt(start) && isInt(end, start);
}

function validateEntry(entry, level, path) {
    requireValid(isRecord(entry), path);
    requireValid(isNonemptyText(entry.text), `${path}.text`);
    requireValid(isRoundRange(entry.roundRange), `${path}.roundRange`);
    optional(entry, "level", value => level === null ? isInt(value) && value <= 3 : value === level, path);
    optional(entry, "id", isNonemptyText, path);
    optional(entry, "pinned", isBoolean, path);
    optional(entry, "keywords", isTextList, path);
    optional(entry, "timestamp", isInt, path);
    if (owns(entry, "startMessageId") || owns(entry, "endMessageId")) {
        requireValid(isInt(entry.startMessageId) && isInt(entry.endMessageId, entry.startMessageId), `${path} 的消息范围`);
    }
    optional(entry, "stateMessageId", value => isInt(value, -1), path);
    optional(entry, "stateRound", isInt, path);
    optional(entry, "embedding", value => value === null || (Array.isArray(value) && value.length <= 4096 && value.every(Number.isFinite)), path);
    optional(entry, "embeddingModel", value => value === null || isText(value), path);
    optional(entry, "embeddingDimension", value => value === null || (isInt(value, 1) && value <= 4096
        && value === entry.embedding?.length), path);
    validateEntryState(entry, path);
}

function validateError(value, roundKey, path) {
    if (value === null) return;
    requireValid(isRecord(value), path);
    optional(value, "message", isText, path);
    optional(value, roundKey, isInt, path);
    optional(value, "at", isInt, path);
}

function validateMemory(memory) {
    requireValid(isRecord(memory), "记忆数据");
    requireValid(isRecord(memory.levels), "levels");
    requireValid(isRecord(memory.stateLedger), "stateLedger");
    for (const key of ["version", "stateStorageVersion", "lastProcessedRound"]) optional(memory, key, isInt, "记忆数据");
    optional(memory, "lastProcessedMessageId", value => isInt(value, -1), "记忆数据");

    let entries = 0;
    function countList(list, path) {
        requireValid(Array.isArray(list), path);
        entries += list.length;
        if (entries > MAX_MEMORY_ENTRIES) throw new Error(`记忆条目超过 ${MAX_MEMORY_ENTRIES} 条，已拒绝导入`);
    }
    const lists = Object.entries(memory.levels).map(([key, list]) => {
        requireValid(/^[0-3]$/.test(key), "levels 层级");
        return { list, level: Number(key), path: `levels.${key}` };
    });
    if (owns(memory, "archivePool")) lists.push({ list: memory.archivePool, level: 0, path: "archivePool" });
    if (owns(memory, "pendingFarHistory")) lists.push({ list: memory.pendingFarHistory, level: null, path: "pendingFarHistory" });
    for (const { list, path } of lists) countList(list, path);
    for (const { list, level, path } of lists) {
        list.forEach((entry, index) => validateEntry(entry, level, `${path}[${index}]`));
    }
    validateLedger(memory.stateLedger, "stateLedger");

    for (const key of ["fadedHistory", "farHistory"]) {
        if (!owns(memory, key)) continue;
        const history = memory[key];
        requireValid(isRecord(history), key);
        optional(history, "earliestRound", isInt, key);
        optional(history, "latestRound", value => isInt(value, history.earliestRound ?? 0), key);
        if (key === "fadedHistory") optional(history, "count", isInt, key);
        else {
            optional(history, "text", isText, key);
            optional(history, "updatedAt", isInt, key);
        }
    }
    if (owns(memory, "lastSummaryError")) validateError(memory.lastSummaryError, "roundNumber", "lastSummaryError");

    if (owns(memory, "rawVectors")) {
        const vectors = memory.rawVectors;
        requireValid(Array.isArray(vectors) && vectors.length <= MAX_MEMORY_ENTRIES, "rawVectors");
        vectors.forEach((entry, index) => {
            const path = `rawVectors[${index}]`;
            requireValid(isRecord(entry) && isInt(entry.index) && isNonemptyText(entry.sig), path);
            if (owns(entry, "model")) requireValid(isText(entry.model) && entry.model.length <= 200, `${path}.model`);
            if (owns(entry, "dim")) requireValid(isInt(entry.dim, 1) && entry.dim <= 4096, `${path}.dim`);
            if (owns(entry, "embedding")) {
                requireValid(Array.isArray(entry.embedding) && entry.embedding.length <= 4096
                    && entry.embedding.every(Number.isFinite), `${path}.embedding`);
                if (owns(entry, "dim")) requireValid(entry.dim === entry.embedding.length, `${path}.dim`);
            }
        });
    }

    const sync = memory.stateSync;
    if (sync === null || sync === undefined) return;
    requireValid(isRecord(sync) && sync.version === 1 && isRecord(sync.base), "stateSync");
    let { endMessageId, round } = sync.base;
    requireValid(isInt(endMessageId, -1) && isInt(round), "stateSync.base 游标");
    optional(sync.base, "sourceFingerprint", isText, "stateSync.base");
    validateLedger(sync.base.ledger, "stateSync.base.ledger");
    countList(sync.entries, "stateSync.entries");
    sync.entries.forEach((entry, index) => {
        const path = `stateSync.entries[${index}]`;
        requireValid(isRecord(entry) && isInt(entry.endMessageId, endMessageId + 1)
            && isInt(entry.round, round + 1), `${path} 游标`);
        optional(entry, "sourceFingerprint", isText, path);
        requireValid(owns(entry, "postStateSnapshot") || owns(entry, "postStateDelta"), path);
        validateEntryState(entry, path);
        ({ endMessageId, round } = entry);
    });
    if (owns(sync, "lastError")) validateError(sync.lastError, "round", "stateSync.lastError");
}

// The signature matches source text/branch, not the author or authenticity of the file.
export function createMemoryBackup(memory, chatSignature, exportedAt = Date.now()) {
    return { format: FORMAT, version: FORMAT_VERSION, exportedAt, chatSignature, memory };
}

export function parseMemoryBackup(text, chatSignature) {
    requireValid(isText(text), "记忆 JSON");
    if (text.length > MAX_IMPORT_FILE_BYTES) throw new Error("记忆文件超过 20MB");
    let parsed;
    try {
        parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (_) {
        throw new Error("文件不是有效的记忆 JSON");
    }
    requireValid(isRecord(parsed), "记忆 JSON");
    validateJsonTree(parsed);

    const envelope = ["format", "exportedAt", "chatSignature", "memory"].some(key => owns(parsed, key));
    if (envelope) {
        requireValid(parsed.format === FORMAT, "记忆备份标识");
        if (parsed.version !== FORMAT_VERSION) throw new Error("不支持该记忆备份版本");
        requireValid(isInt(parsed.exportedAt), "备份导出时间");
        requireValid(isText(parsed.chatSignature), "备份来源签名");
    }
    const memory = envelope ? parsed.memory : parsed;
    validateMemory(memory);
    return {
        memory: normalizeMemoryData(memory),
        sourceVerified: envelope && parsed.chatSignature === chatSignature,
    };
}
