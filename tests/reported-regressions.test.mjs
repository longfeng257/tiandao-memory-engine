import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStateLedger, normalizeMemoryData, createEmptyMemoryData, normalizeCharacterItems,
    sanitizeSummaryFlourish, buildInjectedMemoryPrompt, resolveStateLedgerAfterEntry, summarizeSingleTurn, backfillExistingChatHistory, DEFAULT_SETTINGS } from '../memory-engine.js';

const SETTINGS = { ...DEFAULT_SETTINGS, apiUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'test-model', mergeChunkSize: 20, useEmbeddingApi: false };
const oldCoat = '黑色毛呢外袍（已脱下搭于门边衣架，当前未穿戴）';
const latestCoat = '黑色毛呢外袍（已脱下，先搭于门边衣架，现由阿斯塔取下捧在手中，维安诺当前未穿戴）';

test('removed clothing updates one physical item instead of accumulating descriptions', () => {
    const previous = { characters: { 维安诺: { removedItemsLock: [oldCoat], inventory: ['铜钥匙', oldCoat] } } };
    const merged = mergeStateLedger(previous, { characters: { 维安诺: {
        removedItemsLock: [oldCoat, latestCoat], inventory: ['铜钥匙', latestCoat],
    } } }, 20);
    assert.deepEqual(merged.characters.维安诺.removedItemsLock, [latestCoat]);
    assert.deepEqual(merged.characters.维安诺.inventory, ['铜钥匙']);
    const unlocked = mergeStateLedger(merged, { characters: { 维安诺: { unlockedItems: ['黑色毛呢外袍'] } } }, 21);
    assert.deepEqual(unlocked.characters.维安诺.removedItemsLock, []);
});

test('legacy duplicate items normalize immediately and idempotently', () => {
    const memory = createEmptyMemoryData();
    memory.stateLedger.characters = { 维安诺: { removedItemsLock: [oldCoat, latestCoat], inventory: ['铜钥匙', '铜钥匙', latestCoat] } };
    normalizeMemoryData(memory);
    assert.deepEqual(memory.stateLedger.characters.维安诺.removedItemsLock, [latestCoat]);
    assert.deepEqual(memory.stateLedger.characters.维安诺.inventory, ['铜钥匙']);
    const once = JSON.stringify(memory);
    normalizeMemoryData(memory); assert.equal(JSON.stringify(memory), once);
});

test('item identity preserves distinguishing descriptions and separate coloured items', () => {
    const items = normalizeCharacterItems({ inventory: ['戒指（红宝石）', '戒指（蓝宝石）', '黑色外套', '白色外套', '第二件黑色外套'] });
    assert.equal(items.inventory.length, 5);
    assert.equal(normalizeCharacterItems({ inventory: ['戒指（未鉴定的红宝石）', '戒指（未鉴定的蓝宝石）'] }).inventory.length, 2);
    assert.equal(normalizeCharacterItems({ removedItemsLock: ['外套（黑色，已脱下）', '外套（白色，已脱下）'] }).removedItemsLock.length, 2);
});

test('reported unanswered-player and atmosphere endings are stripped without losing actions', () => {
    assert.equal(sanitizeSummaryFlourish('阿斯塔解开外袍第一颗纽扣，维安诺（user）尚未回应。密会在火光中推向更深一层。'), '阿斯塔解开外袍第一颗纽扣。');
    assert.equal(sanitizeSummaryFlourish('守卫询问明日何时出发；旅人仍未答复。张力升腾。'), '守卫询问明日何时出发。');
    assert.equal(sanitizeSummaryFlourish('旅人将钥匙交给守卫。故事停在门前，等待玩家回应。'), '旅人将钥匙交给守卫。');
    assert.equal(sanitizeSummaryFlourish('XX（user）尚未回应。密会在火光中推向更深一层。张力升腾。'), '');
    assert.equal(sanitizeSummaryFlourish('守卫说：“你为何没有回应？”旅人答应明日出发。'), '守卫说：“你为何没有回应？”旅人答应明日出发。');
});

test('legacy summary cleanup occurs on injection without mutating saved archives', () => {
    const item = { id: 'test', roundRange: '1', text: '阿斯塔解开外袍第一颗纽扣，维安诺（user）尚未回应。密会在火光中推向更深一层。' };
    const memory = { levels: { 0: [item] }, archivePool: [] };
    const before = JSON.stringify(memory);
    const prompt = buildInjectedMemoryPrompt(memory, [], '', { omitLedger: true });
    assert.match(prompt, /阿斯塔解开外袍第一颗纽扣/);
    assert.doesNotMatch(prompt, /尚未回应|火光|更深一层/);
    assert.equal(JSON.stringify(memory), before);
});

