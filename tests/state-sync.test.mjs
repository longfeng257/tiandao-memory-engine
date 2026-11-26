import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyMemoryData, normalizeMemoryData, applyStateChanges, ensureLiveStateStorage,
    recordStateLedger, getStateLedgerCursor, getStateLedgerAtMessage, rollbackMemoryFromMessageIndex,
    reconcileMemoryAfterMessageDeletion, buildChatMessageFingerprint, captureLatestL0StateStorage,
    stampLatestL0StateSnapshot, restoreLatestL0StateStorage, summarizeSingleTurn, DEFAULT_SETTINGS,
    resolveStateUpdateMode, resolveStateLedgerAfterEntry, extractStateChanges, mergeStateLedger } from '../memory-engine.js';
import { readMainResponseState, stripStateUpdateBlocks, parseStateUpdateJson, buildStateUpdateInstruction, stripStateUpdateMessage } from '../state-protocol.js';
import { preparePromptHistory } from '../host-prompt.js';
import { buildChatHistoryReplacement } from '../history-builder.js';
const SETTINGS = { ...DEFAULT_SETTINGS, apiUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test', enableRetrieval: false, useEmbeddingApi: false, summaryRetryCount: 0 };
const patch = (changes = {}, baseRound = 0) => ({ version: 1, baseRound, changes });
const block = value => '<details data-suwei-state="1"><summary>溯微状态</summary><suwei_state>' + JSON.stringify(value) + '</suwei_state></details>';
function fixture() {
    const memory = createEmptyMemoryData();
    memory.stateLedger = { time: '清晨', characters: { 甲: { location: '营地', wear: '黑外套', inventory: ['铜钥匙'], removedItemsLock: ['银戒指（已摘下）'] } }, todosAndPromises: [] };
    return memory;
}
function advance(memory, round, changes = {}) {
    const next = applyStateChanges(memory.stateLedger, patch(changes, getStateLedgerCursor(memory).round), round);
    recordStateLedger(memory, { endMessageId: round * 2 - 1, roundNumber: round }, next);
}

test('existing settings default to legacy and malformed mode values never enable paid work', () => {
    for (const value of [undefined, '', 'bad', {}, true]) assert.equal(resolveStateUpdateMode({ stateUpdateMode: value }), 'with_summary');
    assert.equal(resolveStateUpdateMode({ stateUpdateMode: 'independent' }), 'independent');
    assert.equal(resolveStateUpdateMode({ stateUpdateMode: 'main_response' }), 'main_response');
});

test('state protocol parses data without changing source and rejects incomplete or invalid data', () => {
    const value = patch({ time: '午后' }, 5), source = '甲抵达码头。' + block(value);
    assert.deepEqual(readMainResponseState(source), value);
    assert.equal(stripStateUpdateBlocks(source), '甲抵达码头。');
    assert.equal(stripStateUpdateBlocks('甲抵达。<suwei_state>{"bad":'), '甲抵达。');
    assert.throws(() => readMainResponseState('只有正文'), /未返回完整状态/);
    assert.throws(() => readMainResponseState(source + '<suwei_state>{'), /末尾状态区块不完整/);
    for (const invalid of ['null', '[]', '{}', '{"version":1,"baseRound":-1,"changes":{}}', '{"version":1,"baseRound":0,"changes":[]}']) assert.throws(() => parseStateUpdateJson(invalid));
    assert.deepEqual(readMainResponseState(block(patch({ time: '早上' })) + '继续剧情' + block(value)), value);
});

test('protocol instructions are explicit about deltas, physical identity and continuation', () => {
    const prompt = buildStateUpdateInstruction(5, true);
    for (const text of ['baseRound', '只返回变化字段', '物品不限条数', '衣物、鞋袜和佩戴饰品只记在 wear', '续写', 'data-suwei-state']) assert.ok(prompt.includes(text));
    assert.ok(prompt.includes('"baseRound":5'));
    assert.match(prompt, /<details hidden data-suwei-state="1">/);
});

test('incremental changes retain 250 items and mutate only explicitly changed physical objects', () => {
    const memory = fixture(), inventory = Array.from({ length: 250 }, (_, i) => '钥匙编号' + i);
    memory.stateLedger.characters.甲.inventory = inventory;
    const next = applyStateChanges(memory.stateLedger, patch({ characters: { 甲: {
        location: '码头', inventoryAdd: ['钥匙编号249（放于口袋）', '信件'], inventoryRemove: ['钥匙编号0'],
        removedItemsLockRemove: ['银戒指'], wear: '黑外套、银戒指',
    } } }), 1);
    assert.equal(next.characters.甲.inventory.length, 250);
    assert.ok(!next.characters.甲.inventory.includes('钥匙编号0'));
    assert.ok(next.characters.甲.inventory.includes('钥匙编号1'));
    assert.ok(next.characters.甲.inventory.includes('钥匙编号249（放于口袋）'));
    assert.deepEqual(next.characters.甲.removedItemsLock, []);
    assert.equal(next.characters.甲.location, '码头');
    assert.equal(memory.stateLedger.characters.甲.location, '营地');
});

test('an item transfer updates both holders and an unrelated character remains intact', () => {
    const memory = fixture();
    memory.stateLedger.characters.乙 = { location: '城门', inventory: ['信件'], removedItemsLock: [] };
    const next = applyStateChanges(memory.stateLedger, patch({ characters: {
        甲: { inventoryRemove: ['铜钥匙'] }, 乙: { inventoryAdd: ['铜钥匙'] },
    } }), 1);
    assert.deepEqual(next.characters.甲.inventory, []);
    assert.deepEqual(next.characters.乙.inventory, ['信件', '铜钥匙']);
    assert.equal(next.characters.乙.location, '城门');
});

test('completed incremental todos expire and free space for new promises', () => {
    const memory = fixture();
    const promises = Array.from({ length: 8 }, (_, index) => '约定' + (index + 1));
    advance(memory, 1, { todosAdd: promises });
    const firstId = memory.stateLedger.todosAndPromises[0].id;
    advance(memory, 2, { todosComplete: [firstId, promises[1]] });
    assert.deepEqual(memory.stateLedger.todosAndPromises.slice(0, 2).map(todo => todo.completedRound), [2, 2]);
    const reloaded = normalizeMemoryData(JSON.parse(JSON.stringify(memory)));
    advance(reloaded, 3, { todosComplete: [firstId], todosAdd: ['新约定', ' 新约定 ', '另一项约定'] });
    assert.deepEqual(reloaded.stateLedger.todosAndPromises.map(todo => todo.text), [...promises.slice(2), '新约定', '另一项约定']);
    assert.ok(reloaded.stateLedger.todosAndPromises.every(todo => !todo.completed));
    assert.equal(getStateLedgerAtMessage(reloaded, 3).ledger.todosAndPromises[0].completedRound, 2);
});

test('a player-completed todo is not refreshed by an empty incremental update', () => {
    const memory = fixture();
    memory.stateLedger.todosAndPromises = [{ id: 'manual', text: '旧约定', completed: true, completedRound: 4, completedBy: 'player' }];
    const sameRound = applyStateChanges(memory.stateLedger, patch({ todosComplete: ['manual'] }), 4);
    assert.equal(sameRound.todosAndPromises[0].completedBy, 'player');
    const nextRound = applyStateChanges(sameRound, patch(), 5);
    assert.deepEqual(nextRound.todosAndPromises, []);
});

test('visibility-only state changes hide and reveal existing private observations without redating them', () => {
    const memory = fixture();
    advance(memory, 1, { characters: { 甲: { viewTarget: '密信内容', viewTargetVisible: true } } });
    advance(memory, 2, { characters: { 甲: { viewTargetVisible: false } } });
    const reloaded = normalizeMemoryData(JSON.parse(JSON.stringify(memory)));
    assert.equal(reloaded.stateLedger.characters.甲.viewTarget, '密信内容');
    assert.equal(reloaded.stateLedger.characters.甲.viewTargetVisible, false);
    assert.equal(reloaded.stateLedger.characters.甲.viewSeenRound, 1);
    const chat = [1, 2].flatMap(round => [{ is_user: true, mes: '问题' + round }, { is_user: false, mes: '回复' + round }]);
    const prompt = buildChatHistoryReplacement(reloaded, chat, chat, SETTINGS);
    assert.doesNotMatch(prompt.text, /密信内容/);
    advance(reloaded, 3, { characters: { 甲: { viewTargetVisible: true } } });
    assert.equal(reloaded.stateLedger.characters.甲.viewTargetVisible, true);
    assert.equal(reloaded.stateLedger.characters.甲.viewSeenRound, 1);
});

test('invalid model changes and unsafe keys fail closed without partial updates', () => {
    const memory = fixture(), before = JSON.stringify(memory);
    const changes = [
        { characters: [] }, { characters: { 甲: { present: 'true' } } },
        { characters: { 甲: { inventory: [] } } }, { characters: { 甲: { inventoryAdd: [{}] } } },
        JSON.parse('{"characters":{"__proto__":{"location":"bad"}}}'), { arbitraryPath: 'bad' },
    ];
    for (const change of changes) assert.throws(() => applyStateChanges(memory.stateLedger, patch(change), 1));
    assert.equal(JSON.stringify(memory), before);
    assert.equal({}.location, undefined);
});

test('state snapshots and deltas survive reloads independently of the L0 archive cursor', () => {
    const memory = fixture();
    memory.stateLedger.characters.甲.inventory = Array.from({ length: 250 }, (_, i) => '物品' + i);
    ensureLiveStateStorage(memory);
    for (let round = 1; round <= 25; round++) advance(memory, round, { characters: { 甲: { location: '地点' + round } } });
    assert.equal(memory.lastProcessedRound, 0);
    const loaded = normalizeMemoryData(JSON.parse(JSON.stringify(memory)));
    assert.deepEqual(getStateLedgerCursor(loaded), { endMessageId: 49, round: 25 });
    assert.equal(getStateLedgerAtMessage(loaded, 15).ledger.characters.甲.location, '地点8');
    assert.equal(getStateLedgerAtMessage(loaded, 41).ledger.characters.甲.location, '地点21');
    assert.equal(loaded.stateLedger.characters.甲.inventory.length, 250);
    assert.equal(loaded.stateSync.entries[19].postStateSnapshot.characters.甲.inventory.length, 250);
    assert.equal(loaded.stateSync.entries[20].postStateSnapshot, undefined);
});

test('swiping a state-only round rolls state back even before the first grouped L0 exists', () => {
    const memory = fixture();
    for (let round = 1; round <= 4; round++) advance(memory, round, { characters: { 甲: { location: '地点' + round } } });
    assert.equal(rollbackMemoryFromMessageIndex(memory, 6), true);
    assert.equal(memory.lastProcessedRound, 0);
    assert.equal(getStateLedgerCursor(memory).round, 3);
    assert.equal(memory.stateLedger.characters.甲.location, '地点3');
    assert.equal(rollbackMemoryFromMessageIndex(memory, 0), true);
    assert.equal(getStateLedgerCursor(memory).round, 0);
    assert.equal(memory.stateLedger.characters.甲.location, '营地');
});

test('deleting an earlier state-only round invalidates dependent later state changes', () => {
    const memory = fixture(), chat = [];
    for (let round = 1; round <= 4; round++) {
        chat.push({ is_user: true, mes: '问题' + round }, { is_user: false, mes: '回答' + round });
        advance(memory, round, { characters: { 甲: { location: '地点' + round } } });
    }
    const previous = buildChatMessageFingerprint(chat);
    chat.splice(2, 2);
    assert.equal(reconcileMemoryAfterMessageDeletion(memory, chat, previous), true);
    assert.equal(getStateLedgerCursor(memory).round, 1);
    assert.equal(memory.stateLedger.characters.甲.location, '地点1');
});

test('manual corrections stamp live state without rewriting an older L0 state', () => {
    const memory = fixture();
    const first = { id: 'first', level: 0, text: '第一轮', roundRange: '1', startMessageId: 0, endMessageId: 1, postStateSnapshot: structuredClone(memory.stateLedger) };
    memory.archivePool = [first]; memory.levels[0] = [first]; memory.lastProcessedMessageId = 1; memory.lastProcessedRound = 1;
    advance(memory, 2);
    const captured = captureLatestL0StateStorage(memory);
    memory.stateLedger.characters.甲.inventory = [];
    stampLatestL0StateSnapshot(memory);
    assert.deepEqual(getStateLedgerAtMessage(memory, 3).ledger.characters.甲.inventory, []);
    assert.deepEqual(first.postStateSnapshot.characters.甲.inventory, ['铜钥匙']);
    restoreLatestL0StateStorage(captured);
    rollbackMemoryFromMessageIndex(memory, 4);
    assert.deepEqual(memory.stateSync.entries.at(-1).postStateSnapshot, undefined);
});

test('grouped summary-only calls keep newer live state and save a historically accurate archive snapshot', async t => {
    const memory = fixture();
    for (let round = 1; round <= 8; round++) advance(memory, round, { characters: { 甲: { location: '地点' + round } } });
    let request;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ l0_summary: '甲走过营地与码头。', keywords: [], stateLedger: { characters: { 甲: { location: '错误旧地点' } } } }) } }] }));
    });
    await summarizeSingleTurn({ ...SETTINGS, stateUpdateMode: 'main_response' }, memory, {
        startRound: 1, endRound: 5, roundNumber: 5, startMessageId: 0, endMessageId: 9,
        dialogueText: '甲完成前五轮旅程。', shouldCommit: () => true,
    });
    assert.match(request.messages[0].content, /不要返回或更新人物状态账本/);
    assert.doesNotMatch(request.messages[1].content, /地点8|上一段实体状态账本/);
    assert.equal(memory.stateLedger.characters.甲.location, '地点8');
    const entry = memory.archivePool[0];
    assert.equal(entry.stateRound, 5);
    assert.equal(resolveStateLedgerAfterEntry(memory, entry).characters.甲.location, '地点5');
    assert.equal(getStateLedgerCursor(memory).round, 8);
});

