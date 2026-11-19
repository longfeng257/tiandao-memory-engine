import { buildInjectedMemoryPrompt, buildRoundMessageIndex, computeHiddenMessageCutoff, estimatePromptTokens, numOr, parseRoundRange, resolveStateLedgerAfterEntry } from "./memory-engine.js";

// Bind the host's preprocessed copies to source positions, never to filtered array offsets.
export function bindCoreHistory(coreChat, fullChat) {
    const visible = fullChat.map((message, index) => ({ message, index }))
        .filter(({ message }) => message && (!message.is_system || Array.isArray(message.extra?.tool_invocations)));
    const identities = new Map(fullChat.map((message, index) => [message, index]));
    let previous = -1;
    return coreChat.filter(message => !message?.extra?.suwei_history).map(message => {
        let sourceIndex = identities.get(message);
        if (sourceIndex === undefined && Number.isInteger(message.index)) sourceIndex = visible[message.index]?.index;
        if (sourceIndex === undefined) {
            const match = visible.find(item => item.index > previous && item.message.is_user === message.is_user && item.message.mes === message.mes);
            sourceIndex = match?.index;
        }
        if (sourceIndex !== undefined) previous = sourceIndex;
        return { message, sourceIndex, order: previous };
    });
}

function selectHistoricalEntries(memory, beforeRound, forcedDetails) {
    const overlapsDetail = item => forcedDetails.some(detail => {
        const a = parseRoundRange(item.roundRange), b = parseRoundRange(detail.roundRange);
        return a.start <= b.end && b.start <= a.end;
    });
    const candidates = [...(memory.archivePool || [])];
    for (let level = 1; level <= 3; level++) {
        candidates.push(...(memory.levels?.[level] || []).filter(item => !overlapsDetail(item)));
    }
    if (memory.farHistory?.text) {
        const item = { id: 'suwei-far-history', level: -1, roundRange: '1-' + memory.farHistory.latestRound, text: memory.farHistory.text };
        if (!overlapsDetail(item)) candidates.push(item);
    }
    candidates.sort((a, b) => {
        const left = parseRoundRange(a.roundRange), right = parseRoundRange(b.roundRange);
        return left.start - right.start || right.end - left.end || numOr(b.level, 0) - numOr(a.level, 0);
    });
    let covered = 0;
    const selected = [];
    for (const item of candidates) {
        const range = parseRoundRange(item.roundRange);
        if (range.end > beforeRound || range.start <= covered) continue;
        selected.push(item);
        covered = range.end;
    }
    return selected;
}

function narrator(text, kind, sourceRound) {
    return { name: '溯微记忆', is_user: false, is_system: false, mes: text,
        extra: { type: 'narrator', suwei_history: true, suwei_kind: kind, suwei_source_round: sourceRound } };
}

export function formatHistoryPreview(messages) {
    return messages.map(message => {
        const role = message.extra?.type === 'narrator' ? '剧情记忆 / system' : (message.is_user ? '玩家 / user' : '角色 / assistant');
        return '【' + role + (message.name ? ' · ' + message.name : '') + '】\n' + String(message.mes || '');
    }).join('\n\n');
}