function response(text = '守卫接过铜钥匙。') {
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ l0_summary: text, keywords: [], stateLedger: {} }) } }] }), { headers: { 'Content-Type': 'application/json' } });
}
test('all-fluff model output is rejected and never restored as a summary', async t => {
    const memory = createEmptyMemoryData();
    const before = JSON.stringify(memory);
    const fetch = t.mock.method(globalThis, 'fetch', async () => response('XX（user）尚未回应。张力升腾。'));
    await assert.rejects(summarizeSingleTurn({ ...SETTINGS, summaryRetryCount: 0 }, memory, {
        roundNumber: 1, startMessageId: 0, endMessageId: 1, dialogueText: '守卫接过钥匙。', shouldCommit: () => true,
    }), /无效收尾/);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(JSON.stringify(memory), before);
});

test('backfill strips prompt-only content from opening, player and reply before API', async t => {
    const chat = [
        { is_user: false, mes: '开场剧情<options>开场禁发</options>' },
        { is_user: true, mes: '玩家剧情<options>玩家禁发</options>' },
        { is_user: false, mes: '回复剧情<options>回复禁发</options>' },
    ];
    const before = JSON.stringify(chat), prompts = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => { prompts.push(JSON.parse(options.body)); return response(); });
    await backfillExistingChatHistory(SETTINGS, createEmptyMemoryData(), chat, '旅人', '守卫', {
        shouldCommitTurn: () => true,
        processPromptText: text => text.replace(/<options>[\s\S]*?<\/options>/g, ''),
    });
    assert.equal(prompts.length, 1);
    const user = prompts[0].messages.find(item => item.role === 'user').content;
    for (const text of ['开场剧情', '玩家剧情', '回复剧情']) assert.ok(user.includes(text));
    assert.doesNotMatch(user, /禁发|<options>/);
    assert.equal(JSON.stringify(chat), before);
});