test('source replies retain machine metadata while outgoing copies and summaries omit it', () => {
    const source = [{ is_user: true, mes: '我走到码头。' }, { is_user: false, mes: '守卫递来钥匙。' + block(patch({ time: '午后' })) }];
    const original = JSON.stringify(source), core = preparePromptHistory(source, text => text);
    assert.equal(core[1].mes, '守卫递来钥匙。');
    const memory = fixture();
    const plan = buildChatHistoryReplacement(memory, source, source.map((item, index) => ({ ...item, index })), SETTINGS);
    assert.doesNotMatch(plan.text, /suwei_state|inventoryAdd|data-suwei-state/);
    assert.equal(JSON.stringify(source), original);
});

test('partial item changes preserve an absent character and other scalar fields', () => {
    const memory = fixture();
    memory.stateLedger.characters.甲.present = false;
    memory.stateLedger.characters.甲.viewTarget = '尚未公开的密信';
    memory.stateLedger.characters.甲.viewTargetVisible = true;
    const next = applyStateChanges(memory.stateLedger, patch({ characters: { 甲: { inventoryAdd: ['信封'] } } }), 1);
    assert.equal(next.characters.甲.present, false);
    assert.equal(next.characters.甲.viewTarget, '尚未公开的密信');
    assert.equal(next.characters.甲.location, '营地');
});

