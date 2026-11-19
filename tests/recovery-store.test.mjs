import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyMemoryData } from "../memory-engine.js";
import { createRecoveryPoint, appendRecoveryPoint, restoreRecoveryPoint, recoveryChatSignature } from "../recovery-store.js";
const chat = () => [{ is_user: true, mes: "玩家拿出钥匙" }, { is_user: false, mes: "守卫打开门" }];

test("recovery points clone memory without embedding live references", () => {
    const data = createEmptyMemoryData();
    data.stateLedger.time = "清晨";
    const point = createRecoveryPoint(data, chat(), "导入", 100);
    data.stateLedger.time = "夜晚";
    const restored = restoreRecoveryPoint(point, chat());
    assert.equal(restored.stateLedger.time, "清晨");
    restored.stateLedger.time = "傍晚";
    assert.equal(point.memory.stateLedger.time, "清晨");
});

test("recovery survives serialized chat metadata and excludes recursive history", () => {
    const point = createRecoveryPoint(createEmptyMemoryData(), chat(), "清空");
    const points = JSON.parse(JSON.stringify(appendRecoveryPoint([], point)));
    assert.deepEqual(restoreRecoveryPoint(points[0], chat()), createEmptyMemoryData());
    assert.equal(points[0].memory.suwei_memory_recovery_v1, undefined);
});

test("restoring an edited, deleted, appended, or swiped story is rejected", () => {
    const point = createRecoveryPoint(createEmptyMemoryData(), chat(), "导入");
    for (const changed of [chat().slice(0, 1), [...chat(), { is_user: true, mes: "继续" }], [chat()[0], { is_user: false, mes: "守卫关上门" }]]) {
        assert.throws(() => restoreRecoveryPoint(point, changed), /原文或分支已变化/);
    }
});

test("plugin-hidden raw floors do not falsely invalidate a recovery point", () => {
    const raw = chat();
    const hidden = chat();
    hidden[1].is_system = true;
    hidden[1].extra = { tiandao_hidden: true };
    assert.equal(recoveryChatSignature(raw), recoveryChatSignature(hidden));
    const point = createRecoveryPoint(createEmptyMemoryData(), raw, "编辑");
    assert.ok(restoreRecoveryPoint(point, hidden));
    hidden[1].extra = {};
    assert.notEqual(recoveryChatSignature(raw), recoveryChatSignature(hidden));
});

test("recovery history retains only the latest three points", () => {
    let points = [];
    for (let i = 0; i < 5; i++) points = appendRecoveryPoint(points, createRecoveryPoint(createEmptyMemoryData(), chat(), String(i), i));
    assert.deepEqual(points.map(point => point.label), ["2", "3", "4"]);
});

test("recovery storage rejects oversized snapshots and bounds combined history", () => {
    const data = createEmptyMemoryData();
    data.farHistory.text = "a".repeat(4_000_001);
    assert.throws(() => createRecoveryPoint(data, chat(), "large"), /容量/);
    data.farHistory.text = "a".repeat(1_500_000);
    let points = [];
    for (let i = 0; i < 4; i++) points = appendRecoveryPoint(points, createRecoveryPoint(data, chat(), String(i), i));
    assert.equal(points.length, 2);
    assert.ok(JSON.stringify(points).length <= 4_000_000);
});

test("recovery capacity includes the serialized history array brackets", t => {
    t.mock.method(Math, "random", () => 0.5);
    const data = createEmptyMemoryData();
    const first = createRecoveryPoint(data, chat(), "boundary", 100);
    const serializedSize = JSON.stringify([first]).length;
    data.farHistory.text = "a".repeat(4_000_000 - serializedSize + 1);
    assert.throws(() => createRecoveryPoint(data, chat(), "boundary", 100), /容量/);
});