test('phase and far-history summarizers share facts-only rules and strip the same endings', async t => {
    const { checkAndCascadeMerge, SUMMARY_FACTS_ONLY_RULE } = await import('../memory-engine.js');
    const memory = createEmptyMemoryData(), prompts = [];
    memory.levels[0] = Array.from({ length: 8 }, (_, index) => ({ id: 's'+index, level: 0, roundRange: String(index+1), text: '守卫接过铜钥匙。' }));
    memory.pendingFarHistory = [{ level: 3, roundRange: '1-2', text: '守卫接过铜钥匙。' }];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(options.body); prompts.push(body.messages[0].content);
        return new Response(JSON.stringify({ choices: [{ message: { content: '守卫接过铜钥匙。旅人尚未回应。张力升腾。' } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    await checkAndCascadeMerge({ ...SETTINGS, mergeChunkSize: 2 }, memory);
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every(prompt => prompt.includes(SUMMARY_FACTS_ONLY_RULE)));
    assert.equal(memory.levels[1][0].text, '守卫接过铜钥匙。');
    assert.equal(memory.farHistory.text, '守卫接过铜钥匙。');
});

test('summary cleanup preserves quoted evidence, dialogue and numeric punctuation', () => {
    const evidence = '甲读到纸条“张力升腾”，随后把纸条交给乙。';
    const dialogue = '甲说：“不要让气氛继续升温。马上离开。”乙锁上门。';
    assert.equal(sanitizeSummaryFlourish(evidence), evidence);
    assert.equal(sanitizeSummaryFlourish(dialogue), dialogue);
    assert.equal(sanitizeSummaryFlourish('甲交付1,200枚金币，乙尚未回应。'), '甲交付1,200枚金币。');
    assert.equal(sanitizeSummaryFlourish('甲报价1,200，乙支付500；丙尚未回应。'), '甲报价1,200，乙支付500。');
    assert.equal(sanitizeSummaryFlourish('甲说：“交付1,200枚金币，明日来取。”气氛逐渐升温。'), '甲说：“交付1,200枚金币，明日来取。”');
    assert.equal(sanitizeSummaryFlourish('“XX（user）尚未回应。”“张力升腾。”'), '');
});

test('large item lists retain every distinct object while updating duplicates', () => {
    const inventory = Array.from({ length: 250 }, (_, i) => '道具编号' + i);
    const locks = Array.from({ length: 180 }, (_, i) => '外套编号' + i + '（已脱下）');
    const updated = '外套编号0（已脱下放于桌上）';
    const info = normalizeCharacterItems({
        inventory: [...inventory, ...inventory, updated],
        removedItemsLock: [...locks, updated],
    });
    assert.deepEqual(info.inventory, inventory);
    assert.equal(info.removedItemsLock.length, 180);
    assert.equal(info.removedItemsLock.at(-1), updated);
    const merged = mergeStateLedger({ characters: { 甲: { inventory, removedItemsLock: locks } } }, {
        characters: { 甲: { inventory: [...inventory, inventory[0]], removedItemsLock: [updated] } },
    }, 11);
    assert.deepEqual(merged.characters.甲.inventory, inventory);
    assert.equal(merged.characters.甲.removedItemsLock.length, 180);
    assert.ok(merged.characters.甲.removedItemsLock.includes(updated));
    const prompt = buildInjectedMemoryPrompt({ stateLedger: merged }, [], '', { ledgerOnly: true });
    for (const item of [...inventory, ...locks.slice(1), updated]) assert.ok(prompt.includes(item), item);
});

test('large item lists survive JSON reloads and all state delta replacement shapes', () => {
    const inventory = Array.from({ length: 250 }, (_, i) => '道具编号' + i);
    const locks = Array.from({ length: 180 }, (_, i) => '饰品编号' + i + '（已摘下）');
    const expectedLocks = [...locks.slice(1), locks[0]];
    const character = { inventory: [...inventory, inventory[0]], removedItemsLock: [...locks, locks[0]] };
    const state = { time: '清晨', characters: { 甲: character }, todosAndPromises: [] };
    const value = v => ({ t: 'v', v });
    const object = v => ({ t: 'o', v });
    const patches = [
        value(state),
        object({ characters: value(state.characters) }),
        object({ characters: object({ 甲: value(character) }) }),
        object({ characters: object({ 甲: object({ inventory: value(character.inventory), removedItemsLock: value(character.removedItemsLock) }) }) }),
    ];
    for (const postStateDelta of patches) {
        const memory = createEmptyMemoryData();
        memory.stateLedger = structuredClone(state);
        const first = { id: 'first', level: 0, roundRange: '1', startMessageId: 0, endMessageId: 1, text: '第一轮', postStateSnapshot: state };
        const second = { id: 'second', level: 0, roundRange: '2', startMessageId: 2, endMessageId: 3, text: '第二轮', postStateDelta };
        memory.archivePool = [first, second]; memory.levels[0] = [first, second];
        const reloaded = JSON.parse(JSON.stringify(memory));
        normalizeMemoryData(reloaded);
        assert.deepEqual(reloaded.stateLedger.characters.甲.inventory, inventory);
        assert.deepEqual(reloaded.stateLedger.characters.甲.removedItemsLock, expectedLocks);
        const restored = resolveStateLedgerAfterEntry(reloaded, reloaded.archivePool.find(item => item.id === 'second'));
        assert.deepEqual(restored.characters.甲.inventory, inventory);
        assert.deepEqual(restored.characters.甲.removedItemsLock, expectedLocks);
        const snapshot = resolveStateLedgerAfterEntry(reloaded, reloaded.archivePool.find(item => item.id === 'first'));
        assert.deepEqual(snapshot.characters.甲.inventory, inventory);
        normalizeMemoryData(reloaded);
        assert.deepEqual(resolveStateLedgerAfterEntry(reloaded, reloaded.archivePool.at(-1)).characters.甲.inventory, inventory);
    }
});

test('summary generation preserves large inventories without asking the model to cap them', async t => {
    const inventory = Array.from({ length: 250 }, (_, i) => '道具编号' + i);
    const locks = Array.from({ length: 180 }, (_, i) => '饰品编号' + i + '（已摘下）');
    const memory = createEmptyMemoryData();
    memory.stateLedger.characters = { 甲: { inventory, removedItemsLock: locks } };
    let body;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            l0_summary: '甲清点全部物品。', keywords: [], stateLedger: { characters: { 甲: { inventory: [...inventory, inventory[0]], removedItemsLock: [locks[0]] } } },
        }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    await summarizeSingleTurn(SETTINGS, memory, { roundNumber: 1, startMessageId: 0, endMessageId: 1, dialogueText: '甲清点物品。', shouldCommit: () => true });
    assert.doesNotMatch(body.messages[0].content, /随身道具，上限/);
    assert.match(body.messages[0].content, /不要按固定条数裁剪/);
    assert.ok(JSON.stringify(body.messages).includes(inventory.at(-1)));
    assert.deepEqual(memory.stateLedger.characters.甲.inventory, inventory);
    assert.equal(memory.stateLedger.characters.甲.removedItemsLock.length, 180);
    normalizeMemoryData(memory);
    assert.deepEqual(resolveStateLedgerAfterEntry(memory, memory.archivePool[0]).characters.甲.inventory, inventory);
});
