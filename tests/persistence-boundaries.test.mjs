import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, createEmptyMemoryData, backfillExistingChatHistory, buildRoundMessageIndex,
    getRoundMessageWindow, computeHiddenMessageCutoff, collectPendingAiTurns } from '../memory-engine.js';
import { buildChatHistoryReplacement } from '../history-builder.js';
import { createPromptTextReader } from '../host-prompt.js';

const settings = { ...DEFAULT_SETTINGS, apiUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'mock',
    useJsonMode: false, summaryRetryCount: 0, mergeChunkSize: 20, enableRetrieval: false };
const pair = round => [{ is_user: true, mes: 'Player ' + round }, { is_user: false, mes: 'Reply ' + round }];
function mockSummary(t, prompts = []) {
    return t.mock.method(globalThis, 'fetch', async (_url, options) => {
        prompts.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            l0_summary: 'The guard received the key, scene ' + prompts.length + '.', keywords: ['key'], stateLedger: {},
        }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
}

for (const includeNativeHidden of [false, true]) {
    test('summary input obeys hidden-player opt-in: ' + includeNativeHidden, async t => {
        const prompts = []; mockSummary(t, prompts);
        const chat = [...pair(1), { is_user: true, is_system: true, mes: 'HIDDEN_PLAYER_FACT' },
            { is_user: false, mes: 'The guard answers.' }];
        const original = JSON.stringify(chat);
        const read = createPromptTextReader(chat, text => text, '', includeNativeHidden);
        assert.equal(read(2), includeNativeHidden ? 'HIDDEN_PLAYER_FACT' : '');
        await backfillExistingChatHistory({ ...settings, includeNativeHidden }, createEmptyMemoryData(), chat, 'U', 'A');
        assert.equal(prompts.some(prompt => prompt.messages.some(message => message.content.includes('HIDDEN_PLAYER_FACT'))), includeNativeHidden);
        assert.equal(JSON.stringify(chat), original);
    });
}

test('legacy plugin-hidden messages remain usable while native hidden messages are excluded', () => {
    const chat = [{ is_user: true, is_system: true, extra: { tiandao_hidden: true }, mes: 'LEGACY' },
        { is_user: false, is_system: true, mes: 'NATIVE' }];
    const read = createPromptTextReader(chat, text => text);
    assert.equal(read(0), 'LEGACY'); assert.equal(read(1), '');
});

test('consecutive player messages survive both summary input and the recent raw window', async t => {
    const prompts = []; mockSummary(t, prompts);
    const chat = [...pair(1), { is_user: true, mes: 'EARLIER_PLAYER_FACT' },
        { is_user: true, mes: 'LATER_PLAYER_FACT' }, { is_user: false, mes: 'Reply two.' }];
    const memory = createEmptyMemoryData();
    const original = JSON.stringify(chat);
    await backfillExistingChatHistory(settings, memory, chat, 'U', 'A');
    assert.ok(prompts[1].messages.some(message => message.content.includes('EARLIER_PLAYER_FACT')));
    assert.ok(prompts[1].messages.some(message => message.content.includes('LATER_PLAYER_FACT')));
    assert.equal(getRoundMessageWindow(chat, 4).startMessageId, 2);
    assert.deepEqual(buildRoundMessageIndex(chat).aiTurns[1].window, getRoundMessageWindow(chat, 4));
    assert.equal(computeHiddenMessageCutoff(chat, 1, 4), 2);
    const plan = buildChatHistoryReplacement(memory, chat, chat.map((message, index) => ({ ...message, index })),
        { ...settings, autoHideOldMessages: true, keepRecentRoundsCount: 1 });
    assert.match(plan.text, /EARLIER_PLAYER_FACT/); assert.match(plan.text, /LATER_PLAYER_FACT/);
    assert.equal(JSON.stringify(chat), original);
});

test('a hidden intervening floor does not detach the visible player from its reply', () => {
    const chat = [...pair(1), { is_user: true, mes: 'visible question' },
        { is_system: true, is_user: false, mes: 'hidden note' }, { is_user: false, mes: 'visible reply' }];
    const window = getRoundMessageWindow(chat, 4);
    assert.equal(window.userMessageIndex, 2); assert.equal(window.startMessageId, 2);
    assert.equal(computeHiddenMessageCutoff(chat, 1, 4), 2);
});

test('keeping the first round also keeps its card opening', () => {
    const chat = [{ is_user: false, mes: 'opening' }, ...pair(1)];
    assert.equal(computeHiddenMessageCutoff(chat, 1, 2), 0);
});

test('failed backfill batches roll back and retry generated results before making more API calls', async t => {
    const prompts = []; mockSummary(t, prompts);
    const chat = Array.from({ length: 6 }, (_, i) => pair(i + 1)).flat();
    const memory = createEmptyMemoryData(); let saves = 0;
    await assert.rejects(backfillExistingChatHistory(settings, memory, chat, 'U', 'A', {
        saveEvery: 2, onChunkSaved: async () => { if (++saves === 2) throw Error('disk full'); },
    }), /disk full/);
    assert.equal(memory.lastProcessedMessageId, 3); assert.equal(memory.archivePool.length, 2);
    assert.equal(collectPendingAiTurns(chat, memory.lastProcessedMessageId).length, 4);
    assert.equal(prompts.length, 4);
    await assert.rejects(backfillExistingChatHistory(settings, memory, chat, 'U', 'A', {
        saveEvery: 2, onChunkSaved: async () => { throw Error('still offline'); },
    }), /still offline/);
    assert.equal(prompts.length, 4); assert.equal(memory.archivePool.length, 2);
    let retrySaves = 0;
    await backfillExistingChatHistory(settings, memory, chat, 'U', 'A', {
        saveEvery: 2, onChunkSaved: async () => { retrySaves++; },
    });
    assert.equal(prompts.length, 6); assert.equal(retrySaves, 2);
    assert.equal(memory.archivePool.length, 6); assert.equal(memory.lastProcessedMessageId, 11);
});

test('editing backfill source invalidates its unsaved batch', async t => {
    const prompts = []; mockSummary(t, prompts);
    const chat = pair(1), memory = createEmptyMemoryData();
    await assert.rejects(backfillExistingChatHistory(settings, memory, chat, 'U', 'A', {
        onChunkSaved: async () => { throw Error('offline'); },
    }));
    chat[1].mes = 'A new final reply.';
    await backfillExistingChatHistory(settings, memory, chat, 'U', 'A', { onChunkSaved: async () => {} });
    assert.equal(prompts.length, 2); assert.equal(memory.archivePool.length, 1);
    assert.ok(prompts[1].messages.some(message => message.content.includes('A new final reply.')));
});

test('an explicit false backfill save result is treated as a failed save', async t => {
    mockSummary(t); const memory = createEmptyMemoryData();
    await assert.rejects(backfillExistingChatHistory(settings, memory, pair(1), 'U', 'A', {
        onChunkSaved: async () => false,
    }), /保存/);
    assert.equal(memory.lastProcessedMessageId, -1); assert.equal(memory.archivePool.length, 0);
});


test('a later model failure still saves the already generated backfill progress', async t => {
    let calls = 0, saves = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        if (++calls === 2) return new Response('denied', { status: 401 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ l0_summary: 'The first scene ended.', keywords: [], stateLedger: {} }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    const memory = createEmptyMemoryData();
    await assert.rejects(backfillExistingChatHistory(settings, memory, [...pair(1), ...pair(2)], 'U', 'A', {
        saveEvery: 5, onChunkSaved: async () => { saves++; },
    }));
    assert.equal(saves, 1); assert.equal(memory.archivePool.length, 1); assert.equal(memory.lastProcessedMessageId, 1);
});

test('a changed memory baseline invalidates a standalone backfill draft', async t => {
    const prompts = []; mockSummary(t, prompts); const memory = createEmptyMemoryData(), chat = pair(1);
    await assert.rejects(backfillExistingChatHistory(settings, memory, chat, 'U', 'A', { onChunkSaved: async () => { throw Error('offline'); } }));
    memory.stateLedger.time = 'manually revised';
    await backfillExistingChatHistory(settings, memory, chat, 'U', 'A', { onChunkSaved: async () => {} });
    assert.equal(prompts.length, 2); assert.equal(memory.archivePool.length, 1);
});

test('stopping backfill preserves completed work when its final save must be retried', async t => {
    const prompts = []; mockSummary(t, prompts);
    const memory = createEmptyMemoryData(), chat = [...pair(1), ...pair(2)];
    let stop = false;
    await assert.rejects(backfillExistingChatHistory(settings, memory, chat, 'U', 'A', {
        saveEvery: 5, shouldAbort: () => stop,
        onProgress: current => { if (current === 2) stop = true; },
        onChunkSaved: async () => { throw Error('offline'); },
    }), /offline/);
    assert.equal(prompts.length, 1); assert.equal(memory.archivePool.length, 0);
    await backfillExistingChatHistory(settings, memory, chat, 'U', 'A', { onChunkSaved: async () => {} });
    assert.equal(prompts.length, 2); assert.equal(memory.archivePool.length, 2);
});


test('editing an earlier saved round while scanning cannot be undone by a final batch rollback', async t => {
    const { rollbackMemoryFromMessageIndex } = await import('../memory-engine.js');
    const prompts = []; mockSummary(t, prompts);
    const memory = createEmptyMemoryData(), chat = Array.from({ length: 4 }, (_, i) => pair(i + 1)).flat();
    let saves = 0, stop = false;
    const result = await backfillExistingChatHistory(settings, memory, chat, 'U', 'A', {
        saveEvery: 2, shouldAbort: () => stop,
        onProgress: current => {
            if (current === 4) { chat[0].mes = 'edited first input'; rollbackMemoryFromMessageIndex(memory, 0); stop = true; }
        },
        onChunkSaved: async () => { if (++saves > 1) throw Error('offline'); },
    });
    assert.equal(result.aborted, true); assert.equal(memory.archivePool.length, 0);
    assert.equal(memory.lastProcessedMessageId, -1); assert.equal(saves, 1);
});

test('cached item identities never freeze mutable ledger contents or collapse distinct items', async () => {
    const { normalizeMemoryData, ledgerItemIdentity } = await import('../memory-engine.js');
    const memory = createEmptyMemoryData();
    memory.stateLedger.characters.Traveler = { inventory: ['铜钥匙'], removedItemsLock: ['外套（已脱下放于椅背）'] };
    normalizeMemoryData(memory);
    memory.stateLedger.characters.Traveler.inventory[0] = '银钥匙';
    memory.stateLedger.characters.Traveler.removedItemsLock[0] = '外套（已脱下放于床头）';
    normalizeMemoryData(memory);
    assert.deepEqual(memory.stateLedger.characters.Traveler.inventory, ['银钥匙']);
    assert.deepEqual(memory.stateLedger.characters.Traveler.removedItemsLock, ['外套（已脱下放于床头）']);
    for (let i = 0; i < 3000; i++) ledgerItemIdentity('物品编号' + i);
    assert.equal(ledgerItemIdentity('外套（已脱下放于椅背）'), ledgerItemIdentity('外套（已脱下放于床头）'));
    assert.notEqual(ledgerItemIdentity('钥匙（红色，编号1）'), ledgerItemIdentity('钥匙（蓝色，编号2）'));
});
