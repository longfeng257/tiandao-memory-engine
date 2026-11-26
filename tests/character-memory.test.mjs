import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createEmptyMemoryData, normalizeMemoryData, mergeStateLedger, applyStateChanges,
    recordStateLedger, getStateLedgerAtMessage, getStateLedgerCursor, rollbackMemoryFromMessageIndex,
    resolveStateLedgerAfterEntry, buildInjectedMemoryPrompt, buildNarrativeStoryView,
    pruneStaleCharacters, summarizeSingleTurn, DEFAULT_SETTINGS, extractStateChanges,
    buildChatMessageFingerprint, reconcileMemoryAfterMessageDeletion,
} from '../memory-engine.js';
import { normalizeGrowth, normalizeCharacterMemory, shouldTrackCharacter } from '../character-memory.js';
import { buildStateUpdateInstruction, readMainResponseState } from '../state-protocol.js';
import { buildChatHistoryReplacement } from '../history-builder.js';

const patch = (characters, baseRound = 0) => ({ version: 1, baseRound, changes: { characters } });
const growth = (state = '先核实导师的命令，再决定是否执行', extra = {}) => ({
    key: '对导师的信任', dimension: 'relationship', target: '导师', state,
    evidence: '明确说出“我仍敬重您，但今后会先核实命令”。', ...extra,
});
const actor = extra => ({ location: '营地', wear: '布衣', inventory: [], removedItemsLock: [], ...extra });
const settings = { ...DEFAULT_SETTINGS, apiUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test',
    enableRetrieval: false, useEmbeddingApi: false, summaryRetryCount: 0 };
const advance = (memory, round, changes) => recordStateLedger(memory, { endMessageId: round * 2 - 1, roundNumber: round },
    applyStateChanges(memory.stateLedger, patch(changes, getStateLedgerCursor(memory).round), round));

// Assertions concern storage and prompt behavior. Semantic judgments remain the model's responsibility.
test('growth follows stable identity, merges by aspect and target, and preserves unchanged provenance', () => {
    let ledger = mergeStateLedger({}, { characters: { 苏晚: actor({ aliases: ['苏小姐'], growth: [growth()] }) } }, 3);
    assert.equal(ledger.characters.苏晚.growth[0].sourceRound, 3);
    ledger = applyStateChanges(ledger, patch({ 苏小姐: { growth: [growth('开始接受导师的解释，但仍会核实重要命令', { sourceRound: 999 })] } }), 8);
    assert.deepEqual(Object.keys(ledger.characters), ['苏晚']);
    assert.equal(ledger.characters.苏晚.growth.length, 1);
    assert.equal(ledger.characters.苏晚.growth[0].sourceRound, 8);
    const repeated = mergeStateLedger(ledger, { characters: { 苏晚: { growth: ledger.characters.苏晚.growth } } }, 9);
    assert.equal(repeated.characters.苏晚.growth[0].sourceRound, 8);
    const other = applyStateChanges(repeated, patch({ 苏晚: { growth: [growth('仍无条件信任', { target: '姐姐' })] } }), 10);
    assert.equal(other.characters.苏晚.growth.length, 2);
    const omitted = applyStateChanges(other, patch({ 苏晚: { growth: [], location: '码头' } }), 11);
    assert.deepEqual(omitted.characters.苏晚.growth, other.characters.苏晚.growth);
});

test('age jumps update one current life stage while nonhuman nature remains independent', () => {
    const stage = state => growth(state, { key: state, dimension: 'lifeStage', target: '', evidence: '剧情明确写出年龄与时间推进。' });
    let ledger = applyStateChanges({}, patch({ 阿零: { growth: [stage('幼年'), growth('机械体，能回放见过的图像', {
        key: '存在方式', dimension: 'nature', target: '', evidence: '阿零当场回放昨日的视觉记录。',
    })] } }), 1);
    ledger = applyStateChanges(ledger, patch({ 阿零: { growth: [stage('成年')] } }), 20);
    ledger = applyStateChanges(ledger, patch({ 阿零: { growth: [stage('老年')] } }), 40);
    assert.equal(ledger.characters.阿零.growth.length, 2);
    assert.equal(ledger.characters.阿零.growth.find(item => item.dimension === 'lifeStage').state, '老年');
    assert.equal(ledger.characters.阿零.growth.find(item => item.dimension === 'nature').sourceRound, 1);
});

