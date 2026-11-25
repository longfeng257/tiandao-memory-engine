import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileNativeVisibility, rollbackNativeVisibility, visibilityRanges } from '../native-visibility.js';
import { buildHistoryCoverage } from '../history-builder.js';
import { buildRoundMessageIndex, createEmptyMemoryData, DEFAULT_SETTINGS } from '../memory-engine.js';
import { recoveryChatSignature } from '../recovery-store.js';

function fixture() {
    const chat = [{ is_user: false, mes: '开场白' }], memory = createEmptyMemoryData();
    for (let round = 1; round <= 8; round++) {
        chat.push({ is_user: true, mes: '玩家' + round }, { is_user: false, mes: '剧情' + round });
        memory.archivePool.push({ id: 'r' + round, level: 0, roundRange: String(round),
            startMessageId: round === 1 ? 0 : round * 2 - 1, endMessageId: round * 2, text: '有效事实' + round });
    }
    memory.lastProcessedMessageId = chat.length - 1;
    const settings = { ...DEFAULT_SETTINGS, keepRecentRoundsCount: 3 };
    const sync = () => reconcileNativeVisibility(chat, buildHistoryCoverage(memory, chat, settings).hiddenIndexes, settings.enabled && settings.autoHideOldMessages);
    return { chat, memory, settings, sync };
}

test('3→5→3 restores only owned floors while canonical rounds, windows and recovery signatures stay stable', () => {
    const f = fixture(), signature = recoveryChatSignature(f.chat);
    const before = buildRoundMessageIndex(f.chat).aiTurns.map(turn => turn.window);
    assert.equal(f.sync().hidden, 11);
    f.settings.keepRecentRoundsCount = 5;
    const expanded = f.sync();
    assert.equal(expanded.restored, 4);
    assert.equal(f.chat[7].is_system, false);
    assert.equal(f.chat[10].is_system, false);
    assert.deepEqual(buildRoundMessageIndex(f.chat).aiTurns.map(turn => turn.window), before);
    assert.equal(recoveryChatSignature(f.chat), signature);
    f.settings.keepRecentRoundsCount = 3;
    assert.equal(f.sync().hidden, 4);
    assert.equal(f.sync().changes.length, 0);
});

test('a missing archived round restores its entire suffix even below the old high-water mark', () => {
    const f = fixture(); f.sync();
    f.memory.archivePool = f.memory.archivePool.filter(item => item.roundRange !== '3');
    assert.equal(f.sync().restored, 6);
    assert.ok(f.chat.slice(5).every(message => !message.is_system));
    assert.ok(f.chat.slice(0, 5).every(message => message.is_system));
});

test('manual native hides survive disable and identifiable manual reveals persist as opt-outs', () => {
    const f = fixture(); f.chat[15].is_system = true;
    f.sync();
    f.chat[3].is_system = false;
    f.sync();
    assert.equal(f.chat[3].extra.suwei_auto_hide_opt_out, true);
    assert.equal(f.chat[3].extra.tiandao_hidden, undefined);
    assert.equal(f.sync().changes.length, 0);
    f.settings.enabled = false; f.sync();
    assert.equal(f.chat[15].is_system, true);
    assert.ok(f.chat.slice(0, 15).every(message => !message.is_system));
    f.settings.enabled = true; f.sync();
    assert.equal(f.chat[3].is_system, false);
});

test('conditional rollback never overwrites a later edit or manual reveal', () => {
    const f = fixture(), changes = f.sync().changes;
    f.chat[1].mes = '编辑后的新正文';
    f.chat[2].is_system = false;
    rollbackNativeVisibility(f.chat, changes);
    assert.equal(f.chat[0].is_system, undefined);
    assert.equal(f.chat[1].is_system, true);
    assert.equal(f.chat[2].is_system, false);
    assert.deepEqual(visibilityRanges(changes), [{ start: 0, end: 10, hide: true }]);
});

test('tool-call windows are retained as a whole before hiding is planned', () => {
    const f = fixture(); f.chat[6].extra = { tool_invocations: [{ id: 'call' }] };
    const plan = buildHistoryCoverage(f.memory, f.chat, f.settings, { canUseTools: true });
    assert.equal(plan.rawStart, 5);
    assert.equal(plan.coveredRounds, 2);
    assert.ok([...plan.hiddenIndexes].every(index => index < 5));
});
