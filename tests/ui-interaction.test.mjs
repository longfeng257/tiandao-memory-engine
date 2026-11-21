import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createSummaryTaskGate } from "../task-gate.js";

// Exercise the widget's handlers without a host, DOM dependency, or network.
const source = readFileSync(new URL("../index.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .split("(async function initTiandaoMemoryExtension()")[0];

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness() {
    const nodes = new Map(), status = [], lookups = [], completions = [];
    const settings = { embeddingModelFilterOnly: true };
    const document = {
        activeElement: null,
        createElement: () => element(),
        getElementById: id => nodes.get(id),
        body: { appendChild: el => nodes.set(el.id, el) },
    };
    function element(value = "") {
        const attrs = new Map(), listeners = new Map();
        return {
            value, children: [], style: {}, disabled: false, textContent: "", dispatched: [],
            getAttribute: name => attrs.get(name),
            setAttribute: (name, value) => attrs.set(name, value),
            removeAttribute: name => attrs.delete(name),
            classList: { toggle() {} },
            appendChild(child) { this.children.push(child); },
            replaceChildren() { this.children = []; },
            querySelectorAll(selector) {
                return this.children.filter(child => selector === `[role="${child.getAttribute("role")}"]`);
            },
            querySelector(selector) {
                return this.children.find(child => selector === "span" ? child.isLabel : child.className?.split(" ").includes(selector.slice(1)));
            },
            getBoundingClientRect: () => ({ left: 20, top: 100, bottom: 132, width: 230 }),
            contains(target) { return target === this || this.children.includes(target); },
            focus() { document.activeElement = this; },
            addEventListener(type, callback) { listeners.set(type, callback); },
            dispatchEvent(event) { this.dispatched.push(event.type); },
            async fire(type, init = {}) {
                const event = {
                    target: this, currentTarget: this, defaultPrevented: false, stopped: false,
                    preventDefault() { this.defaultPrevented = true; },
                    stopPropagation() { this.stopped = true; },
                    ...init,
                };
                await listeners.get(type)?.(event);
                return event;
            },
        };
    }
    const scope = vm.createContext({
        document, window: { innerWidth: 1000, innerHeight: 720 }, Event, AbortController,
        createSummaryTaskGate, settings, recordStatus: text => status.push(text),
        fetchWithTimeout: (url, options, _timeout, signal) => {
            const response = deferred();
            lookups.push({ url, options, signal, ...response });
            return response.promise;
        },
        readResponseText: response => response.text(),
        callIndependentLLM: (config, messages, options) => {
            const completion = deferred();
            completions.push({ config, messages, options, ...completion });
            return completion.promise;
        },
    });
    vm.runInContext(`${source}
        getSettings = () => settings;
        flushSettingInputs = () => {};
        saveSettings = () => {};
        refreshApiProfileSelect = () => {};
        updateStatusBar = recordStatus;
        globalThis.ui = { bindWidgetTabs, bindModelMenu, bindModelLookups, bindApiTest, applyApiProfileToForm,
            summaryModels: () => [...fetchedModelNames], embeddingModels: () => [...fetchedEmbeddingModelNames] };
    `, scope);
    const node = (id, value) => {
        const el = element(value);
        el.id = id;
        nodes.set(id, el);
        return el;
    };
    return { document, element, node, settings, status, lookups, completions, ui: scope.ui };
}

test("tab arrows, Home/End and click keep one tab stop and exactly one panel visible", async () => {
    const { document, element, node, ui } = harness();
    const list = element();
    const panels = [0, 1, 2].map(i => node(`panel${i}`));
    const tabs = panels.map(panel => {
        const tab = element();
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", panel.id);
        list.appendChild(tab);
        return tab;
    });
    const check = selected => {
        assert.equal(document.activeElement, tabs[selected]);
        assert.deepEqual(tabs.map(tab => tab.tabIndex), tabs.map((_, i) => i === selected ? 0 : -1));
        assert.deepEqual(tabs.map(tab => tab.getAttribute("aria-selected")), tabs.map((_, i) => String(i === selected)));
        assert.deepEqual(panels.map(panel => panel.hidden), panels.map((_, i) => i !== selected));
    };
    ui.bindWidgetTabs(list);
    await tabs[0].fire("click");
    check(0);
    for (const [from, key, to] of [[0, "ArrowLeft", 2], [2, "ArrowDown", 0], [0, "End", 2], [2, "Home", 0], [0, "ArrowRight", 1], [1, "ArrowUp", 0]]) {
        assert.equal((await tabs[from].fire("keydown", { key })).defaultPrevented, true);
        check(to);
    }
    assert.equal((await tabs[0].fire("keydown", { key: "Tab" })).defaultPrevented, false);
    check(0);
});

test("model list keyboard traversal, selection, Escape and Tab preserve focus order", async () => {
    const { document, node, ui } = harness();
    const input = node("model", ""), toggle = node("toggle");
    ui.bindModelMenu({ inputId: "model", toggleId: "toggle", menuId: "choices", label: "Models", manualLabel: "Manual", getNames: () => ["Alpha", "Zulu"] });
    const menu = document.getElementById("choices");
    assert.equal(menu.hidden, true);
    await toggle.fire("click");
    const [manual, alpha, zulu] = menu.children;
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.ok(menu.children.every(option => option.tabIndex === -1 && option.type === "button"));
    assert.equal(document.activeElement, manual);
    await menu.fire("keydown", { key: "ArrowDown", target: manual });
    assert.equal(document.activeElement, alpha);
    await menu.fire("keydown", { key: "End", target: alpha });
    assert.equal(document.activeElement, zulu);
    await zulu.fire("click");
    assert.equal(input.value, "Zulu");
    assert.deepEqual(input.dispatched, ["change"]);
    assert.equal(document.activeElement, toggle);
    assert.equal(menu.hidden, true);

    await input.fire("keydown", { key: "ArrowUp" });
    assert.equal(document.activeElement.textContent, "Zulu");
    await menu.fire("keydown", { key: "Home", target: document.activeElement });
    assert.equal(document.activeElement.textContent, "Manual");
    const escape = await menu.fire("keydown", { key: "Escape", target: document.activeElement });
    assert.equal(escape.stopped, true);
    assert.equal(document.activeElement, input);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await toggle.fire("click");
    const tab = await menu.fire("keydown", { key: "Tab", target: document.activeElement });
    assert.equal(tab.defaultPrevented, false);
    assert.equal(document.activeElement, toggle);
    assert.equal(menu.hidden, true);
});

for (const { name, buttonId, urlId, keyId, names, edit, fresh } of [
    { name: "summary key", buttonId: "tiandao_fetch_models_btn", urlId: "tiandao_api_url", keyId: "tiandao_api_key", names: "summaryModels", edit: "key", fresh: "summary-new" },
    { name: "embedding URL", buttonId: "tiandao_fetch_embedding_models_btn", urlId: "tiandao_emb_url", keyId: "tiandao_emb_key", names: "embeddingModels", edit: "url", fresh: "embed-new" },
]) {
    test(`editing the ${name} aborts the previous lookup and an out-of-order response cannot unlock the new one`, async () => {
        const { node, document, ui, lookups, status } = harness();
        const button = node(buttonId);
        const url = node(urlId, "https://example.invalid/v1/chat/completions");
        const key = node(keyId, "fixture-key");
        ui.bindModelLookups();
        const old = button.fire("click");
        await button.fire("click");
        assert.equal(lookups.length, 1);
        assert.equal(lookups[0].url, "https://example.invalid/v1/models");
        assert.equal(lookups[0].options.headers.Authorization, "Bearer fixture-key");
        const input = edit === "key" ? key : url;
        input.value = edit === "key" ? "new-fixture-key" : "https://second.invalid/v1";
        await input.fire("input");
        assert.equal(lookups[0].signal.aborted, true);
        assert.equal(button.getAttribute("aria-disabled"), "false");

        const active = button.fire("click");
        key.focus();
        lookups[0].resolve({ ok: true, text: () => JSON.stringify(["stale-model"]) });
        await old;
        assert.equal(button.getAttribute("aria-disabled"), "true");
        assert.deepEqual(Array.from(ui[names]()), []);
        assert.ok(status.every(message => !message.includes("已拉取")));
        lookups[1].resolve({ ok: true, text: () => JSON.stringify({ data: [{ id: fresh }] }) });
        await active;
        assert.deepEqual(Array.from(ui[names]()), [fresh]);
        assert.equal(button.getAttribute("aria-disabled"), "false");
        assert.equal(document.activeElement, key);
        assert.match(status.at(-1), /已拉取 1 个/);
    });
}

test("changing API profile cancels an already-started response body, even for identical credentials", async () => {
    const { node, ui, lookups, status } = harness();
    const button = node("tiandao_fetch_models_btn");
    const apiUrl = "https://example.invalid/v1", apiKey = "fixture-key";
    node("tiandao_api_url", apiUrl);
    node("tiandao_api_key", apiKey);
    ui.bindModelLookups();
    const work = button.fire("click");
    const bodyStarted = deferred(), body = deferred();
    lookups[0].resolve({ ok: true, text: () => { bodyStarted.resolve(); return body.promise; } });
    await bodyStarted.promise;
    ui.applyApiProfileToForm({ id: "secondary", name: "Other", apiUrl, apiKey });
    assert.equal(lookups[0].signal.aborted, true);
    body.reject(new Error("stale channel error"));
    await work;
    assert.ok(status.every(message => !message.includes("stale channel error")));
    assert.deepEqual(Array.from(ui.summaryModels()), []);
    assert.equal(button.getAttribute("aria-disabled"), "false");
});

test("API connectivity test permits only one in-flight paid action and restores the control after failure", async () => {
    const { node, element, ui, completions, settings, status, document } = harness();
    const button = node("tiandao_test_api_btn"), label = element();
    label.isLabel = true;
    label.textContent = "测试独立 API 连通性";
    button.appendChild(label);
    const model = node("tiandao_model", "fixture-model");
    settings.model = model.value;
    ui.bindApiTest();
    button.focus();
    const request = button.fire("click");
    await button.fire("click");
    assert.equal(completions.length, 1);
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.match(label.textContent, /正在测试/);
    assert.equal(document.activeElement, button);
    assert.equal(completions[0].messages.length, 1);
    assert.match(completions[0].messages[0].content, /连接成功/);
    settings.model = model.value = "changed-model";
    assert.equal(completions[0].config.model, "fixture-model");
    completions[0].resolve("old result");
    await request;
    assert.ok(status.every(message => !message.includes("old result")));
    assert.equal(label.textContent, "测试独立 API 连通性");
    assert.equal(button.getAttribute("aria-disabled"), undefined);

    const retry = button.fire("click");
    completions[1].reject(new Error("fixture disconnected"));
    await retry;
    assert.match(status.at(-1), /fixture disconnected/);
    assert.equal(button.getAttribute("aria-disabled"), undefined);
    assert.equal(label.textContent, "测试独立 API 连通性");
});
