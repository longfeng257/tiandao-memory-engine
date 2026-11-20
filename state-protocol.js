// Machine state stays in the source reply for swipe/reload recovery, never in story input.
export function stripStateUpdateBlocks(value) {
    return String(value ?? '')
        .replace(/<details\b[^>]*\bdata-suwei-state\s*=\s*["']?1["']?[^>]*>[\s\S]*?<\/details\s*>/gi, '')
        .replace(/<suwei_state\b[^>]*>[\s\S]*?<\/suwei_state\s*>/gi, '')
        .replace(/<(?:suwei_state\b|details\b[^>]*\bdata-suwei-state\b)[\s\S]*$/i, '')
        .trim();
}

// Find complete JSON objects without treating braces inside strings as boundaries.
function jsonObjectEnd(text, start) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return i + 1;
    }
    return -1;
}

// Only use this fallback for a bound source reply that actually contained our protocol.
function stripFlattenedStateBlocks(text, source) {
    const original = text;
    // Exact source payloads also remove invalid or truncated JSON after tag-only regexes.
    for (const block of source.matchAll(/<suwei_state\b[^>]*>([\s\S]*?)(?:<\/suwei_state\s*>|$)/gi)) {
        const payload = block[1].trim();
        if (!payload) continue;
        const reservedJson = /^\{\s*"(?:version|baseRound|changes)"\s*:/.test(payload);
        let index, searchFrom = 0;
        while ((index = text.indexOf(payload, searchFrom)) >= 0) {
            const prefix = text.slice(0, index);
            if (!reservedJson && !/溯微状态\s*$/.test(prefix)) {
                searchFrom = index + payload.length;
                continue;
            }
            const before = prefix.replace(/溯微状态\s*$/, '');
            text = before + text.slice(index + payload.length);
            searchFrom = before.length;
        }
    }
    const candidates = /\{\s*"(?:version|baseRound|changes)"\s*:/g;
    let from = 0, result = '', match;
    while ((match = candidates.exec(text))) {
        const end = jsonObjectEnd(text, match.index);
        if (end < 0) continue;
        try { parseStateUpdateJson(text.slice(match.index, end)); }
        catch { continue; }
        result += text.slice(from, match.index).replace(/溯微状态\s*$/, '');
        from = end;
        candidates.lastIndex = end;
    }
    const cleaned = result + text.slice(from);
    return cleaned === original ? original : cleaned.trim();
}

// Clone only machine-bearing assistant messages; never replay or reprocess raw story text.
export function stripStateUpdateMessage(message, sourceMessage = message) {
    if (!message || message.is_user || typeof message.mes !== 'string') return message;
    const marker = /<(?:suwei_state\b|details\b[^>]*\bdata-suwei-state\b)/i;
    const hasMarker = marker.test(message.mes);
    if (!hasMarker && !marker.test(String(sourceMessage?.mes || ''))) return message;
    const mes = hasMarker ? stripStateUpdateBlocks(message.mes) : stripFlattenedStateBlocks(message.mes, String(sourceMessage?.mes || ''));
    return mes === message.mes ? message : { ...message, mes };
}

export function parseStateUpdateJson(value) {
    const text = String(value ?? '').trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '');
    if (text.length > 1_000_000) throw Error('状态数据过长，未应用');
    let data;
    try { data = JSON.parse(text); } catch { throw Error('状态数据不是有效 JSON，未应用'); }
    if (!data || Array.isArray(data) || data.version !== 1
        || !Number.isInteger(data.baseRound) || data.baseRound < 0
        || !data.changes || typeof data.changes !== 'object' || Array.isArray(data.changes)) {
        throw Error('状态数据缺少有效 version、baseRound 或 changes，未应用');
    }
    return data;
}

export function readMainResponseState(value) {
    const text = String(value ?? '');
    const matches = [...text.matchAll(/<suwei_state\b[^>]*>([\s\S]*?)<\/suwei_state\s*>/gi)];
    if (!matches.length) throw Error('主模型未返回完整状态区块；面板保留旧快照，不自动调用独立 API');
    // A continuation can append a fresh block; the last complete block covers the whole reply.
    const last = matches.at(-1);
    if (/<(?:suwei_state\b|details\b[^>]*\bdata-suwei-state\b)/i.test(text.slice(last.index + last[0].length))) throw Error('末尾状态区块不完整，未应用');
    return parseStateUpdateJson(last[1]);
}

export function buildStateUpdateInstruction(baseRound = 0, mainResponse = false) {
    const schema = JSON.stringify({ version: 1, baseRound, changes: {
        time: '仅明确变化时填写', characters: { '沿用账本人物名': {
            location: '仅变化时填写', statusAndAction: '只写可观察的事实', wear: '仅变化时填写',
            inventoryAdd: ['新增物品，或同一物品的最新描述'], inventoryRemove: ['明确消耗、丢弃或转交的物品名'],
            removedItemsLockAdd: ['本段脱下的衣物及最新去向'], removedItemsLockRemove: ['明确重戴或转交的物品名'],
        } }, todosAdd: ['需要跨轮跟进的约定'], todosComplete: ['已完成约定的原文或 id'],
    } });
    const rules = [
        '状态更新协议：仅记录已经发生的事实，比较提供的状态快照与本段剧情结束状态。',
        '只返回变化字段；未提及的旧人物、道具和约定全部保留。物品不限条数；同一实物只更新一条，不合并不同编号、颜色或确为不同的实物。',
        '发言署名不代表剧情身份；只追踪剧情中真实出场且有具体状态的实体，不创建旁白、系统或占位人物。',
        'characters 使用既有人物键名；新出场具体人物可新增。可用标量字段：location、statusAndAction、wear、viewTarget、viewTargetVisible、present；aliases 可用字符串数组。',
        '物品增删使用 inventoryAdd、inventoryRemove、removedItemsLockAdd、removedItemsLockRemove；转交时分别更新双方。重新穿戴时移除卸下记录并更新 wear，不能凭旧锁否认之后的重戴。',
        '私下所见只写对应角色的 viewTarget，禁止写入其他角色；不推测心理，不写氛围、升华、尚未回应或等待玩家。',
        'todosAdd 只含值得跨轮跟进的明确约定；todosComplete 沿用已有事项原文或 id。没有变化时 changes 返回 {}。',
        'baseRound 必须为 ' + baseRound + '，示例结构中的说明文字不是剧情事实，不得照抄：' + schema,
    ];
    if (mainResponse) rules.push(
        '照常生成剧情正文，最后追加恰好一份以下机器区块；不要在正文解释此协议，不要写代码围栏：',
        '<details hidden data-suwei-state="1"><summary>溯微状态</summary><suwei_state>{"version":1,"baseRound":' + baseRound + ',"changes":{}}</suwei_state></details>',
        '重生成只依据当前分支。续写时，最终区块必须涵盖末条回复原有正文与本次续写的全部变化，仍与上述基准快照比较。',
    );
    else rules.push('仅返回一份合法 JSON 对象，不输出正文、Markdown 或额外说明。');
    return rules.join('\n');
}
