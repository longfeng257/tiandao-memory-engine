const STATUS = Object.freeze({
    confirmed: "confirmed",
    failed: "failed",
    unknown: "unknown",
});

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function sameValue(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function resolveChatTarget(ctx) {
    let chatId = ctx?.chatId;
    try {
        if (typeof ctx?.getCurrentChatId === "function") chatId = ctx.getCurrentChatId();
    } catch (_) {
        return null;
    }
    if (!chatId) return null;
    if (ctx?.groupId) return { endpoint: "/api/chats/group/get", body: { id: String(chatId) } };
    const avatar = ctx?.characters?.[ctx.characterId]?.avatar;
    if (!avatar) return null;
    return {
        endpoint: "/api/chats/get",
        body: { avatar_url: String(avatar), file_name: String(chatId) },
    };
}

function resolveVerifier(ctx, fetchImpl) {
    const target = resolveChatTarget(ctx);
    let headers = null;
    try {
        if (typeof ctx?.getRequestHeaders === "function") headers = ctx.getRequestHeaders();
    } catch (_) {
        return null;
    }
    return target && headers && typeof fetchImpl === "function" ? { target, headers } : null;
}

function identityIsCurrent(isCurrent) {
    try {
        return typeof isCurrent !== "function" || Boolean(isCurrent());
    } catch (_) {
        return false;
    }
}

function switchedChatResult() {
    return { status: STATUS.unknown, reason: "聊天已切换，无法确认原聊天的保存结果" };
}

export async function readPersistedFields(ctx, expectedFields, fetchImpl = globalThis.fetch, verifierOverride = null, isCurrent = null) {
    if (!identityIsCurrent(isCurrent)) return switchedChatResult();
    const verifier = verifierOverride || resolveVerifier(ctx, fetchImpl);
    if (!verifier) {
        return { status: STATUS.unknown, reason: "宿主没有提供可验证的聊天读取信息" };
    }

    let response;
    let records;
    try {
        response = await fetchImpl(verifier.target.endpoint, {
            method: "POST",
            headers: verifier.headers,
            body: JSON.stringify(verifier.target.body),
        });
        if (!identityIsCurrent(isCurrent)) return switchedChatResult();
        if (!response?.ok) return { status: STATUS.unknown, reason: `聊天回读 HTTP ${response?.status || "错误"}` };
        records = await response.json();
    } catch (error) {
        if (!identityIsCurrent(isCurrent)) return switchedChatResult();
        return { status: STATUS.unknown, reason: String(error?.message || error) };
    }
    if (!identityIsCurrent(isCurrent)) return switchedChatResult();

    const metadata = Array.isArray(records) ? records[0]?.chat_metadata : null;
    if (!metadata || typeof metadata !== "object") {
        return { status: STATUS.unknown, reason: "聊天回读未返回有效元数据" };
    }
    for (const [key, expected] of Object.entries(expectedFields || {})) {
        const expectedPresent = expected !== undefined;
        const actualPresent = Object.prototype.hasOwnProperty.call(metadata, key);
        if (expectedPresent !== actualPresent
            || (expectedPresent && !sameValue(metadata[key], expected))) {
            return { status: STATUS.failed, reason: `存档中的 ${key} 与待保存内容不一致` };
        }
    }
    return { status: STATUS.confirmed };
}

export async function saveAndVerifyChatMetadata(ctx, expectedFields, savers, fetchImpl = globalThis.fetch, isCurrent = null) {
    if (!identityIsCurrent(isCurrent)) return switchedChatResult();
    const callbacks = Array.isArray(savers) ? savers : [];
    if (callbacks.length === 0) {
        return { status: STATUS.failed, reason: "当前酒馆版本没有可用的聊天元数据保存接口" };
    }
    const verifier = resolveVerifier(ctx, fetchImpl);
    let saveResult;
    try {
        if (!identityIsCurrent(isCurrent)) return switchedChatResult();
        // Native savers may wait before consulting global chat state; they cannot bind or abort a target.
        saveResult = await callbacks[0]();
    } catch (error) {
        if (!identityIsCurrent(isCurrent)) return switchedChatResult();
        return { status: STATUS.failed, reason: String(error?.message || error) };
    }
    if (!identityIsCurrent(isCurrent)) return switchedChatResult();
    if (saveResult === false || saveResult?.ok === false) {
        return { status: STATUS.failed, reason: "聊天元数据保存接口返回失败" };
    }
    if (!verifier) {
        return { status: STATUS.unknown, reason: "宿主保存接口未返回可核对的聊天存档" };
    }

    return readPersistedFields(ctx, expectedFields, fetchImpl, verifier, isCurrent);
}

export { STATUS as CHAT_PERSISTENCE_STATUS };