for (const type of ['normal', 'swipe', 'continue']) {
    test('main-model protocol uses the surviving state source and preserves the ' + type + ' tail', () => {
        const memory = fixture(), chat = [];
        for (let round = 1; round <= 2; round++) {
            chat.push({ is_user: true, mes: '问题' + round }, { is_user: false, mes: '回答' + round });
            advance(memory, round, { characters: { 甲: { location: '地点' + round } } });
        }
        if (type === 'normal') chat.push({ is_user: true, mes: '新问题' });
        const core = preparePromptHistory(chat, text => text, type);
        const plan = buildChatHistoryReplacement(memory, chat, core, { ...SETTINGS, stateUpdateMode: 'main_response' }, [], '', { generationType: type });
        const protocol = plan.messages.find(message => message.extra?.suwei_kind === 'state_protocol');
        const expected = type === 'normal' ? 2 : 1;
        assert.equal(protocol.extra.suwei_source_round, expected);
        assert.ok(protocol.mes.includes('"baseRound":' + expected));
        if (type === 'swipe') assert.doesNotMatch(plan.text, /回答2|地点2/);
        if (type === 'continue') {
            assert.equal(plan.messages.at(-1).mes, '回答2');
            assert.ok(plan.messages.indexOf(protocol) < plan.messages.length - 1);
        }
    });
}

