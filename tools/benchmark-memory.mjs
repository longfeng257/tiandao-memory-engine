import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as current from "../memory-engine.js";
import { buildChatHistoryReplacement } from "../history-builder.js";

// Run with --compare-head for a read-only comparison against the current Git HEAD.
const baseline = process.argv.includes("--compare-head")
    ? await import("data:text/javascript;base64," + Buffer.from(execFileSync("git", ["show", "HEAD:memory-engine.js"], { cwd: new URL("../", import.meta.url), maxBuffer: 2_000_000 })).toString("base64"))
    : null;
function fixture(api, count) {
    const memory = api.createEmptyMemoryData();
    const chat = [];
    for (let round = 1; round <= count; round++) {
        chat.push({ is_user: true, mes: "旅人向守卫询问约定和铜钥匙的下落。".repeat(20) });
        chat.push({ is_user: false, mes: "守卫说明线索，两人约好在码头见面。".repeat(30) });
        memory.archivePool.push({ id: "l0_" + round, level: 0, roundRange: String(round), startMessageId: round * 2 - 2, endMessageId: round * 2 - 1, text: "清晨，旅人到城门归还铜钥匙，守卫说次日可在码头见面。", keywords: ["守卫", "铜钥匙"], ...(round % 20 === 1 ? { postStateSnapshot: { time: "清晨", characters: {}, todosAndPromises: [] } } : { postStateDelta: { t: "o", v: {} } }) });
    }
    memory.levels[0] = memory.archivePool.slice(-6);
    // Disjoint phase coverage models a real long archive, rather than repeating rounds 1-120 at every level.
    const phaseEnd = Math.max(0, count - 6);
    let phaseStart = 1;
    for (const [level, desiredWidth] of [[3, Math.max(0, phaseEnd - 100)], [2, 75], [1, 25]]) {
        const end = Math.min(phaseEnd, phaseStart + desiredWidth - 1);
        memory.levels[level] = end >= phaseStart ? [{ id: 'L' + level, level, roundRange: phaseStart + '-' + end, text: '旅人与守卫在城中收集线索，约定在码头交还铜钥匙。'.repeat(10) }] : [];
        phaseStart = end + 1;
    }
    memory.lastProcessedMessageId = count * 2 - 1;
    memory.lastProcessedRound = count;
    return { memory, chat };
}
function liveFixture(count) {
    const { memory, chat } = fixture(current, count);
    const inventory = Array.from({ length: 250 }, (_, i) => "随身道具" + (i + 1));
    const locks = Array.from({ length: 180 }, (_, i) => "饰品" + (i + 1) + "（已摘下）");
    memory.stateLedger = { time: "清晨", characters: { 旅人: { inventory, removedItemsLock: locks } }, todosAndPromises: [] };
    const processed = { message: memory.lastProcessedMessageId, round: memory.lastProcessedRound };
    memory.lastProcessedMessageId = -1;
    memory.lastProcessedRound = 0;
    current.ensureLiveStateStorage(memory);
    for (let round = 1; round <= count; round++) {
        // Common scalar updates; periodically rewrite one item to exercise array-valued deltas.
        const traveler = memory.stateLedger.characters.旅人;
        const next = { ...memory.stateLedger, characters: { 旅人: {
            ...traveler, location: "营地" + round,
            inventory: round % 10 === 0 ? [...inventory.slice(0, -1), inventory.at(-1) + "（放于口袋" + round + "）"] : traveler.inventory,
        } } };
        current.recordStateLedger(memory, { endMessageId: round * 2 - 1, roundNumber: round }, next);
    }
    memory.lastProcessedMessageId = processed.message;
    memory.lastProcessedRound = processed.round;
    return { memory, chat, inventoryCount: inventory.length, lockCount: locks.length };
}

function measure(callback, samples = 25) {
    for (let i = 0; i < 5; i++) callback();
    const times = [];
    for (let i = 0; i < samples; i++) { const started = performance.now(); callback(); times.push(performance.now() - started); }
    times.sort((a, b) => a - b);
    return { medianMs: +times[Math.floor(times.length / 2)].toFixed(3), p95Ms: +times[Math.floor(times.length * .95)].toFixed(3) };
}
for (const count of [200, 1000, 5000]) {
    for (const [name, api] of [["HEAD", baseline], ["working", current]]) {
        if (!api) continue;
        const { memory, chat } = fixture(api, count);
        api.normalizeMemoryData(memory);
        const report = { variant: name, scenario: "archive", rounds: count, normalize: measure(() => api.normalizeMemoryData(memory)), prompt: measure(() => api.buildInjectedMemoryPrompt(memory)), fingerprint: measure(() => api.buildChatMessageFingerprint(chat)) };
        if (name === 'working') {
            const core = chat.map((message, index) => ({ ...message, index }));
            report.localSend = measure(() => {
                api.normalizeMemoryData(memory);
                api.buildChatMessageFingerprint(chat);
                const roundIndex = api.buildRoundMessageIndex(chat);
                buildChatHistoryReplacement(memory, chat, core, api.DEFAULT_SETTINGS, [], '', { roundIndex });
            });
        }
        console.log(JSON.stringify(report));
    }

    const { memory, chat, inventoryCount, lockCount } = liveFixture(count);
    const serialized = JSON.stringify(memory);
    const loaded = current.normalizeMemoryData(JSON.parse(serialized));
    const lastHistoricalMessage = (count - 1) * 2 - 1;
    const historical = current.getStateLedgerAtMessage(loaded, lastHistoricalMessage);
    assert.equal(historical.round, count - 1);
    assert.equal(historical.ledger.characters.旅人.inventory.length, inventoryCount);
    assert.equal(historical.ledger.characters.旅人.removedItemsLock.length, lockCount);
    const core = chat.map((message, index) => ({ ...message, index }));
    const settings = { ...current.DEFAULT_SETTINGS, stateUpdateMode: "main_response" };
    console.log(JSON.stringify({
        variant: "working", scenario: "live-state", rounds: count, stateEntries: loaded.stateSync.entries.length,
        inventoryCount, lockCount, serializedBytes: Buffer.byteLength(serialized),
        reload: measure(() => current.normalizeMemoryData(JSON.parse(serialized))),
        normalize: measure(() => current.normalizeMemoryData(loaded)),
        historicalState: measure(() => current.getStateLedgerAtMessage(loaded, lastHistoricalMessage)),
        localContinue: measure(() => {
            current.normalizeMemoryData(loaded);
            const roundIndex = current.buildRoundMessageIndex(chat);
            buildChatHistoryReplacement(loaded, chat, core, settings, [], "", { roundIndex, generationType: "continue" });
        }),
    }));
}
