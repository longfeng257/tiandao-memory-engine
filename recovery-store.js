import { buildChatMessageFingerprint, normalizeMemoryData } from "./memory-engine.js";

const MAX_POINTS = 3;
const MAX_CHARS = 4_000_000;
const clone = value => JSON.parse(JSON.stringify(value));

// Auto-hiding changes is_system, but does not change the underlying story.
export function recoveryChatSignature(chat) {
    return buildChatMessageFingerprint((chat || []).map(message => message?.extra?.tiandao_hidden
        ? { ...message, is_system: false }
        : message)).join("\n");
}

export function createRecoveryPoint(memory, chat, label, now = Date.now()) {
    const point = {
        id: "recovery-" + now + "-" + Math.random().toString(36).slice(2, 8),
        at: now,
        label: String(label || "记忆修改").slice(0, 80),
        chatSignature: recoveryChatSignature(chat),
        memory: clone(memory),
    };
    if (JSON.stringify([point]).length > MAX_CHARS) {
        const error = new Error("当前记忆超过自动恢复点容量");
        error.code = "RECOVERY_TOO_LARGE";
        throw error;
    }
    return point;
}

export function appendRecoveryPoint(points, point) {
    const next = [...(Array.isArray(points) ? points : []), point].slice(-MAX_POINTS);
    while (next.length > 1 && JSON.stringify(next).length > MAX_CHARS) next.shift();
    return next;
}

export function restoreRecoveryPoint(point, chat) {
    if (!point?.memory || point.chatSignature !== recoveryChatSignature(chat)) {
        throw new Error("聊天原文或分支已变化，不能直接恢复此记忆；可下载备份后人工处理");
    }
    return normalizeMemoryData(clone(point.memory));
}