test('invalid live-state storage cannot manufacture an advanced cursor', () => {
    const memory = fixture();
    memory.stateSync = { version: 1, base: { endMessageId: 9, round: 5 } };
    normalizeMemoryData(memory);
    assert.equal(memory.stateSync, null);
    assert.equal(getStateLedgerCursor(memory).round, 0);
});

test('combined L0/state calls output item deltas and retain a large inventory', async t => {
    const memory = fixture();
    memory.stateLedger.characters.甲.inventory = Array.from({ length: 250 }, (_, i) => '物品' + i);
    for (let round = 1; round <= 4; round++) advance(memory, round);
    let request;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            l0_summary: '甲抵达码头。', keywords: [], stateUpdate: patch({ characters: { 甲: { location: '码头', inventoryAdd: ['信件'] } } }, 4),
        }) } }] }));
    });
    await summarizeSingleTurn({ ...SETTINGS, stateUpdateMode: 'independent' }, memory, {
        startRound: 1, endRound: 5, roundNumber: 5, startMessageId: 0, endMessageId: 9,
        dialogueText: '甲在第五轮抵达码头并收到信件。', shouldCommit: () => true,
    });
    assert.match(request.messages[0].content, /不要返回完整 stateLedger 或完整物品清单/);
    assert.match(request.messages[0].content, /基准第 4 轮之后/);
    assert.equal(memory.stateLedger.characters.甲.inventory.length, 251);
    assert.equal(getStateLedgerCursor(memory).round, 5);
    assert.equal(resolveStateLedgerAfterEntry(memory, memory.archivePool[0]).characters.甲.inventory.length, 251);
});