test('both intake paths reject incidental and generic unnamed actors while retaining a justified unnamed ally', () => {
    const characters = {
        路人甲: actor(), 店员: actor({ inventory: ['茶杯'] }),
        阿明: actor({ importance: 'incidental', importanceReason: '仅在结账时打过招呼' }),
        青衣女子: actor({ named: false }),
        无名引路人: actor({ named: false, importance: 'supporting', importanceReason: '持续带领队伍寻找失踪者，并约定同行至北境' }),
        苏晚: actor({ importance: 'core', importanceReason: '持续参与主线的同伴' }),
    };
    const full = mergeStateLedger({}, { characters }, 1);
    const incremental = applyStateChanges({}, patch(Object.fromEntries(Object.entries(characters).map(([name, info]) => [name, {
        location: info.location, inventoryAdd: info.inventory,
        ...(info.named !== undefined ? { named: info.named } : {}),
        ...(info.importance ? { importance: info.importance, importanceReason: info.importanceReason } : {}),
    }]))), 1);
    for (const ledger of [full, incremental]) assert.deepEqual(Object.keys(ledger.characters), ['无名引路人', '苏晚']);
    assert.equal(shouldTrackCharacter('守卫', { importance: 'supporting' }), false);
});

test('old background entries are cleaned while named people and unclassified quest holders survive conservatively', () => {
    const memory = createEmptyMemoryData();
    memory.stateLedger.characters = { 路人: actor(), 服务员: actor(), 苏晚: actor(), 守卫: actor({ inventory: ['任务密函'] }),
        无名引路人: actor({ named: false, importance: 'supporting', importanceReason: '已约定带队穿越北境' }) };
    normalizeMemoryData(memory);
    assert.deepEqual(Object.keys(memory.stateLedger.characters), ['苏晚', '守卫', '无名引路人']);
    memory.stateLedger = applyStateChanges(memory.stateLedger, patch({ 守卫: { importance: 'incidental' } }), 2);
    assert.equal(memory.stateLedger.characters.守卫, undefined);
    assert.ok(memory.stateLedger.characters.苏晚);
});

test('a core actor and an actor with growth survive pruning ahead of present background records', () => {
    const memory = createEmptyMemoryData();
    memory.stateLedger.characters.苏晚 = actor({ importance: 'core', importanceReason: '核心同伴', present: false, lastSeenRound: 1 });
    memory.stateLedger.characters.阿零 = actor({ growth: [growth()], present: false, lastSeenRound: 1 });
    for (let i = 0; i < 15; i++) memory.stateLedger.characters['具名角色' + i] = actor({ lastSeenRound: 100, present: true });
    pruneStaleCharacters(memory, 100, { maxCharacters: 10 });
    assert.ok(memory.stateLedger.characters.苏晚);
    assert.ok(memory.stateLedger.characters.阿零);
    assert.equal(Object.keys(memory.stateLedger.characters).length, 10);
});

