import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyMemoryData, DEFAULT_SETTINGS, buildChatMessageFingerprint, retrieveRelevantArchivedMemories } from '../memory-engine.js';
import { bindCoreHistory, buildChatHistoryReplacement } from '../history-builder.js';

function fixture(count = 8) {
    const memory = createEmptyMemoryData(), fullChat = [];
    for (let round = 1; round <= count; round++) {
        const date = '2026.1.' + String(round).padStart(2, '0');
        fullChat.push({ is_user: true, name: '旅人', mes: date + ' 玩家原文' }, { is_user: false, name: '守卫', mes: date + ' 角色原文' });
        const entry = { id: 'round-' + round, level: 0, roundRange: String(round), startMessageId: round * 2 - 2, endMessageId: round * 2 - 1,
            text: date + ' 剧情摘要', keywords: ['铜钥匙'], postStateSnapshot: { time: date, characters: {}, todosAndPromises: [] } };
        memory.archivePool.push(entry);
    }
    memory.levels[0] = memory.archivePool.slice(-3);
    memory.levels[1] = [{ id: 'phase-1', level: 1, roundRange: '1-5', startMessageId: 0, endMessageId: 9, text: '2026.1.01 至 2026.1.05 阶段剧情' }];
    memory.lastProcessedRound = count; memory.lastProcessedMessageId = count * 2 - 1;
    memory.stateLedger = { time: '2026.1.' + String(count).padStart(2, '0'), characters: {}, todosAndPromises: [] };
    const settings = { ...DEFAULT_SETTINGS, keepRecentRoundsCount: 2, enableRetrieval: false };
    const core = (end = fullChat.length) => fullChat.slice(0, end).filter(message => !message.is_system || Array.isArray(message.extra?.tool_invocations)).map((message, index) => ({ ...message, index }));
    return { memory, fullChat, settings, core };
}

function build(f, overrides = {}) {
    return buildChatHistoryReplacement(f.memory, f.fullChat, overrides.core || f.core(), { ...f.settings, ...overrides.settings }, overrides.retrieved || [], '旅人', overrides.options || {});
}

test('history replaces old raw dialogue in order, without changing source messages', () => {
    const f = fixture();
    f.fullChat.push({ is_user: true, name: '旅人', mes: '2026.1.09 当前问题' });
    const before = JSON.stringify(f.fullChat), plan = build(f);
    assert.equal(plan.rawStart, 12);
    assert.equal(JSON.stringify(f.fullChat), before);
    assert.doesNotMatch(plan.text, /2026\.1\.01 玩家原文/);
    const order = ['2026.1.01 至 2026.1.05', '2026.1.06 剧情摘要', '2026.1.07 玩家原文', '2026.1.08 角色原文', '归档故事时间', '2026.1.09 当前问题'].map(text => plan.text.indexOf(text));
    assert.ok(order.every(position => position >= 0));
    assert.deepEqual(order, order.slice().sort((a, b) => a - b));
    assert.equal(plan.messages.at(-1).mes, '2026.1.09 当前问题');
    assert.equal(plan.messages[0].extra.type, 'narrator');
});

test('an unarchived gap stays raw even if a later cursor exists', () => {
    const f = fixture();
    f.memory.archivePool = f.memory.archivePool.filter(item => item.roundRange !== '3');
    const plan = build(f);
    assert.equal(plan.rawStart, 4);
    assert.match(plan.text, /2026\.1\.03 玩家原文/);
    assert.match(plan.text, /2026\.1\.08 角色原文/);
});

test('a grouped L0 is never split by the recent-raw boundary', () => {
    const f = fixture();
    const grouped = { ...f.memory.archivePool[4], id: 'group', roundRange: '5-8', startMessageId: 8, endMessageId: 15, text: '四轮合并剧情' };
    f.memory.archivePool.splice(4, 4, grouped); f.memory.levels[0] = [grouped];
    const plan = build(f);
    assert.equal(plan.rawStart, 8);
    assert.match(plan.text, /2026\.1\.05 玩家原文/);
    assert.doesNotMatch(plan.text, /四轮合并剧情/);
});

test('swipe excludes the discarded reply and its future state snapshot', () => {
    const f = fixture();
    const plan = build(f, { core: f.core(f.fullChat.length - 1) });
    assert.equal(plan.messages.at(-1).is_user, true);
    assert.equal(plan.messages.at(-1).mes, '2026.1.08 玩家原文');
    assert.doesNotMatch(plan.text, /2026\.1\.08 角色原文/);
    assert.match(plan.text, /归档故事时间\*\*: 2026\.1\.07/);
});

test('continue keeps the exact processed assistant and media/tool metadata', () => {
    const f = fixture(), core = f.core();
    const last = core.at(-1);
    last.mes = '宿主正则处理后的正文';
    last.extra = { media: [{ type: 'image', url: '/image.png' }], tool_invocations: [{ id: 'call-1', name: 'lookup' }], reasoning_signature: 'signature' };
    const plan = build(f, { core, options: { generationType: "continue" } });
    assert.equal(plan.messages.at(-1), last);
    assert.equal(plan.messages.find(message => message === last), last);
    assert.deepEqual(last.extra.media, [{ type: 'image', url: '/image.png' }]);
    assert.equal(plan.messages.filter(message => message.mes === last.mes).length, 1);
});

test('native hidden messages remain excluded, while index mapping preserves the newest user', () => {
    const f = fixture();
    f.fullChat[2].is_system = true;
    f.fullChat.push({ is_user: true, mes: '当前新问题' });
    const plan = build(f);
    assert.equal(plan.messages.at(-1).mes, '当前新问题');
    assert.ok(!plan.messages.some(message => message.mes === f.fullChat[2].mes));
});

