import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const positioning = source.slice(
    source.indexOf("function positionFloatingWidgetCard() {"),
    source.indexOf("function makeDraggable("),
);
const dragging = source.slice(
    source.indexOf("function makeDraggable("),
    source.indexOf("function updateFloatingWidgetUI("),
);

function harness({ width = 320, height = 740, left = 264, top = 60, expanded = true, rightward = false, upward = false } = {}) {
    const window = { innerWidth: width, innerHeight: height };
    const style = values => Object.assign({
        removeProperty(name) { delete this[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; },
    }, values);
    const classes = new Set([
        rightward ? "tiandao-open-rightward" : "tiandao-open-leftward",
        ...(upward ? ["tiandao-open-upward"] : []),
    ]);
    const card = {
        style: style({ width: "372px", height: "610px", maxHeight: "610px" }),
        classList: {
            contains: name => classes.has(name),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
        },
        get offsetWidth() { return Number.parseFloat(this.style.width || "372"); },
        get offsetHeight() { return Number.parseFloat(this.style.height || "610"); },
        get offsetLeft() {
            if (this.style.left) return Number.parseFloat(this.style.left);
            if (this.style.right) return -this.offsetWidth - Number.parseFloat(this.style.right);
            return classes.has("tiandao-open-rightward") ? 0 : -this.offsetWidth;
        },
        get offsetTop() {
            if (this.style.top) return Number.parseFloat(this.style.top);
            if (this.style.bottom) return -this.offsetHeight - Number.parseFloat(this.style.bottom);
            return classes.has("tiandao-open-upward") ? -this.offsetHeight : 0;
        },
        getBoundingClientRect() {
            const origin = widget.getBoundingClientRect();
            const x = origin.left + this.offsetLeft, y = origin.top + this.offsetTop;
            return { left: x, top: y, right: x + this.offsetWidth, bottom: y + this.offsetHeight };
        },
    };
    const widget = {
        style: style({ left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" }),
        getBoundingClientRect() {
            const mobile = window.innerWidth <= 600 && expanded;
            const x = mobile ? 0 : Number.parseFloat(this.style.left);
            const y = mobile ? 0 : Number.parseFloat(this.style.top);
            const w = mobile ? window.innerWidth : expanded ? 0 : 142;
            const h = mobile ? window.innerHeight : expanded ? 0 : 32;
            return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
        },
    };
    const scope = vm.createContext({
        window, setTimeout,
        document: { getElementById: id => id === "tiandao_floating_widget" ? widget : card },
        isMobileWidgetViewport: () => window.innerWidth <= 600,
    });
    vm.runInContext(`let isWidgetExpanded = ${expanded};\n${positioning}\n${dragging}\nglobalThis.position = positionFloatingWidgetCard;\nglobalThis.bindDrag = makeDraggable;`, scope);
    return { window, widget, card, classes, position: scope.position, bindDrag: scope.bindDrag };
}

function assertInside(rect, viewport) {
    assert.ok(rect.left >= 9.5, `left edge ${rect.left} is outside the viewport margin`);
    assert.ok(rect.top >= 9.5, `top edge ${rect.top} is outside the viewport margin`);
    assert.ok(rect.right <= viewport.innerWidth - 9.5, `right edge ${rect.right} is outside the viewport margin`);
    assert.ok(rect.bottom <= viewport.innerHeight - 9.5, `bottom edge ${rect.bottom} is outside the viewport margin`);
}

test("an expanded mobile widget returns inside tablet and desktop viewports without moving on repeated renders", () => {
    const h = harness();
    h.position();
    assert.equal(h.card.style.width, undefined);
    assert.equal(h.widget.style.left, "264px");
    for (const [width, height] of [[768, 1024], [1440, 1000], [700, 400]]) {
        Object.assign(h.window, { innerWidth: width, innerHeight: height });
        h.position();
        const rect = h.card.getBoundingClientRect();
        assertInside(rect, h.window);
        for (let i = 0; i < 5; i++) h.position();
        assert.deepEqual(h.card.getBoundingClientRect(), rect);
    }
});

for (const rightward of [false, true]) {
    test(`a dragged ${rightward ? "rightward" : "leftward"} card keeps its direction and stays reachable after desktop resize`, () => {
        const h = harness({ width: 1440, height: 1000, left: rightward ? 1100 : 1400, top: 950, rightward, upward: true });
        h.position();
        Object.assign(h.window, { innerWidth: 768, innerHeight: 480 });
        h.position();
        assertInside(h.card.getBoundingClientRect(), h.window);
        assert.equal(h.classes.has("tiandao-open-rightward"), rightward);
        assert.equal(h.classes.has("tiandao-open-upward"), true);
    });
}

test("a collapsed launcher dragged on desktop stays reachable when the viewport shrinks to mobile", () => {
    const h = harness({ width: 320, height: 480, left: 1200, top: 900, expanded: false });
    h.position();
    assertInside(h.widget.getBoundingClientRect(), h.window);
});

for (const rightward of [false, true]) {
    for (const upward of [false, true]) {
        test(`dragging a ${rightward ? "rightward" : "leftward"}/${upward ? "upward" : "downward"} card follows the pointer and clamps the visible surface`, () => {
            const h = harness({ width: 1440, height: 1000, left: 650, top: upward ? 800 : 200, rightward, upward });
            h.position();
            const listeners = new Map();
            const handle = {
                style: {},
                closest: selector => selector === ".tiandao-widget-card" ? h.card : null,
                addEventListener: (type, callback) => listeners.set(type, callback),
                setPointerCapture() {},
                releasePointerCapture() {},
            };
            h.bindDrag(h.widget, handle, { onDragMove: h.position });
            const fire = (type, clientX, clientY) => listeners.get(type)({
                target: handle, button: 0, pointerId: 1, clientX, clientY,
                preventDefault() {}, stopImmediatePropagation() {},
            });
            const before = h.card.getBoundingClientRect();
            fire("pointerdown", 500, 250);
            fire("pointermove", 620, 315);
            const moved = h.card.getBoundingClientRect();
            assert.equal(moved.left, before.left + 120);
            assert.equal(moved.top, before.top + 65);
            fire("pointermove", 9999, 9999);
            assertInside(h.card.getBoundingClientRect(), h.window);
            assert.equal(h.card.getBoundingClientRect().right, 1430);
            assert.equal(h.card.getBoundingClientRect().bottom, 990);
            fire("pointermove", -9999, -9999);
            assert.equal(h.card.getBoundingClientRect().left, 10);
            assert.equal(h.card.getBoundingClientRect().top, 10);
            fire("pointerup", -9999, -9999);
        });
    }
}