test('invalid state data in a combined response cannot partially commit the narrative or state', async t => {
    const memory = fixture();
    for (let round = 1; round <= 4; round++) advance(memory, round);
    normalizeMemoryData(memory);
    const before = JSON.stringify(memory);
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        l0_summary: '甲抵达码头。', keywords: [], stateUpdate: patch({ characters: { 甲: { inventoryAdd: [{}] } } }, 4),
    }) } }] })));
    await assert.rejects(summarizeSingleTurn({ ...SETTINGS, stateUpdateMode: 'independent' }, memory, {
        startRound: 1, endRound: 5, roundNumber: 5, startMessageId: 0, endMessageId: 9,
        dialogueText: '甲抵达码头。', shouldCommit: () => true,
    }), /inventoryAdd/);
    assert.equal(JSON.stringify(memory), before);
});

for (const code of ['REQUEST_TIMEOUT', 'RESPONSE_TIMEOUT']) {
    test('state extraction never automatically duplicates a potentially billable ' + code, async t => {
        const memory = fixture();
        const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(Error('渠道超时'), { code }); });
        await assert.rejects(extractStateChanges({ ...SETTINGS, summaryRetryCount: 2 }, memory.stateLedger, { dialogueText: '甲抵达码头。', roundNumber: 1 }), /不会自动重试/);
        assert.equal(fetch.mock.callCount(), 1);
    });
}

test('a continuation with an unfinished state wrapper never reuses the previous block', () => {
    const old = block(patch({ time: '午后' }));
    for (const tail of [
        '<details data-suwei-state="1">',
        '<details data-suwei-state',
        '<details hidden data-suwei-state="1"',
        '<details data-suwei-state="1"><summary>溯微状态</summary>',
        '<suwei_state',
    ]) {
        assert.throws(() => readMainResponseState(old + '继续剧情。' + tail), /末尾状态区块不完整/, tail);
    }
    assert.deepEqual(readMainResponseState(old + '继续剧情。<details><summary>信件</summary>正文</details>' + block(patch({ time: '夜晚' }))), patch({ time: '夜晚' }));
});

test('canonical and alias patches in one response compose without losing items or unlocking twice', () => {
    const memory = fixture(), before = JSON.stringify(memory);
    memory.stateLedger.characters.甲.aliases = ['小甲'];
    const next = applyStateChanges(memory.stateLedger, patch({ characters: {
        甲: { inventoryAdd: ['信封'], removedItemsLockRemove: ['银戒指'], wear: '黑外套、银戒指' },
        小甲: { location: '码头', inventoryAdd: ['通行证'] },
    } }), 1);
    assert.deepEqual(Object.keys(next.characters), ['甲']);
    assert.deepEqual(next.characters.甲.inventory, ['铜钥匙', '信封', '通行证']);
    assert.deepEqual(next.characters.甲.removedItemsLock, []);
    assert.equal(next.characters.甲.wear, '黑外套、银戒指');
    assert.equal(next.characters.甲.location, '码头');
    assert.deepEqual(memory.stateLedger.characters.甲.inventory, ['铜钥匙']);
    assert.equal(memory.stateLedger.characters.甲.location, JSON.parse(before).stateLedger.characters.甲.location);
});