test('messages inserted by another interceptor survive without source indexes', () => {
    const f = fixture(), core = f.core();
    const synthetic = { name: '其他扩展', is_user: false, mes: '工具提供的额外上下文' };
    core.splice(13, 0, synthetic);
    const plan = build(f, { core });
    assert.ok(plan.messages.includes(synthetic));
    assert.ok(plan.messages.indexOf(synthetic) > plan.messages.findIndex(message => message.mes === f.fullChat[12].mes));
});

test('a new chat retains every original message without placeholder history', () => {
    const f = fixture(); f.memory = createEmptyMemoryData();
    const plan = build(f);
    assert.equal(plan.memoryMessages, 0);
    assert.equal(plan.messages.length, f.fullChat.length);
});

test('pinned and recalled details return to their source era exactly once', () => {
    const f = fixture();
    f.memory.archivePool[1].pinned = true;
    const recalled = f.memory.archivePool[2];
    const plan = build(f, { retrieved: [recalled, f.memory.archivePool[1]], options: { retrievalDetails: [{ id: recalled.id, reason: '关键词：铜钥匙' }] } });
    const order = ['2026.1.01 剧情摘要', '2026.1.02 剧情摘要', '2026.1.03 剧情摘要', '2026.1.06 剧情摘要', '2026.1.07 玩家原文'].map(text => plan.text.indexOf(text));
    assert.ok(order.every(position => position >= 0));
    assert.deepEqual(order, order.slice().sort((a,b) => a-b));
    assert.equal(plan.text.split(recalled.text).length - 1, 1);
    assert.equal(plan.retrieval.find(item => item.id === recalled.id).reason, '关键词：铜钥匙');
});

test('fixed memories inside recent raw dialogue are inserted at their own round', () => {
    const f = fixture(); f.memory.archivePool[6].pinned = true;
    const plan = build(f);
    assert.ok(plan.text.indexOf('2026.1.07 角色原文') < plan.text.indexOf('2026.1.07 剧情摘要'));
    assert.ok(plan.text.indexOf('2026.1.07 剧情摘要') < plan.text.indexOf('2026.1.08 玩家原文'));
});

test('long selected summaries are not cut to a fixed prompt budget', () => {
    const f = fixture();
    f.memory.levels[1][0].text = '必须完整保留的历史细节'.repeat(900) + '【末尾事实】';
    const plan = build(f);
    assert.ok(plan.tokens > 5000);
    assert.match(plan.text, /【末尾事实】/);
    assert.match(plan.text, /2026\.1\.08 角色原文/);
});

test('disabling historical replacement keeps all raw dialogue and source-positioned ledger', () => {
    const f = fixture(); const plan = build(f, { settings: { autoHideOldMessages: false } });
    assert.equal(plan.rawStart, 0);
    assert.equal(plan.rawMessages, f.fullChat.length);
    assert.doesNotMatch(plan.text, /阶段剧情/);
    assert.ok(plan.text.indexOf('归档故事时间') > plan.text.indexOf('2026.1.08 角色原文'));
});

test('binding uses original object identity and processed-core indexes', () => {
    const f = fixture(), processed = f.core();
    processed[3].mes = '处理后文本';
    const bound = bindCoreHistory(processed, f.fullChat);
    assert.equal(bound[3].sourceIndex, 3);
    assert.equal(bindCoreHistory([f.fullChat[5]], f.fullChat)[0].sourceIndex, 5);
});

test('cached fingerprints still detect edits beyond the first 120 characters', () => {
    const chat = [{ is_user: false, mes: 'a'.repeat(2000) + 'old' }];
    const first = buildChatMessageFingerprint(chat);
    assert.deepEqual(buildChatMessageFingerprint(chat), first);
    chat[0].mes = 'a'.repeat(2000) + 'new';
    assert.notDeepEqual(buildChatMessageFingerprint(chat), first);
    const edited = buildChatMessageFingerprint(chat); chat[0].is_system = true;
    assert.notDeepEqual(buildChatMessageFingerprint(chat), edited);
});

test('retrieval expands known character aliases and explains its matches', async () => {
    const f = fixture(); f.memory.levels[0] = [];
    f.memory.stateLedger.characters = { 林遥: { aliases: ['小林'], location: '城门' } };
    f.memory.archivePool[0].text = '林遥借走铜钥匙。'; f.memory.archivePool[0].keywords = ['林遥'];
    const details = [];
    const selected = await retrieveRelevantArchivedMemories({ enableRetrieval: true, retrievalTopK: 2 }, f.memory, '小林去哪里了？', { skipNormalize: true, focusQuery: '小林去哪里了？', details });
    assert.equal(selected[0].id, 'round-1');
    assert.match(details[0].reason, /人物别名：林遥/);
});

test('retrieval prioritizes the latest user question and removes exact duplicate text', async () => {
    const f = fixture(); f.memory.levels[0] = [];
    f.memory.archivePool[0].text = '铜钥匙藏在码头。'; f.memory.archivePool[0].keywords = ['铜钥匙'];
    f.memory.archivePool[1].text = '铜钥匙藏在码头。'; f.memory.archivePool[1].keywords = ['铜钥匙'];
    f.memory.archivePool[2].text = '月光洒在山林。'; f.memory.archivePool[2].keywords = ['月光', '山林'];
    const selected = await retrieveRelevantArchivedMemories({ enableRetrieval: true, retrievalTopK: 3 }, f.memory, '月光山林'.repeat(100), { skipNormalize: true, focusQuery: '铜钥匙呢？' });
    assert.equal(selected.filter(item => item.text === '铜钥匙藏在码头。').length, 1);
    assert.ok(!selected.some(item => item.id === 'round-3'));
});
