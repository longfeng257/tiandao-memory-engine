import { buildStateUpdateInstruction, stripStateUpdateMessage } from "./state-protocol.js";
import { sanitizeSummaryFlourish, buildInjectedMemoryPrompt, buildRoundMessageIndex, computeHiddenMessageCutoff, estimatePromptTokens, numOr, parseRoundRange, getL0CoverageRanges, isRoundRangeCovered, resolveStateLedgerAfterEntry, getStateLedgerAtMessage, resolveStateUpdateMode } from "./memory-engine.js";

const historyFactsCache = new WeakMap();
function hasHistoricalFacts(item) {
    const text = String(item.text || '');
    const cached = historyFactsCache.get(item);
    if (cached?.text === text) return cached.hasFacts;
    const hasFacts = Boolean(sanitizeSummaryFlourish(text, Infinity));
    historyFactsCache.set(item, { text, hasFacts });
    return hasFacts;
}

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

function selectHistoricalEntries(memory, eligibleTurns, archive) {
    const limit = eligibleTurns.length;
    const coverage = getL0CoverageRanges(archive.filter(hasHistoricalFacts), { aiTurns: eligibleTurns });
    const candidates = archive.map(item => ({ item, rank: 0 }));
    for (let rank = 1; rank <= 3; rank++) {
        for (const item of memory.levels?.[rank] || []) candidates.push({ item, rank });
    }
    const far = memory.farHistory;
    if (far?.text && far.latestRound >= (far.earliestRound || 1)) candidates.push({
        item: { roundRange: `${far.earliestRound || 1}-${far.latestRound}`, text: far.text }, rank: 4,
    });
    const byStart = new Map();
    for (const { item, rank } of candidates) {
        const { start, end } = parseRoundRange(item.roundRange);
        if (start < 1 || end > limit || !hasHistoricalFacts(item)) continue;
        if (rank > 0 && !isRoundRangeCovered({ start, end }, coverage)) continue;
        if (rank === 0 && (item.endMessageId !== eligibleTurns[end - 1]?.idx
            || item.startMessageId !== eligibleTurns[start - 1]?.window.startMessageId
            || !Number.isInteger(item.startMessageId))) continue;
        if (!byStart.has(start)) byStart.set(start, []);
        byStart.get(start).push({ item, rank, end });
    }
    // Tile a contiguous prefix, minimizing L0 coverage before preferring higher tiers.
    const paths = [{ cost: [0, 0, 0, 0, 0, 0] }];
    const isBetter = (left, right) => {
        const difference = left.findIndex((value, i) => value !== right[i]);
        return difference >= 0 && left[difference] < right[difference];
    };
    for (let start = 1; start <= limit; start++) {
        const previous = paths[start - 1];
        if (!previous) continue;
        for (const candidate of byStart.get(start) || []) {
            const { rank, end } = candidate;
            const cost = previous.cost.slice();
            if (!rank) cost[0] += end - start + 1;
            else cost[5 - rank] -= end - start + 1;
            cost[5]++;
            if (!paths[end] || isBetter(cost, paths[end].cost)) paths[end] = { cost, previous, candidate };
        }
    }
    const covered = paths.length - 1;
    const selected = [];
    for (let path = paths[covered]; path?.candidate; path = path.previous) selected.push(path.candidate);
    return { selected: selected.reverse(), covered };
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
        ? computeHiddenMessageCutoff(fullChat.slice(0, generationEnd + 1), Math.max(1, numOr(settings.keepRecentRoundsCount, 5)), memory.lastProcessedMessageId, settings.includeNativeHidden, { aiTurns: turns })
        : 0;
    const eligibleTurns = turns.filter(turn => turn.idx < rawStart);
    const { selected, covered: pastRound } = selectHistoricalEntries(memory, eligibleTurns, archive);
    if (pastRound < eligibleTurns.length) rawStart = eligibleTurns[pastRound].window.startMessageId;
    // Other extensions' synthetic messages have no source position and must be retained.
    const raw = bound.filter(item => !Number.isInteger(item.sourceIndex) || item.sourceIndex >= rawStart)
        .map(item => {
            const message = stripStateUpdateMessage(item.message, fullChat[item.sourceIndex]);
            return message === item.message ? item : { ...item, message };
        });
    const detailById = new Map();
    for (const item of [...(memory.archivePool || []).filter(item => item.pinned), ...retrieved]) {
        if (!Number.isInteger(item.endMessageId) || item.endMessageId > generationEnd) continue;
        detailById.set(item.id || item.roundRange, item);
    }
    const details = [...detailById.values()];
    const pastDetails = details.filter(item => parseRoundRange(item.roundRange).end <= pastRound);
    const events = raw.map((item, sequence) => ({ position: Number.isInteger(item.sourceIndex) ? item.sourceIndex : item.order + 0.01, sequence, message: item.message }));
    if (selected.length) {
        const levels = { 0: [], 1: [], 2: [], 3: [] };
        let farHistory;
        for (const { item, rank } of selected) {
            if (rank === 4) farHistory = memory.farHistory;
            else levels[rank].push(item);
        }
        const text = buildInjectedMemoryPrompt({ levels, farHistory }, pastDetails, primaryName, { omitLedger: true });
        events.push({ position: -1, sequence: -1, message: narrator(text, 'history', pastRound) });
    }
    const preservesAssistantTail = ["continue", "impersonate"].includes(options.generationType);
    const rawEndIndexes = new Set(raw.map(item => item.sourceIndex));
    for (const item of details.filter(item => item.pinned)) {
        if (item.endMessageId < rawStart || !rawEndIndexes.has(item.endMessageId)
            || (preservesAssistantTail && item.endMessageId === generationEnd)) continue;
        const text = buildInjectedMemoryPrompt({ levels: { 0: [item] }, archivePool: [], farHistory: {} }, [], primaryName, { omitLedger: true });
        events.push({ position: item.endMessageId + 0.25, sequence: events.length, message: narrator(text, 'detail', item.roundRange) });
    }
    const ledgerSource = getStateLedgerAtMessage(memory, generationEnd - (preservesAssistantTail ? 1 : 0));
    const ledger = ledgerSource.ledger;
    const ledgerEnd = ledgerSource.endMessageId;
    const ledgerRound = ledgerSource.round;
    const hasLedger = ledger && (Object.keys(ledger.characters || {}).length || ledger.todosAndPromises?.some(item => !item.completed) || (ledger.time && !/^未知/.test(ledger.time)));
    if (hasLedger) {
        const text = buildInjectedMemoryPrompt({ stateLedger: ledger }, [], primaryName, { ledgerOnly: true, snapshotRound: ledgerRound });
        // A snapshot is inserted after its source round and before newer raw dialogue.
        const position = ledgerEnd >= 0 ? ledgerEnd + 0.5 : -0.5;
        events.push({ position, sequence: events.length, message: narrator(text, 'ledger', ledgerRound) });
    }
    if (resolveStateUpdateMode(settings) === "main_response" && !["quiet", "impersonate"].includes(options.generationType)) {
        const protocol = narrator(buildStateUpdateInstruction(ledgerRound, true), 'state_protocol', ledgerRound);
        events.push({ position: generationEnd + (preservesAssistantTail ? -0.1 : 1), sequence: events.length, message: protocol });
    }
    events.sort((a, b) => a.position - b.position || a.sequence - b.sequence);
    const messages = events.map(event => event.message);
    const text = formatHistoryPreview(messages);
    return { messages, text, tokens: estimatePromptTokens(text), rawStart, rawMessages: raw.length,
        memoryMessages: messages.filter(message => message.extra?.suwei_history).length,
        retrieval: details.filter(item => retrieved.includes(item) && parseRoundRange(item.roundRange).end <= pastRound).map(item => ({ id: item.id, roundRange: item.roundRange,
            reason: options.retrievalDetails?.find(detail => detail.id === item.id)?.reason || '话题相关', retainedRaw: item.endMessageId >= rawStart })) };
}