test('malformed growth fails atomically, and imported executable or unsupported fields are dropped', () => {
    const memory = createEmptyMemoryData();
    for (const invalid of [null, {}, [growth('', {})], [growth('改变', { evidence: '' })], [growth('改变', { dimension: '__proto__' })],
        [growth('改变', { target: '' })], [growth('改变', { execute: 'bad' })]]) {
        const before = JSON.stringify(memory);
        assert.throws(() => applyStateChanges(memory.stateLedger, patch({ 苏晚: { location: '新地点', growth: invalid } }), 1));
        assert.equal(JSON.stringify(memory), before);
    }
    assert.deepEqual(normalizeGrowth([growth('改变', { instruction: 'bad' })]), []);
    assert.throws(() => normalizeCharacterMemory({ importance: 'superhero' }, { strict: true }));
    assert.throws(() => normalizeCharacterMemory({ named: 'yes' }, { strict: true }));
});

test('growth survives live delta/keyframe reloads and swipe restores the earlier personality', () => {
    const memory = createEmptyMemoryData();
    advance(memory, 1, { 苏晚: { growth: [growth('相信导师的判断')] } });
    for (let round = 2; round <= 22; round++) advance(memory, round, { 苏晚: round === 20
        ? { growth: [growth()] } : { location: '地点' + round } });
    const loaded = normalizeMemoryData(JSON.parse(JSON.stringify(memory)));
    assert.equal(loaded.stateLedger.characters.苏晚.growth[0].sourceRound, 20);
    assert.equal(getStateLedgerAtMessage(loaded, 37).ledger.characters.苏晚.growth[0].state, '相信导师的判断');
    rollbackMemoryFromMessageIndex(loaded, 38);
    assert.equal(loaded.stateLedger.characters.苏晚.growth[0].state, '相信导师的判断');
    advance(loaded, 20, { 苏晚: { growth: [growth('继续信任导师，但要求一起调查')] } });
    assert.equal(loaded.stateLedger.characters.苏晚.growth.length, 1);
    assert.equal(loaded.stateLedger.characters.苏晚.growth[0].state, '继续信任导师，但要求一起调查');
    assert.deepEqual(createEmptyMemoryData().stateLedger.characters, {});
});

test('archived snapshots and deltas keep growth after reload and roll back without future knowledge', async () => {
    const originalFetch = globalThis.fetch;
    let turn = 1;
    const systems = [];
    globalThis.fetch = async (_url, options) => {
        systems.push(JSON.parse(options.body).messages[0].content);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            l0_summary: '苏晚明确说明了自己对导师的态度。', keywords: ['导师'],
            stateLedger: { characters: { 苏晚: { growth: [growth(turn === 1 ? '相信导师的判断' : '先核实命令再行动')] } } },
        }) } }] }), { status: 200 });
    };
    try {
        const memory = createEmptyMemoryData();
        for (turn = 1; turn <= 2; turn++) await summarizeSingleTurn(settings, memory, {
            startMessageId: (turn - 1) * 2, endMessageId: turn * 2 - 1, roundNumber: turn,
            dialogueText: '苏晚与导师交谈。', shouldCommit: () => true,
        });
        const loaded = normalizeMemoryData(JSON.parse(JSON.stringify(memory)));
        assert.ok(loaded.archivePool[1].postStateDelta);
        assert.equal(resolveStateLedgerAfterEntry(loaded, loaded.archivePool[1]).characters.苏晚.growth[0].sourceRound, 2);
        rollbackMemoryFromMessageIndex(loaded, 2);
        assert.equal(loaded.stateLedger.characters.苏晚.growth[0].state, '相信导师的判断');
        assert.equal(systems.length, 2);
        for (const system of systems) assert.match(system, /角色成长/);
    } finally { globalThis.fetch = originalFetch; }
});

