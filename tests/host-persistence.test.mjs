import test from "node:test";
import assert from "node:assert/strict";
import { saveAndVerifyChatMetadata, readPersistedFields, saveAndVerifyChatMessages, CHAT_PERSISTENCE_STATUS } from "../host-persistence.js";

import { visibilitySnapshot } from "../native-visibility.js";

function context({ group = false } = {}) {
    return {
        groupId: group ? "group-1" : null,
        chatId: group ? "chat-file-1" : "chat-file-1",
        characterId: 0,
        characters: [{ avatar: "traveler.png" }],
        getCurrentChatId: () => "chat-file-1",
        getRequestHeaders: () => ({ "X-CSRF-Token": "test" }),
    };
}

function jsonResponse(records) {
    return { ok: true, json: async () => records };
}

test("host persistence confirms an undefined native save only after metadata readback", async () => {
    const ctx = context();
    const expected = { tiandao_memory: { lastProcessedRound: 4 } };
    const calls = [];
    const result = await saveAndVerifyChatMetadata(ctx, expected, [async () => undefined], async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return jsonResponse([{ chat_metadata: expected }]);
    });
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.confirmed);
    assert.equal(calls[0].url, "/api/chats/get");
    assert.deepEqual(calls[0].body, { avatar_url: "traveler.png", file_name: "chat-file-1" });
});

test("host persistence treats stale readback after an undefined save as failed", async () => {
    const ctx = context();
    const result = await saveAndVerifyChatMetadata(ctx, { tiandao_memory: { lastProcessedRound: 4 } }, [async () => undefined], async () =>
        jsonResponse([{ chat_metadata: { tiandao_memory: { lastProcessedRound: 3 } } }]));
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.failed);
});

test("host persistence leaves unreadable readback as unknown", async () => {
    const result = await saveAndVerifyChatMetadata(context(), { tiandao_memory: {} }, [async () => undefined], async () => {
        throw Error("network unavailable");
    });
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.unknown);
});

test("group metadata readback uses the active chat file id", async () => {
    const ctx = context({ group: true });
    let request;
    const result = await readPersistedFields(ctx, { tiandao_memory: { ok: true } }, async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return jsonResponse([{ chat_metadata: { tiandao_memory: { ok: true } } }]);
    });
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.confirmed);
    assert.equal(request.url, "/api/chats/group/get");
    assert.deepEqual(request.body, { id: "chat-file-1" });
});

test("host persistence stops after a thrown primary saver", async () => {
    let fallbackCalls = 0;
    const result = await saveAndVerifyChatMetadata(context(), { tiandao_memory: {} }, [
        async () => { throw Error("disk full"); },
        async () => { fallbackCalls++; },
    ], async () => jsonResponse([{ chat_metadata: { tiandao_memory: {} } }]));
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.failed);
    assert.equal(fallbackCalls, 0);
});

test("host persistence leaves saves unconfirmed when the host has no safe readback route", async () => {
    const ctx = context();
    delete ctx.getRequestHeaders;
    let saves = 0;
    const result = await saveAndVerifyChatMetadata(ctx, { tiandao_memory: {} }, [async () => { saves++; }], async () =>
        jsonResponse([{ chat_metadata: { tiandao_memory: {} } }]));
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.unknown);
    assert.equal(saves, 1);
});

test("host persistence does not call fallback savers after explicit save failure", async () => {
    let fallbackCalls = 0;
    const result = await saveAndVerifyChatMetadata(context(), { tiandao_memory: {} }, [
        async () => false,
        async () => { fallbackCalls++; },
    ], async () => jsonResponse([{ chat_metadata: { tiandao_memory: {} } }]));
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.failed);
    assert.equal(fallbackCalls, 0);
});

test("a changed identity before saving returns unknown without saving or reading", async () => {
    let saves = 0, reads = 0;
    const result = await saveAndVerifyChatMetadata(context(), { tiandao_memory: {} }, [async () => { saves++; }], async () => {
        reads++;
        return jsonResponse([{ chat_metadata: { tiandao_memory: {} } }]);
    }, () => false);
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.unknown);
    assert.equal(saves, 0);
    assert.equal(reads, 0);
});

for (const outcome of ["undefined", "false", "throw"]) {
    test("a switch inside native save stays unknown before interpreting " + outcome, async () => {
        let current = true, reads = 0;
        const result = await saveAndVerifyChatMetadata(context(), { tiandao_memory: {} }, [async () => {
            current = false;
            if (outcome === "throw") throw Error("save failed after switch");
            return outcome === "false" ? false : undefined;
        }], async () => {
            reads++;
            return jsonResponse([{ chat_metadata: { tiandao_memory: {} } }]);
        }, () => current);
        assert.equal(result.status, CHAT_PERSISTENCE_STATUS.unknown);
        assert.equal(reads, 0);
    });
}