test('newly introduced aliases in one patch refer to the same character', () => {
    const memory = fixture();
    const next = applyStateChanges(memory.stateLedger, patch({ characters: {
        乙: { aliases: ['小乙'], inventoryAdd: ['地图'] },
        小乙: { inventoryAdd: ['罗盘'] },
    } }), 1);
    assert.deepEqual(Object.keys(next.characters), ['甲', '乙']);
    assert.deepEqual(next.characters.乙.inventory, ['地图', '罗盘']);
    assert.equal(next.characters.甲.lastSeenRound, 0);
});

test('actual history removes state JSON flattened by host regex without rebuilding source prose', () => {
    const memory = fixture();
    const source = [{ is_user: true, mes: '去哪里' }, { is_user: false,
        mes: '守卫递来钥匙。<options>绝不发出的选项</options>' + block(patch({ characters: { 甲: { statusAndAction: '检查刻着 } 和 \" 的铜牌' } } })) }];
    const original = JSON.stringify(source);
    const core = source.map((message, index) => ({ ...message, index,
        mes: message.mes.replace(/<options>[\s\S]*?<\/options>/g, '').replace(/<[^>]*>/g, '').replace('递来', '交出').replace('铜牌', '银牌') }));
    const plan = buildChatHistoryReplacement(memory, source, core, { ...SETTINGS, autoHideOldMessages: false });
    assert.equal(plan.messages.find(message => message.index === 1).mes, '守卫交出钥匙。');
    assert.doesNotMatch(plan.text, /baseRound|changes|溯微状态|绝不发出的选项/);
    assert.equal(JSON.stringify(source), original);
});


test('state filtering leaves user quotations and unbound story JSON untouched', () => {
    const source = { is_user: false, mes: '正文' + block(patch()) };
    const ordinary = { is_user: false, mes: '  正文原样保留  ', extra: { media: ['fixture'] } };
    assert.equal(stripStateUpdateMessage(ordinary, source), ordinary);
    const json = { is_user: false, mes: JSON.stringify(patch()) };
    assert.equal(stripStateUpdateMessage(json), json);
    const quoted = { ...source, is_user: true };
    assert.equal(stripStateUpdateMessage(quoted), quoted);
});

test('flattened malformed or incomplete source blocks are removed without parsing them as state', () => {
    for (const payload of ['{"version":1,"baseRound":0,"changes":', 'not-json', '{"version":1,"changes":{}}']) {
        const source = { is_user: false, mes: '正文。<details data-suwei-state="1"><summary>溯微状态</summary><suwei_state>' + payload };
        const processed = { ...source, mes: source.mes.replace(/<[^>]*>/g, '') };
        assert.equal(stripStateUpdateMessage(processed, source).mes, '正文。');
        assert.throws(() => readMainResponseState(source.mes));
    }
});

test('full ledger updates combine canonical and alias scalar fields without duplicating the character', () => {
    const memory = fixture();
    memory.stateLedger.characters.甲.aliases = ['小甲'];
    const next = mergeStateLedger(memory.stateLedger, { characters: {
        甲: { inventory: ['铜钥匙', '信封'], wear: '新外套' }, 小甲: { location: '码头' },
    } }, 1);
    assert.deepEqual(Object.keys(next.characters), ['甲']);
    assert.deepEqual(next.characters.甲.inventory, ['铜钥匙', '信封']);
    assert.equal(next.characters.甲.wear, '新外套');
    assert.equal(next.characters.甲.location, '码头');
});


test('filtering multiple flattened continuation blocks preserves the story between and after them', () => {
    const source = { is_user: false, mes: '前段剧情。' + block(patch({ time: '状态值一' }))
        + '中段剧情。' + block(patch({ time: '状态值二' })) + '后段剧情。' };
    const processed = { ...source, mes: source.mes.replace(/<[^>]*>/g, '').replaceAll('状态值', '改写值') };
    assert.equal(stripStateUpdateMessage(processed, source).mes, '前段剧情。中段剧情。后段剧情。');
});

test('an invalid machine payload cannot delete matching ordinary words from the story', () => {
    const source = { is_user: false, mes: 'not-json 是守卫读到的原文。<details data-suwei-state="1"><summary>溯微状态</summary><suwei_state>not-json</suwei_state></details>' };
    const processed = { ...source, mes: source.mes.replace(/<[^>]*>/g, '') };
    assert.equal(stripStateUpdateMessage(processed, source).mes, 'not-json 是守卫读到的原文。');
});
