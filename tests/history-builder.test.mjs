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
    f.memory.levels[1] = []; // No valid higher-level summary covers this gap.
    const plan = build(f);
    assert.equal(plan.rawStart, 4);
    assert.match(plan.text, /2026\.1\.03 玩家原文/);
    assert.match(plan.text, /2026\.1\.08 角色原文/);
});

test('a grouped L0 is never split by the recent-raw boundary', () => {
    const f = fixture();
    const grouped = { ...f.memory.archivePool[4], id: 'group', roundRange: '5-8', startMessageId: 8, endMessageId: 15, text: '四轮合并剧情' };
    f.memory.archivePool.splice(4, 4, grouped); f.memory.levels[0] = [grouped];
    f.memory.levels[1] = [];
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
    const order = ['2026.1.01 至 2026.1.05 阶段剧情', '2026.1.02 剧情摘要', '2026.1.03 剧情摘要', '2026.1.06 剧情摘要', '2026.1.07 玩家原文'].map(text => plan.text.indexOf(text));
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


test('recalling one detail per old phase never explodes a 368-round history into L0', () => {
    const f = fixture(368);
    f.memory.levels[1] = [{ id: 'p251', roundRange: '251-275', text: '中期阶段' }];
    f.memory.levels[2] = [{ id: 'p301', roundRange: '301-360', text: '后期阶段' }];
    f.memory.levels[3] = [
        { id: 'p1', roundRange: '1-125', text: '最早阶段' },
        { id: 'p126', roundRange: '126-250', text: '第二阶段' },
    ];
    f.memory.levels[1].push({ id: 'p276', roundRange: '276-300', text: '衔接阶段' });
    const recalled = [f.memory.archivePool[29], f.memory.archivePool[279], f.memory.archivePool[363]];
    const plan = build(f, { retrieved: recalled });
    for (const text of ['最早阶段', '第二阶段', '中期阶段', '衔接阶段', '后期阶段']) {
        assert.equal(plan.text.split(text).length - 1, 1);
    }
    assert.equal(plan.text.split('剧情摘要').length - 1, 8); // 361-366 plus two old hits
    assert.doesNotMatch(plan.text, /第 1 轮\]|第 2 轮\]/);
    assert.match(plan.text, /第 30 轮/);
    assert.match(plan.text, /第 280 轮/);
    assert.equal(plan.rawStart, 732);
});

test('a phase cannot hide raw dialogue across a known L0 gap', () => {
    const f = fixture();
    f.memory.archivePool = f.memory.archivePool.filter(item => item.roundRange !== '3');
    const plan = build(f);
    assert.equal(plan.rawStart, 4);
    assert.doesNotMatch(plan.text, /阶段剧情/);
    assert.match(plan.text, /2026\.1\.03 玩家原文/);
    assert.match(plan.text, /2026\.1\.08 角色原文/);
});

test('overlapping fallback spans use a complete path without losing a round', () => {
    const f = fixture(); f.memory.levels[1] = [];
    const entry = (start,end) => ({ id: start+'-'+end, roundRange: start+'-'+end,
        startMessageId: start*2-2, endMessageId: end*2-1, text: '范围'+start+'至'+end });
    f.memory.archivePool = [entry(1,4), entry(1,3), entry(4,6)];
    const plan = build(f);
    assert.equal(plan.rawStart, 12);
    assert.match(plan.text, /范围1至3/); assert.match(plan.text, /范围4至6/);
    assert.doesNotMatch(plan.text, /范围1至4/);
});

test('far history retains its real starting round and does not mask a missing prefix', () => {
    const f = fixture(); f.memory.levels = {}; f.memory.archivePool = [];
    f.memory.farHistory = { earliestRound: 3, latestRound: 5, text: '只有三到五轮' };
    const plan = build(f);
    assert.equal(plan.rawStart, 0);
    assert.doesNotMatch(plan.text, /只有三到五轮/);
});

test('automatic retrieval does not add a second summary for recent raw dialogue', () => {
    const f = fixture(), recalled = f.memory.archivePool[6];
    const plan = build(f, { retrieved: [recalled] });
    assert.doesNotMatch(plan.text, /2026\.1\.07 剧情摘要/);
    assert.match(plan.text, /2026\.1\.07 角色原文/);
    assert.equal(plan.retrieval.length, 0);
});