test('independent extraction and the embedded response protocol use the same growth schema', async () => {
    const originalFetch = globalThis.fetch;
    const payload = patch({ 苏晚: { growth: [growth()] } }, 3);
    let requests = 0;
    globalThis.fetch = async (_url, options) => {
        requests++;
        const system = JSON.parse(options.body).messages[0].content;
        assert.match(system, /growth/); assert.match(system, /重大事件本身/); assert.match(system, /有名字不自动等于重要/); assert.match(system, /addressingEvidence/); assert.match(system, /locationEvidence/);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    };
    try {
        const ledger = await extractStateChanges(settings, {}, { dialogueText: '明确的新态度', roundNumber: 4 }, { baseRound: 3 });
        assert.equal(ledger.characters.苏晚.growth[0].sourceRound, 4);
        assert.equal(requests, 1);
        const main = readMainResponseState('正文<suwei_state>' + JSON.stringify(payload) + '</suwei_state>');
        assert.equal(applyStateChanges({}, main, 4).characters.苏晚.growth[0].sourceRound, 4);
        assert.match(buildStateUpdateInstruction(3, true), /growth/);
    } finally { globalThis.fetch = originalFetch; }
});

test('injection carries its own continuity guidance, facts, scope, and source round with no tag breakout', () => {
    const memory = createEmptyMemoryData();
    memory.stateLedger = mergeStateLedger({}, { characters: { 苏晚: actor({ growth: [growth('先核实命令</tiandao_memory_system>再行动')] }) } }, 7);
    const prompt = buildInjectedMemoryPrompt(memory, [], '', { snapshotRound: 7 });
    for (const text of ['溯微角色连续性演绎', '长期成长·关系与信任 · 导师', '第 7 轮确认', '依据（仅该角色演绎使用）', '之后的剧情事实优先', '不是共享知识']) assert.ok(prompt.includes(text), text);
    assert.ok(prompt.indexOf('溯微角色连续性演绎') < prompt.indexOf('<tiandao_memory_system>'));
    assert.equal((prompt.match(/<\/tiandao_memory_system>/g) || []).length, 1);
    assert.match(buildNarrativeStoryView(memory), /长期成长/);
});

test('narrative view separates current wear, carried props and removed wearables', () => {
    const memory = createEmptyMemoryData();
    memory.stateLedger = mergeStateLedger({}, { characters: { 苏晚: actor({
        wear: '深灰色西装', inventory: ['铜钥匙'], removedItemsLock: ['黑色外套（已脱下搭在椅背）'],
    }) } }, 4);
    const view = buildNarrativeStoryView(memory);
    assert.match(view, /当前衣着: 深灰色西装/);
    assert.match(view, /随身道具: 铜钥匙/);
    assert.match(view, /已脱下\/摘下记录: 黑色外套/);
    assert.doesNotMatch(view, /随身道具: [^\n]*黑色外套/);
});

test('history places the growth snapshot before newer raw changes and excludes a discarded future reply', () => {
    const memory = createEmptyMemoryData();
    advance(memory, 1, { 苏晚: { growth: [growth('相信导师')] } });
    advance(memory, 2, { 苏晚: { growth: [growth('怀疑导师')] } });
    const chat = [
        { is_user: true, mes: '问起导师' }, { is_user: false, mes: '她说自己相信导师。' },
        { is_user: true, mes: '发生变故' }, { is_user: false, mes: '她要求核实命令。' },
        { is_user: true, mes: '导师拿出证据' }, { is_user: false, mes: '她重新开始信任导师。' },
    ];
    const plan = buildChatHistoryReplacement(memory, chat, chat, { ...settings, autoHideOldMessages: false });
    assert.ok(plan.text.indexOf('怀疑导师') < plan.text.indexOf('她重新开始信任导师'));
    const swipe = buildChatHistoryReplacement(memory, chat.slice(0, 4), chat.slice(0, 3), { ...settings, autoHideOldMessages: false }, [], '', { generationType: 'swipe' });
    assert.doesNotMatch(swipe.text, /怀疑导师/);
    assert.match(swipe.text, /相信导师/);
});

