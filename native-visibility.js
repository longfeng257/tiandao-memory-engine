import { buildChatMessageFingerprint } from "./memory-engine.js";

export function visibilitySnapshot(message, index) {
    return { index, is_system: Boolean(message.is_system), tiandao_hidden: message.extra?.tiandao_hidden,
        suwei_auto_hide_opt_out: message.extra?.suwei_auto_hide_opt_out,
        fingerprint: buildChatMessageFingerprint([message])[0], swipe_id: message.swipe_id };
}

export function reconcileNativeVisibility(chat, hiddenIndexes, enabled) {
    const changes = [];
    let hidden = 0, restored = 0;
    if (!Array.isArray(chat)) return { changes, hidden, restored };
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        if (!message || typeof message !== "object") continue;
        const owned = Boolean(message.extra?.tiandao_hidden);
        const optedOut = message.extra?.suwei_auto_hide_opt_out === true;
        const shouldHide = enabled && hiddenIndexes.has(index) && !optedOut;
        const before = { is_system: message.is_system, owned: message.extra?.tiandao_hidden,
            optedOut: message.extra?.suwei_auto_hide_opt_out };
        if (owned && !message.is_system) {
            delete message.extra.tiandao_hidden;
            message.extra.suwei_auto_hide_opt_out = true;
        } else if (owned && !shouldHide) {
            message.is_system = false;
            delete message.extra.tiandao_hidden;
            restored++;
        } else if (shouldHide && !message.is_system) {
            message.extra ||= {};
            message.extra.tiandao_hidden = true;
            message.is_system = true;
            hidden++;
        } else continue;
        changes.push({ index, message, before, after: visibilitySnapshot(message, index) });
    }
    return { changes, hidden, restored };
}

// Revert only unchanged writes from this batch. A later user edit always wins.
export function rollbackNativeVisibility(chat, changes, { newlyHiddenOnly = false } = {}) {
    for (const change of changes || []) {
        const message = chat?.[change.index];
        if (message !== change.message || (newlyHiddenOnly && (change.before.is_system || !change.after.tiandao_hidden))) continue;
        if (JSON.stringify(visibilitySnapshot(message, change.index)) !== JSON.stringify(change.after)) continue;
        message.is_system = change.before.is_system;
        for (const [key, value] of [['tiandao_hidden', change.before.owned], ['suwei_auto_hide_opt_out', change.before.optedOut]]) {
            if (value === undefined) delete message.extra[key];
            else message.extra[key] = value;
        }
    }
}

export function visibilityRanges(changes) {
    const ranges = [];
    for (const change of changes) {
        if (Boolean(change.before.is_system) === change.after.is_system) continue;
        const previous = ranges.at(-1);
        if (previous && previous.end + 1 === change.index && previous.hide === change.after.is_system) previous.end++;
        else ranges.push({ start: change.index, end: change.index, hide: change.after.is_system });
    }
    return ranges;
}
