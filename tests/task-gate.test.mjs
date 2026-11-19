import test from "node:test";
import assert from "node:assert/strict";
import { createSummaryTaskGate } from "../task-gate.js";

test("task slot releases FIFO waiters one at a time", async () => {
    const gate = createSummaryTaskGate();
    const first = gate.tryAcquire();
    let secondWoke = false, thirdWoke = false;
    const secondPromise = gate.acquire().then(token => { secondWoke = true; return token; });
    const thirdPromise = gate.acquire().then(token => { thirdWoke = true; return token; });
    await Promise.resolve();
    assert.equal(secondWoke, false);
    gate.release(first);
    const second = await secondPromise;
    assert.equal(thirdWoke, false);
    assert.notEqual(second, first);
    gate.release(second);
    const third = await thirdPromise;
    assert.equal(thirdWoke, true);
    gate.release(third);
});

test("stopping invalidates waiting tasks without stealing the active slot", async () => {
    const gate = createSummaryTaskGate();
    const active = await gate.acquire();
    const waitA = gate.acquire(), waitB = gate.acquire();
    gate.invalidate();
    assert.equal(await waitA, null);
    assert.equal(await waitB, null);
    assert.equal(gate.tryAcquire(), null);
    gate.release(active);
    assert.ok(gate.tryAcquire());
});

test("duplicate or stale release cannot release the next owner", async () => {
    const gate = createSummaryTaskGate();
    const first = await gate.acquire();
    const next = gate.acquire();
    assert.equal(gate.release(first), true);
    const second = await next;
    assert.equal(gate.release(first), false);
    assert.equal(gate.tryAcquire(), null);
    assert.equal(gate.release(second), true);
});

test("chat epoch changes skip stale waiters and wake the next valid task", async () => {
    const gate = createSummaryTaskGate();
    const first = await gate.acquire();
    let valid = true;
    const stale = gate.acquire(() => valid);
    const next = gate.acquire();
    valid = false;
    gate.release(first);
    assert.equal(await stale, null);
    assert.ok(await next);
    assert.equal(await gate.acquire(() => false), null);
});