for (const finalSnapshot of [false, true]) test('deleting a growth event restores surviving beliefs and rebases evidence in ' + (finalSnapshot ? 'snapshots' : 'deltas'), () => {
    const memory = createEmptyMemoryData();
    const chat = [];
    for (let round = 1; round <= 3; round++) {
        chat.push({ is_user: true, mes: '输入' + round }, { is_user: false, mes: '剧情' + round });
        advance(memory, round, { 苏晚: { growth: round === 3
            ? [growth('遇事会自己查证', { dimension: 'cognition', key: '独立判断', target: '', evidence: '主动提出查阅卷宗并自己完成核实。' })]
            : [growth(round === 1 ? '相信导师' : '怀疑导师')] } });
        const live = memory.stateSync.entries.at(-1);
        const storage = round === 1 || (round === 3 && finalSnapshot)
            ? { postStateSnapshot: structuredClone(memory.stateLedger) } : { postStateDelta: structuredClone(live.postStateDelta) };
        const item = { id: 'archive-' + round, level: 0, roundRange: String(round), startMessageId: round * 2 - 2,
            endMessageId: round * 2 - 1, text: '剧情' + round, ...storage };
        memory.archivePool.push(item); memory.levels[0].push(item);
        memory.lastProcessedMessageId = item.endMessageId; memory.lastProcessedRound = round;
    }
    memory.stateSync = null;
    const before = buildChatMessageFingerprint(chat);
    chat.splice(2, 2);
    reconcileMemoryAfterMessageDeletion(memory, chat, before, buildChatMessageFingerprint(chat));
    const loaded = normalizeMemoryData(JSON.parse(JSON.stringify(memory)));
    const facts = loaded.stateLedger.characters.苏晚.growth;
    assert.equal(facts.find(item => item.dimension === 'relationship').state, '相信导师');
    assert.equal(facts.find(item => item.dimension === 'relationship').sourceRound, 1);
    assert.equal(facts.find(item => item.dimension === 'cognition').sourceRound, 2);
    const restored = resolveStateLedgerAfterEntry(loaded, loaded.archivePool.at(-1));
    assert.deepEqual(restored.characters.苏晚.growth, facts);
    assert.doesNotMatch(buildInjectedMemoryPrompt(loaded), /怀疑导师/);
});

test('an incidental classification cannot be undone by an omitted field on the same actor alias', () => {
    const ledger = mergeStateLedger({}, { characters: { 苏晚: actor({ aliases: ['苏小姐'] }) } }, 1);
    const full = mergeStateLedger(ledger, { characters: { 苏晚: { importance: 'incidental' }, 苏小姐: { location: '门口' } } }, 2);
    const incremental = applyStateChanges(ledger, patch({ 苏晚: { importance: 'incidental' }, 苏小姐: { location: '门口' } }), 2);
    for (const next of [full, incremental]) assert.deepEqual(Object.keys(next.characters), []);
});

test('a legacy delta cannot resurrect an anonymous background actor after normalization or rollback', () => {
    const memory = createEmptyMemoryData();
    const first = { id: 'first', level: 0, roundRange: '1', startMessageId: 0, endMessageId: 1, text: '来到门口',
        postStateSnapshot: { characters: { 苏晚: actor() }, todosAndPromises: [] } };
    const second = { id: 'second', level: 0, roundRange: '2', startMessageId: 2, endMessageId: 3, text: '路人走过',
        postStateDelta: { t: 'o', v: { characters: { t: 'o', v: { 路人: { t: 'v', v: actor() } } } } } };
    memory.archivePool = [first, second]; memory.levels[0] = [first, second];
    normalizeMemoryData(memory);
    assert.equal(resolveStateLedgerAfterEntry(memory, second).characters.路人, undefined);
    assert.doesNotMatch(buildInjectedMemoryPrompt({ stateLedger: resolveStateLedgerAfterEntry(memory, second) }), /【路人】/);
});