test('far history with complete L0 sources keeps chronological order', () => {
    const f = fixture(); f.memory.levels = {};
    f.memory.farHistory = { earliestRound: 3, latestRound: 5, text: '三到五轮远史' };
    const plan = build(f);
    const positions = ['2026.1.01 剧情摘要', '2026.1.02 剧情摘要', '三到五轮远史', '2026.1.06 剧情摘要'].map(text => plan.text.indexOf(text));
    assert.ok(positions.every(position => position >= 0));
    assert.deepEqual(positions, positions.slice().sort((a,b) => a-b));
    assert.equal(plan.rawStart, 12);
});

test('history facts cache observes summary edits in both directions', () => {
    const f = fixture(), phase = f.memory.levels[1][0];
    assert.match(build(f).text, /阶段剧情/);
    phase.text = '张力升腾。';
    assert.doesNotMatch(build(f).text, /阶段剧情|轮阶段总览/);
    assert.match(build(f).text, /2026\.1\.01 剧情摘要/);
    phase.text = '守卫接过铜钥匙。';
    assert.match(build(f).text, /轮阶段总览\] 守卫接过铜钥匙/);
    assert.doesNotMatch(build(f).text, /2026\.1\.01 剧情摘要/);
});

test('overlapping phase candidates preserve each hidden round exactly once', () => {
    let seed = 391;
    const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    for (let sample = 0; sample < 60; sample++) {
        const f = fixture(40), before = JSON.stringify(f.fullChat);
        f.memory.levels = { 0: [], 1: [], 2: [], 3: [] };
        f.memory.archivePool = f.memory.archivePool.filter(() => random(8) !== 0);
        for (let index = 0; index < 18; index++) {
            const start = 1 + random(35), end = Math.min(40, start + random(15));
            const level = 1 + random(3);
            f.memory.levels[level].push({ id: 'candidate-'+index, level, roundRange: start+'-'+end, text: '保留的剧情事实'+index });
        }
        const plan = build(f);
        const coverage = new Map();
        for (const match of plan.text.matchAll(/• \[第 (\d+)(?:-(\d+))? 轮(?:阶段总览)?\]/g)) {
            for (let round = Number(match[1]); round <= Number(match[2] || match[1]); round++) coverage.set(round, (coverage.get(round) || 0) + 1);
        }
        const hiddenRounds = plan.rawStart / 2;
        for (let round = 1; round <= hiddenRounds; round++) assert.equal(coverage.get(round), 1, 'covered round '+round+' in sample '+sample);
        assert.equal(coverage.size, hiddenRounds);
        assert.equal(plan.rawMessages, f.fullChat.length - plan.rawStart);
        assert.equal(JSON.stringify(f.fullChat), before);
    }
});

for (const completed of [6, 7, 8, 9]) {
    test('round-' + completed + ' dialogue overrides an explicitly dated round-5 ledger snapshot', () => {
        const f = fixture(completed);
        f.memory.archivePool = f.memory.archivePool.filter(item => Number(item.roundRange) <= 5);
        f.memory.levels[0] = f.memory.archivePool;
        f.memory.lastProcessedRound = 5;
        f.memory.lastProcessedMessageId = 9;
        f.memory.stateLedger = { time: '第5轮清晨', characters: { 旅人: {
            location: '旧营地', wear: '黑外套', inventory: ['铜钥匙'], removedItemsLock: ['银戒指（已摘下）'],
        } }, todosAndPromises: [] };
        f.fullChat[10].mes = '我脱下黑外套，交出铜钥匙，离开旧营地。';
        f.fullChat[11].mes = '旅人已到新码头，重新戴上银戒指。';
        const before = JSON.stringify(f.memory), plan = build(f, { settings: { l0RoundsPerSummary: 5 } });
        const ledgerIndex = plan.messages.findIndex(message => message.extra?.suwei_kind === 'ledger');
        assert.ok(ledgerIndex >= 0);
        const ledger = plan.messages[ledgerIndex];
        assert.equal(ledger.extra.suwei_source_round, 5);
        assert.match(ledger.mes, /状态同步截至\*\*: 第 5 轮结束/);
        assert.match(ledger.mes, /后文明确重戴即可解除/);
        assert.doesNotMatch(ledger.mes, /最高事实基准|当前地点|当前穿戴/);
        for (const fact of ['我脱下黑外套，交出铜钥匙，离开旧营地。', '旅人已到新码头，重新戴上银戒指。']) {
            assert.ok(plan.messages.findIndex(message => message.mes === fact) > ledgerIndex, fact);
        }
        assert.equal(plan.messages.at(-1).mes, f.fullChat.at(-1).mes);
        assert.equal(JSON.stringify(f.memory), before);
    });
}