for (const phase of ["response", "json"]) {
    test("a switch during readback " + phase + " prevents confirmation", async () => {
        let current = true;
        const result = await saveAndVerifyChatMetadata(context(), { tiandao_memory: {} }, [async () => {}], async () => {
            if (phase === "response") current = false;
            return { ok: true, json: async () => {
                if (phase === "json") current = false;
                return [{ chat_metadata: { tiandao_memory: {} } }];
            } };
        }, () => current);
        assert.equal(result.status, CHAT_PERSISTENCE_STATUS.unknown);
    });
}

test("save verification freezes its readback route before awaiting a native saver", async () => {
    const ctx = context();
    let activeId = "chat-file-1", request;
    ctx.getCurrentChatId = () => activeId;
    const expected = { tiandao_memory: { round: 1 } };
    const result = await saveAndVerifyChatMetadata(ctx, expected, [async () => {
        activeId = "chat-file-2";
        ctx.characters[0].avatar = "second.png";
    }], async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return jsonResponse([{ chat_metadata: expected }]);
    });
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.confirmed);
    assert.deepEqual(request, { url: "/api/chats/get", body: { avatar_url: "traveler.png", file_name: "chat-file-1" } });
});

for (const format of ['header', 'plain', 'wrapped', 'group']) {
    test('message visibility readback verifies full ownership and source identity: ' + format, async () => {
        const ctx = context({ group: format === 'group' });
        const message = { is_user: false, mes: '来源正文', is_system: true, swipe_id: 2, extra: { tiandao_hidden: true } };
        let saved = false;
        const records = format === 'plain' ? [message] : format === 'wrapped' ? { chat: [message] } : [{ chat_metadata: {} }, message];
        const result = await saveAndVerifyChatMessages(ctx, [visibilitySnapshot(message, 0)], async () => { saved = true; }, async () => jsonResponse(records));
        assert.ok(saved); assert.equal(result.status, CHAT_PERSISTENCE_STATUS.confirmed);
    });
}
for (const defect of ['metadata-only', 'missing-owner', 'wrong-text', 'wrong-swipe', 'deleted-optout']) {
    test('message persistence refuses ' + defect, async () => {
        const expected = { is_user: false, mes: '原始正文', is_system: true, swipe_id: 0, extra: { tiandao_hidden: true, suwei_auto_hide_opt_out: true } };
        const actual = structuredClone(expected);
        if (defect === 'missing-owner') delete actual.extra.tiandao_hidden;
        if (defect === 'wrong-text') actual.mes = '相同下标其他消息';
        if (defect === 'wrong-swipe') actual.swipe_id = 1;
        if (defect === 'deleted-optout') delete actual.extra.suwei_auto_hide_opt_out;
        const records = [{ chat_metadata: {} }, ...(defect === 'metadata-only' ? [] : [actual])];
        const result = await saveAndVerifyChatMessages(context(), [visibilitySnapshot(expected, 0)], async () => {}, async () => jsonResponse(records));
        assert.equal(result.status, CHAT_PERSISTENCE_STATUS.failed);
    });
}

test('message save freezes its route and expected fields before a native wait', async () => {
    const ctx = context();
    const original = { is_user: true, mes: '固定来源', is_system: true, extra: { tiandao_hidden: true } };
    const expected = [visibilitySnapshot(original, 0)];
    let request;
    const result = await saveAndVerifyChatMessages(ctx, expected, async () => {
        ctx.getCurrentChatId = () => 'other-file'; ctx.characters[0].avatar = 'other.png';
        expected[0].tiandao_hidden = false;
    }, async (url, options) => { request = JSON.parse(options.body); return jsonResponse([{ chat_metadata: {} }, original]); });
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.confirmed);
    assert.deepEqual(request, { avatar_url: 'traveler.png', file_name: 'chat-file-1' });
});

test('message saves switched during the native wait stay unknown without reading another chat', async () => {
    let active = true, reads = 0;
    const result = await saveAndVerifyChatMessages(context(), [], async () => { active = false; }, async () => { reads++; }, () => active);
    assert.equal(result.status, CHAT_PERSISTENCE_STATUS.unknown); assert.equal(reads, 0);
});