test('a combined independent L0 returns growth in the existing single request', async () => {
    const memory = createEmptyMemoryData();
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (_url, options) => {
        requests++;
        const system = JSON.parse(options.body).messages[0].content;
        assert.match(system, /stateUpdate/); assert.match(system, /角色成长/);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            l0_summary: '苏晚决定先核实命令。', keywords: ['命令'], stateUpdate: patch({ 苏晚: { growth: [growth()] } }),
        }) } }] }), { status: 200 });
    };
    try {
        await summarizeSingleTurn({ ...settings, stateUpdateMode: 'independent' }, memory, {
            roundNumber: 1, startMessageId: 0, endMessageId: 1, dialogueText: '苏晚明确表示会先核实。', shouldCommit: () => true,
        });
        assert.equal(requests, 1);
        assert.equal(memory.stateLedger.characters.苏晚.growth[0].sourceRound, 1);
        assert.equal(memory.archivePool[0].postStateSnapshot.characters.苏晚.growth[0].sourceRound, 1);
    } finally { globalThis.fetch = originalFetch; }
});


test('off-screen supporting relatives retain durable location facts and identity continuity', () => {
    const ledger = mergeStateLedger({}, { characters: {
        母亲: actor({ importance: 'supporting', importanceReason: '主角的母亲；原文明示居住香港，后续家庭线会引用', named: false,
            location: '香港', locationEvidence: '母亲一直住在香港。' }),
    } }, 3);
    assert.ok(ledger.characters.母亲, 'a durable off-screen relationship is retained');
    assert.equal(ledger.characters.母亲.location, '香港');
    assert.equal(ledger.characters.母亲.locationRound, 3);

    const prompt = buildInjectedMemoryPrompt({ stateLedger: ledger }, [], '', { snapshotRound: 3 });
    assert.match(prompt, /母亲/);
    assert.match(prompt, /香港/);
    assert.match(prompt, /依据第 3 轮：母亲一直住在香港/);
});

test('source-backed locations and forms of address resist unsupported drift but accept explicit plot changes', () => {
    let ledger = mergeStateLedger({}, { characters: {
        少爷: actor({ importance: 'core', importanceReason: '持续主线人物',
            location: '香港', locationEvidence: '少爷目前住在香港。',
            addressing: '少爷自称「本少爷」；手下阿策称少爷「少爷」',
            addressingEvidence: '阿策说：「少爷，车已备好。」' }),
    } }, 5);
    assert.equal(ledger.characters.少爷.locationRound, 5);
    assert.equal(ledger.characters.少爷.addressingRound, 5);

    ledger = mergeStateLedger(ledger, { characters: {
        少爷: { location: '台湾', addressing: '少爷自称「老子」；手下阿策称其「家主」' },
    } }, 30);
    assert.equal(ledger.characters.少爷.location, '香港');
    assert.equal(ledger.characters.少爷.addressing, '少爷自称「本少爷」；手下阿策称少爷「少爷」');
    assert.equal(ledger.characters.少爷.locationRound, 5);
    assert.equal(ledger.characters.少爷.addressingRound, 5);

    ledger = mergeStateLedger(ledger, { characters: {
        少爷: { location: '台湾', locationEvidence: '他已搬到台湾定居。',
            addressing: '少爷改为自称「老子」；阿策改称其「家主」',
            addressingEvidence: '阿策改口道：「家主，车已备好。」' },
    } }, 31);
    assert.equal(ledger.characters.少爷.location, '台湾');
    assert.equal(ledger.characters.少爷.locationRound, 31);
    assert.equal(ledger.characters.少爷.addressing, '少爷改为自称「老子」；阿策改称其「家主」');
    assert.equal(ledger.characters.少爷.addressingRound, 31);

    const prompt = buildInjectedMemoryPrompt({ stateLedger: ledger }, [], '', { snapshotRound: 31 });
    assert.match(prompt, /稳定自称\/关系称呼/);
    assert.match(prompt, /最近一次有依据/);
    const view = buildNarrativeStoryView({ stateLedger: ledger });
    assert.match(view, /台湾/);
    assert.match(view, /老子/);
});