// Replace only the host's ephemeral chat-history array. Source chats, cards and presets remain native.
export function buildChatHistoryReplacement(memory, fullChat, coreChat, settings, retrieved = [], primaryName = '', options = {}) {
    const bound = options.bound || bindCoreHistory(coreChat, fullChat);
    const sourceEnd = bound.reduce((max, item) => Number.isInteger(item.sourceIndex) ? Math.max(max, item.sourceIndex) : max, -1);
    const generationEnd = sourceEnd >= 0 ? sourceEnd : fullChat.length - 1;
    const roundIndex = options.roundIndex || buildRoundMessageIndex(fullChat, settings.includeNativeHidden);
    const turns = roundIndex.aiTurns.filter(turn => turn.idx <= generationEnd);
    const archive = (memory.archivePool || []).filter(item => Number.isInteger(item.endMessageId) && item.endMessageId <= generationEnd);
    let rawStart = settings.autoHideOldMessages
        ? computeHiddenMessageCutoff(fullChat.slice(0, generationEnd + 1), Math.max(1, numOr(settings.keepRecentRoundsCount, 5)), memory.lastProcessedMessageId, settings.includeNativeHidden)
        : 0;
    // Never drop an unarchived gap, nor split a multi-round summary across the raw boundary.
    const orderedArchive = archive.slice().sort((a, b) => a.startMessageId - b.startMessageId);
    let archiveIndex = 0;
    for (const turn of turns) {
        if (turn.idx >= rawStart) break;
        while (archiveIndex < orderedArchive.length && orderedArchive[archiveIndex].endMessageId < turn.idx) archiveIndex++;
        const entry = orderedArchive[archiveIndex];
        if (!entry || entry.startMessageId > turn.window.startMessageId || entry.endMessageId < turn.idx) {
            rawStart = Math.min(rawStart, turn.window.startMessageId); break;
        }
    }
    for (const entry of orderedArchive) {
        if (entry.startMessageId < rawStart && entry.endMessageId >= rawStart) rawStart = Math.max(0, entry.startMessageId);
    }
    // Other extensions' synthetic messages have no source position and must be retained.
    const raw = bound.filter(item => !Number.isInteger(item.sourceIndex) || item.sourceIndex >= rawStart);
    const pastRound = turns.filter(turn => turn.idx < rawStart).at(-1)?.round || 0;
    const detailById = new Map();
    for (const item of [...(memory.archivePool || []).filter(item => item.pinned), ...retrieved]) {
        if (!Number.isInteger(item.endMessageId) || item.endMessageId > generationEnd) continue;
        detailById.set(item.id || item.roundRange, item);
    }
    const details = [...detailById.values()];
    const pastDetails = details.filter(item => parseRoundRange(item.roundRange).end <= pastRound);
    const selected = selectHistoricalEntries(memory, pastRound, pastDetails);
    const events = raw.map((item, sequence) => ({ position: Number.isInteger(item.sourceIndex) ? item.sourceIndex : item.order + 0.01, sequence, message: item.message }));
    if (selected.length) {
        const levels = { 0: [], 1: [], 2: [], 3: [] };
        for (const item of selected) levels[Math.max(0, numOr(item.level, 0))].push(item);
        const view = { ...memory, levels, archivePool: selected.filter(item => item.pinned), farHistory: {} };
        const text = buildInjectedMemoryPrompt(view, [], primaryName, { omitLedger: true });
        events.push({ position: -1, sequence: -1, message: narrator(text, 'history', pastRound) });
    }
    const preservesAssistantTail = ["continue", "impersonate"].includes(options.generationType);
    const rawEndIndexes = new Set(raw.map(item => item.sourceIndex));
    for (const item of details) {
        if (item.endMessageId < rawStart || !rawEndIndexes.has(item.endMessageId)
            || (preservesAssistantTail && item.endMessageId === generationEnd)) continue;
        const text = buildInjectedMemoryPrompt({ levels: { 0: [item] }, archivePool: [], farHistory: {} }, [], primaryName, { omitLedger: true });
        events.push({ position: item.endMessageId + 0.25, sequence: events.length, message: narrator(text, 'detail', item.roundRange) });
    }
    let ledger = memory.stateLedger;
    let ledgerEnd = memory.lastProcessedMessageId;
    let ledgerRound = memory.lastProcessedRound;
    if (ledgerEnd > generationEnd || (preservesAssistantTail && ledgerEnd === generationEnd)) {
        const surviving = archive.filter(item => !preservesAssistantTail || item.endMessageId < generationEnd).sort((a, b) => a.endMessageId - b.endMessageId).at(-1);
        ledger = surviving ? resolveStateLedgerAfterEntry(memory, surviving) : null;
        ledgerEnd = surviving?.endMessageId ?? -1;
        ledgerRound = surviving ? parseRoundRange(surviving.roundRange).end : 0;
    }
    const hasLedger = ledger && (Object.keys(ledger.characters || {}).length || ledger.todosAndPromises?.some(item => !item.completed) || (ledger.time && !/^未知/.test(ledger.time)));
    if (hasLedger) {
        const text = buildInjectedMemoryPrompt({ stateLedger: ledger }, [], primaryName, { ledgerOnly: true });
        // A snapshot is inserted after its source round and before newer raw dialogue.
        const position = ledgerEnd >= 0 ? ledgerEnd + 0.5 : -0.5;
        events.push({ position, sequence: events.length, message: narrator(text, 'ledger', ledgerRound) });
    }
    events.sort((a, b) => a.position - b.position || a.sequence - b.sequence);
    const messages = events.map(event => event.message);
    const text = formatHistoryPreview(messages);
    return { messages, text, tokens: estimatePromptTokens(text), rawStart, rawMessages: raw.length,
        memoryMessages: messages.filter(message => message.extra?.suwei_history).length,
        retrieval: details.filter(item => retrieved.includes(item)).map(item => ({ id: item.id, roundRange: item.roundRange,
            reason: options.retrievalDetails?.find(detail => detail.id === item.id)?.reason || '话题相关', retainedRaw: item.endMessageId >= rawStart })) };
}
