// ComfyUI Workflow Execution Timer
// Copyright (C) 2026 Ryuichi Kubuki
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along
// with this program. If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Headless test for web/workflow_timer.js.
 *
 * The widget file imports "../../scripts/app.js" and "../../scripts/api.js", the paths
 * ComfyUI serves those modules from. To satisfy that without a browser, the real file is
 * copied into a throwaway tree of the same shape and imported from there - one source of
 * truth, so the test can never drift from what ships.
 *
 *   node run.mjs
 */
import { mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = resolve(here, ".sandbox");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(resolve(sandbox, "scripts"), { recursive: true });
mkdirSync(resolve(sandbox, "extensions/pack"), { recursive: true });
writeFileSync(resolve(sandbox, "package.json"), JSON.stringify({ type: "module" }));
writeFileSync(resolve(sandbox, "scripts/app.js"), "export const app = globalThis.__app;\n");
writeFileSync(resolve(sandbox, "scripts/api.js"), "export const api = globalThis.__api;\n");
copyFileSync(resolve(here, "../web/workflow_timer.js"), resolve(sandbox, "extensions/pack/workflow_timer.js"));

// --- minimal DOM / timing stubs ------------------------------------------------
let NOW = 0;
globalThis.performance = { now: () => NOW };
const rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
function pump() { const q = rafQueue.splice(0); for (const fn of q) fn(); }

/* Elements carry just enough layout to exercise fit(): a settable box, and a scrollWidth
 * derived from the text and the font size the way a real proportional face behaves
 * (~0.6em per glyph), so the measure-and-scale correction really runs. */
const ADVANCE = 0.6;
function el() {
    return {
        style: {},
        children: [],
        appendChild(c) { this.children.push(c); },
        _text: "",
        set textContent(v) { this._text = String(v); },
        get textContent() { return this._text; },
        boxWidth: 0,
        boxHeight: 0,
        get clientWidth() { return this.boxWidth; },
        get clientHeight() { return this.boxHeight; },
        get scrollWidth() {
            const px = parseFloat(this.style.fontSize ?? "0") || 0;
            return Math.round(this._text.length * px * ADVANCE);
        },
        onerror: null,
        // just enough of the event target contract for the click-to-copy path
        _listeners: {},
        addEventListener(name, handler) { (this._listeners[name] ??= []).push(handler); },
        fire(name, event = {}) {
            for (const handler of this._listeners[name] ?? []) handler({ stopPropagation() {}, ...event });
        },
    };
}

/* localStorage, so the persisted baseline can be inspected, and a clipboard that records what it
 * was handed. Both are plain objects: the code only ever uses getItem/setItem and writeText. */
const storage = new Map();
globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
};
/* Seeded BEFORE the extension is imported, i.e. before its setup() reads it - which is the only
 * way to exercise the restore path, since a previous browser session is exactly what this is. */
storage.set("comfy-workflow-timer:last-totals", JSON.stringify({ "wf-restored": 12_345 }));
let copied = null;
// node already has a getter-only globalThis.navigator, so the clipboard is defined onto it
Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText(text) { copied = text; return Promise.resolve(); } },
});
// whatever the extension puts in <head> is kept, so the font <link>s can be inspected
const head = [];
globalThis.document = {
    head: { appendChild(child) { head.push(child); } },
    getElementById: () => null,
    createElement: () => el(),
};
const stylesheets = () => head.filter((child) => child.rel === "stylesheet");

/* Keyed by the observed element rather than kept in one variable: several timer nodes exist
 * over the course of the suite, and a single slot would leave the sizing checks driving
 * whichever timer was constructed last. */
const resizeCallbacks = new Map();      // observed element -> callback
globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(element) { resizeCallbacks.set(element, this.cb); }
    disconnect() { for (const [element, cb] of resizeCallbacks) if (cb === this.cb) resizeCallbacks.delete(element); }
};
function deliverResize(element) { resizeCallbacks.get(element)?.(); }

// --- ComfyUI stubs -------------------------------------------------------------
const listeners = {};
const graph = { _nodes: [], getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)) ?? null; } };
globalThis.__app = { graph, registerExtension(ext) { globalThis.__ext = ext; } };

let nextPromptId = 1;
let holdResponse = null;     // set to a promise to stall the queue POST on purpose
globalThis.__api = {
    addEventListener(name, cb) { (listeners[name] ??= []).push(cb); },
    async queuePrompt() {
        const id = `p${nextPromptId++}`;
        if (holdResponse) await holdResponse;
        return { prompt_id: id };
    },
};
function emit(name, detail) { for (const cb of listeners[name] ?? []) cb({ detail }); }

/* A prompt in the API format ComfyUI actually sends: per-node class_type plus the
 * workflow title in _meta. */
function makePrompt(nodes) {
    const output = {};
    for (const [id, [classType, title]] of Object.entries(nodes)) {
        output[id] = { class_type: classType, inputs: {}, _meta: title ? { title } : {} };
    }
    return { output, workflow: { nodes: [] } };
}

// --- load the extension --------------------------------------------------------
await import(resolve(sandbox, "extensions/pack/workflow_timer.js"));
const ext = globalThis.__ext;
await ext.setup();

function makeNode(id, type = "WorkflowExecutionTimer", title = null) {
    /* The real frontend builds the schema's widgets inside the ComfyNode constructor and
     * invokes nodeCreated at the end of it, so a DOM widget added by the extension is
     * APPENDED after them. Model that order, because putting the setting below the clock
     * depends on it. */
    const node = {
        id, type, comfyClass: type, graph, size: [0, 0], title,
        widgets: type === "WorkflowExecutionTimer" ? schemaWidgets() : [],
        addDOMWidget(name, widgetType, element, options) {
            const widget = { name, type: widgetType, element, options };
            this.widgets.push(widget);
            return widget;
        },
        addWidget(widgetType, name, value, callback, options) {
            const widget = { name, type: widgetType, value, callback, options, label: undefined };
            this.widgets.push(widget);
            return widget;
        },
        setDirtyCanvas() {},
    };
    graph._nodes.push(node);
    return node;
}

/* What the ComfyNode constructor builds from the schema in nodes.py, before nodeCreated runs. */
function schemaWidgets() {
    return [
        { name: "full_red_minutes", value: 10 },
        { name: "font_spec", value: "Oxanium:wght@400;700" },
    ];
}

let failures = 0;
function check(label, cond, extra = "") {
    console.log(`${cond ? "  OK  " : " FAIL "} ${label}${extra ? "  " + extra : ""}`);
    if (!cond) failures++;
}

// ============================ tests ============================================
console.log("=".repeat(74));

const timerNode = makeNode(7);
await ext.nodeCreated(timerNode);
const t = timerNode.__timer;

// --- formatting ----------------------------------------------------------------
NOW = 0; t.frozenTotal = 0; t.render();
check("00:00:000 at zero", t.view.total.textContent === "00:00:000", t.view.total.textContent);
t.frozenTotal = 65_432; t.render();
check("65.432s -> 01:05:432", t.view.total.textContent === "01:05:432", t.view.total.textContent);
t.frozenTotal = 3_600_000 + 1; t.render();
check("over an hour keeps counting minutes", t.view.total.textContent === "60:00:001", t.view.total.textContent);

// --- colour ramp ---------------------------------------------------------------
const colours = [0, 150_000, 300_000, 599_000, 600_000, 900_000].map((ms) => { t.frozenTotal = ms; t.render(); return t.view.total.style.color; });
check("starts light green", colours[0] === "hsl(120.0, 70.0%, 72.0%)", colours[0]);
check("mid ramp is amber", /^hsl\(60\.0,/.test(colours[2]), colours[2]);
check("fully red at 10:00", colours[4] === "hsl(0.0, 100.0%, 50.0%)", colours[4]);
check("stays red past 10:00", colours[5] === colours[4], colours[5]);
check("hue falls monotonically", colours.slice(0, 5).map((c) => parseFloat(c.slice(4))).every((h, i, a) => i === 0 || h <= a[i - 1]));

// --- the configurable red threshold --------------------------------------------
/* full_red_minutes is declared in nodes.py so the graph serializes it; the widget itself
 * has to end up UNDER the clock, and its value has to be read live rather than captured,
 * since it can change by typing, by deserialising a saved workflow, or from a primitive. */
const setting = timerNode.widgets.find((w) => w.name === "full_red_minutes");
const RED = "hsl(0.0, 100.0%, 50.0%)";
check("the settings sit below the clock, in order",
      timerNode.widgets.map((w) => w.name).join(" -> ") === "timer -> settings -> full_red_minutes -> font_spec",
      timerNode.widgets.map((w) => w.name).join(" -> "));

function colourAt(ms, minutes) {
    if (arguments.length > 1) setting.value = minutes;
    t.frozenTotal = ms; t.render();
    return t.view.total.style.color;
}
check("full red at the configured 2 minutes", colourAt(120_000, 2) === RED, colourAt(120_000));
check("and amber halfway to it", /^hsl\(60\.0,/.test(colourAt(60_000)), colourAt(60_000));
check("raising it to 20 makes 10:00 no longer red", colourAt(600_000, 20) !== RED, colourAt(600_000));
check("but 20:00 is", colourAt(1_200_000) === RED, colourAt(1_200_000));

// a widget can legally hold "" mid-edit, and a primitive could feed anything at all
const bad = [0, -5, "", "abc", null, undefined, NaN].map((v) => colourAt(600_000, v));
check("a blank or nonsense value falls back to 10 minutes", bad.every((c) => c === RED), bad.join(" "));
check("an absurdly small value is clamped, not divided by zero",
      /^hsl\(\d/.test(colourAt(10, 1e-9)), colourAt(10));

// a stopped clock paints only on demand, so the widget has to ask for a repaint itself
setting.value = 20; t.frozenTotal = 600_000; t.render();
const beforeEdit = t.view.total.style.color;
setting.value = 1;
setting.callback(1);
check("editing the setting recolours a stopped clock at once",
      t.view.total.style.color === RED && beforeEdit !== RED, `${beforeEdit} -> ${t.view.total.style.color}`);

// a frontend that gives the node no widget list at all must not break the ramp
const bare = { type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer", size: [0, 0], graph: null, addDOMWidget() {} };
await ext.nodeCreated(bare);
bare.__timer.frozenTotal = 600_000; bare.__timer.render();
check("a node with no widget list still ramps over the default 10 minutes",
      bare.__timer.view.total.style.color === RED, bare.__timer.view.total.style.color);
bare.onRemoved();

setting.value = 10;
t.frozenTotal = 0; t.render();

// --- the font, and the button that shows and hides it ---------------------------
/* font_spec is declared in nodes.py so the graph serializes it; the button that reveals it is
 * added from JS because it is view state. The spec drives both the <link> that loads the face
 * and the CSS stack the elements use. */
const fontWidget = timerNode.widgets.find((w) => w.name === "font_spec");
const settingsButton = timerNode.widgets.find((w) => w.name === "settings");
const fontsOf = () => [t.view.total, t.view.detail, t.view.last, t.view.delta].map((e) => e.style.fontFamily);

check("the default stylesheet is requested at setup",
      stylesheets().some((l) => l.href.includes("family=Oxanium:wght@400;700&display=swap")),
      stylesheets().map((l) => l.href).join(" "));
check("every text element uses the default stack",
      fontsOf().every((f) => f === "'Oxanium', 'Courier New', monospace"), fontsOf()[0]);

check("the toggle is a button", settingsButton?.type === "button");
check("and is kept out of widgets_values", settingsButton?.options?.serialize === false);
check("both settings start hidden", fontWidget.hidden === true && setting.hidden === true);
check("and the button says what it will do", settingsButton.label === "show settings", settingsButton.label);

settingsButton.callback();
check("pressing it reveals both fields", fontWidget.hidden === false && setting.hidden === false);
check("and the label flips", settingsButton.label === "hide settings", settingsButton.label);
settingsButton.callback();
check("pressing it again puts them away",
      fontWidget.hidden === true && setting.hidden === true && settingsButton.label === "show settings");

// changing the spec loads the new face and restyles the elements in place
const sheetsBefore = stylesheets().length;
fontWidget.value = "Roboto+Mono:wght@400;700";
fontWidget.callback(fontWidget.value);
check("a new spec requests its own stylesheet",
      stylesheets().length === sheetsBefore + 1 &&
      stylesheets().at(-1).href.includes("family=Roboto+Mono:wght@400;700&display=swap"),
      stylesheets().at(-1).href);
check("and every element switches to the new family",
      fontsOf().every((f) => f === "'Roboto Mono', 'Courier New', monospace"), fontsOf()[0]);

// the same spec twice must not pile up <link>s
const settled = stylesheets().length;
fontWidget.callback(fontWidget.value);
check("re-applying the same spec changes nothing", stylesheets().length === settled);

/* The value lands in a URL query and in a CSS font-family, so characters that would break out
 * of either are dropped rather than escaped - an unescaped "&" would silently add a query
 * parameter of its own. */
fontWidget.value = 'Bad" Font&family=Evil:wght@400';
fontWidget.callback(fontWidget.value);
const dirty = stylesheets().at(-1).href;
check("a dangerous spec cannot inject a second query parameter", dirty.split("family=").length === 2, dirty);
// the family is wrapped in single quotes in the stack, so a quote inside the NAME would end it
const family = fontsOf()[0].match(/^'([^']*)'/)?.[1] ?? null;
check("and cannot break out of the quoted family name",
      family != null && /^[A-Za-z0-9 ._-]+$/.test(family), String(family));

fontWidget.value = "   ";
fontWidget.callback(fontWidget.value);
check("a blank spec falls back to the default",
      fontsOf()[0] === "'Oxanium', 'Courier New', monospace", fontsOf()[0]);

/* A different face means different metrics, so every width measured so far is wrong and the
 * layout has to be redone. The fit KEY is no use as evidence - the box and the text lengths have
 * not changed, so it lands on the same value - hence counting the calls. */
sizeTo(400, 180);
let fits = 0;
const realFit = Object.getPrototypeOf(t).fit;
t.fit = function (...args) { fits += 1; return realFit.apply(this, args); };
fontWidget.value = "Inter:wght@400;700";
fontWidget.callback(fontWidget.value);
check("changing the font re-measures the layout", fits === 1, `fit() called ${fits}x`);
delete t.fit;

/* Deserialising a saved workflow assigns widget values without calling their callbacks, so the
 * font has to be re-applied - and a spec that is no longer the default reveals its own field,
 * rather than looking as though the setting was lost. */
const loaded = makeNode(400);
await ext.nodeCreated(loaded);
const loadedSpec = loaded.widgets.find((w) => w.name === "font_spec");
check("a freshly created node keeps the fields hidden", loadedSpec.hidden === true);
loadedSpec.value = "Inter:wght@400;700";       // what deserialisation does
loaded.onConfigure();
check("a loaded custom spec reveals the settings", loadedSpec.hidden === false);
check("and is applied without any callback",
      loaded.__timer.view.total.style.fontFamily === "'Inter', 'Courier New', monospace",
      loaded.__timer.view.total.style.fontFamily);
loaded.onRemoved();
graph._nodes.splice(graph._nodes.indexOf(loaded), 1);

/* The field costs the node a row, which would otherwise come straight off the clock. Growing is
 * one-way: shrinking back would throw away a size the user had chosen. */
const grower = makeNode(401);
await ext.nodeCreated(grower);
const growerToggle = grower.widgets.find((w) => w.name === "settings");
const closedHeight = grower.size[1];
growerToggle.callback();
const openHeight = grower.size[1];
check("opening the panel grows the node rather than squeezing the clock", openHeight > closedHeight,
      `${closedHeight} -> ${openHeight}`);
growerToggle.callback();
check("closing it keeps the size", grower.size[1] === openHeight, String(grower.size[1]));
growerToggle.callback(); growerToggle.callback();
check("and reopening does not keep growing", grower.size[1] === openHeight, String(grower.size[1]));
grower.onRemoved();
graph._nodes.splice(graph._nodes.indexOf(grower), 1);

fontWidget.value = "Oxanium:wght@400;700";
fontWidget.callback(fontWidget.value);

// --- scaling with the node -----------------------------------------------------
function sizeTo(w, h) {
    t.view.root.boxWidth = w;
    t.view.root.boxHeight = h;
    t.fitKey = "";
    deliverResize(t.view.root);  // what a real ResizeObserver would deliver
    return [parseFloat(t.view.total.style.fontSize), parseFloat(t.view.detail.style.fontSize)];
}
const small = sizeTo(200, 90);
const medium = sizeTo(400, 180);
const large = sizeTo(800, 360);
check("counter grows with the node", small[0] < medium[0] && medium[0] < large[0], `${small[0]} < ${medium[0]} < ${large[0]}`);
check("sub-line grows with the node", small[1] < medium[1] && medium[1] < large[1], `${small[1]} < ${medium[1]} < ${large[1]}`);
check("sub-line stays smaller than the counter", [small, medium, large].every(([a, b]) => b < a));

/* The header carries the two numbers the node exists to compare, so it is sized ABOVE the
 * sub-line (a label for something already visible on the canvas) and still below the clock.
 * At a shared size it came out around a third of the counter and had to be leaned in for. */
const headerPx = () => parseFloat(t.view.last.style.fontSize);
const trio = [[200, 90], [400, 180], [800, 360]].map((b) => {
    sizeTo(...b);
    return [parseFloat(t.view.total.style.fontSize), headerPx(),
            parseFloat(t.view.detail.style.fontSize)];
});
check("the header is larger than the sub-line", trio.every(([, h, d]) => h > d),
      trio.map(([c, h, d]) => `${c}/${h}/${d}`).join("  "));
check("but still smaller than the counter", trio.every(([c, h]) => h < c));
check("and both header cells share one size",
      t.view.last.style.fontSize === t.view.delta.style.fontSize);

/* fit() un-hides by ASSIGNING the display value, and `style.display = ""` would delete the
 * inline `flex` instead of restoring it - leaving two block divs stacked on separate lines,
 * each reporting the container width as its scrollWidth so the width pass then halves the
 * font. Both of those were real symptoms; the value has to come back by name. */
check("the header stays a flex row after a re-fit", t.view.header.style.display === "flex",
      `display="${t.view.header.style.display}"`);
check("and the sub-line keeps its -webkit-box", t.view.detail.style.display === "-webkit-box",
      t.view.detail.style.display);
// hide it and bring it back: the round trip is where the value gets lost
sizeTo(300, 26);                       // too short for the sub-line
sizeTo(400, 180);                      // back to a size that shows everything
check("a hide/show round trip restores flex, not empty",
      t.view.header.style.display === "flex" && t.view.detail.style.display === "-webkit-box",
      `${t.view.header.style.display} / ${t.view.detail.style.display}`);
sizeTo(400, 180);
const widthLimited = sizeTo(200, 400);   // tall and narrow: width must win
check("width constrains the counter", t.view.total.scrollWidth <= 200, `text ${t.view.total.scrollWidth}px in 200px`);
check("never scales to zero", sizeTo(40, 24)[0] >= 8, String(sizeTo(40, 24)[0]));
sizeTo(400, 180);


/* The clipping bug this guards against: percentage padding resolves against WIDTH on both
 * axes, and the old budget added raw font sizes instead of line-box heights, so on a wide
 * flat node the sub-line was pushed out of the overflow:hidden box and disappeared. Model
 * the vertical stack the way the browser lays it out and assert it fits. */
function cssLength(value, percentBasis) {
    // CSS resolves a percentage padding or gap against the containing block's WIDTH on
    // both axes - the very thing that made the old code overspend the node's height
    if (value == null) return 0;
    const n = parseFloat(value);
    if (!(n >= 0)) return 0;
    return String(value).includes("%") ? (n / 100) * percentBasis : n;
}

function verticalUse(w, h) {
    sizeTo(w, h);
    const padY = cssLength(t.view.root.style.padding, w);
    const gap = cssLength(t.view.root.style.rowGap ?? t.view.root.style.gap, w);
    const lineBox = (el) => parseFloat(el.style.fontSize) * parseFloat(el.style.lineHeight);
    const header = t.view.header.style.display !== "none";
    const shown = t.view.detail.style.display !== "none";
    // the sub-line may be clamped to more than one line; the header row is as tall as its cells
    const lines = parseFloat(t.view.detail.style.webkitLineClamp) || 1;
    let used = padY * 2 + lineBox(t.view.total);
    if (header) used += gap + lineBox(t.view.last);
    if (shown) used += gap + lineBox(t.view.detail) * lines;
    return { used, h, shown, header, lines };
}

const boxes = [[150, 70], [200, 80], [240, 90], [400, 90], [800, 90], [300, 120], [400, 180], [800, 360], [1200, 200]];
const overflowing = boxes.map((b) => verticalUse(...b)).filter((r) => r.used > r.h);
check("nothing overflows the node vertically", overflowing.length === 0,
      overflowing.map((r) => `${r.h}px box using ${r.used.toFixed(1)}px`).join("; "));

const hidden = boxes.map((b) => [b, verticalUse(...b)]).filter(([, r]) => !r.shown);
check("the sub-line is visible at every usable size", hidden.length === 0,
      hidden.map(([b]) => b.join("x")).join("; "));

const headerless = boxes.map((b) => [b, verticalUse(...b)]).filter(([, r]) => !r.header);
check("the header is visible at every usable size", headerless.length === 0,
      headerless.map(([b]) => b.join("x")).join("; "));

// wide and flat is the shape that used to clip
const flat = verticalUse(800, 76);
check("wide flat node keeps all three lines", flat.header && flat.shown && flat.used <= flat.h, `${flat.used.toFixed(1)} <= ${flat.h}`);

/* On something genuinely too short, lines are dropped rather than clipped, and in that
 * order: the sub-line first, the header second, the clock never. */
const squashed = verticalUse(300, 26);
check("an impossibly short node drops the sub-line instead of clipping",
      squashed.used <= squashed.h && !squashed.shown, `${squashed.used.toFixed(1)} <= ${squashed.h}`);
check("and keeps the header in preference to the sub-line", squashed.header);
const crushed = verticalUse(300, 14);
check("a crushed node keeps the clock alone", crushed.used <= crushed.h && !crushed.header && !crushed.shown,
      `${crushed.used.toFixed(1)} <= ${crushed.h}`);
sizeTo(400, 180);

const fitsBefore = t.fitKey;
t.render();
check("fit is not recomputed every frame", t.fitKey === fitsBefore);

// --- a run of OUR workflow -----------------------------------------------------
const otherNode = makeNode(42, "KSampler", "My Sampler");
NOW = 1000;
const prompt1 = makePrompt({ 7: ["WorkflowExecutionTimer", "Timer"], 42: ["KSampler", "My Sampler"] });
const res1 = await globalThis.__api.queuePrompt(1, prompt1);
emit("execution_start", { prompt_id: res1.prompt_id });
check("starts on our execution_start", t.running === true);
NOW = 1500; pump();
check("counts up live", t.view.total.textContent === "00:00:500", t.view.total.textContent);

emit("executing", { node: "42", prompt_id: res1.prompt_id });
NOW = 1750; pump();
check("shows the workflow title, not the id", t.view.detail.textContent.startsWith("My Sampler"), t.view.detail.textContent);
check("times the executing node", t.view.detail.textContent.endsWith("00:00:250"), t.view.detail.textContent);

// a node with no custom title falls back to its class
emit("executing", { node: "7", prompt_id: res1.prompt_id });
NOW = 1800; pump();
check("uses _meta.title when present", t.view.detail.textContent.startsWith("Timer"), t.view.detail.textContent);

NOW = 4321;
emit("execution_success", { prompt_id: res1.prompt_id });
check("stops on success", t.running === false);
check("freezes the final total", t.view.total.textContent === "00:03:321", t.view.total.textContent);
NOW = 99999; pump();
check("stays frozen after the run", t.view.total.textContent === "00:03:321", t.view.total.textContent);

// --- running the SAME workflow again -------------------------------------------
NOW = 100000;
const res2 = await globalThis.__api.queuePrompt(1, prompt1);
emit("execution_start", { prompt_id: res2.prompt_id });
check("a second run restarts the counter", t.running === true && t.view.total.textContent === "00:00:000", t.view.total.textContent);
NOW = 100250; pump();
check("and counts from zero again", t.view.total.textContent === "00:00:250", t.view.total.textContent);
emit("execution_success", { prompt_id: res2.prompt_id });

// --- the race: execution_start BEFORE the queue response ----------------------
/* This is what broke repeat runs in practice. The first run of a session is slow to
 * start (models loading) so the POST response always wins; on a cached repeat run the
 * websocket gets there first, and a strictly-response-keyed owner map misses it. */
let release;
holdResponse = new Promise((r) => { release = r; });
NOW = 200000;
const queuing = globalThis.__api.queuePrompt(1, prompt1);   // deliberately not awaited
emit("execution_start", { prompt_id: "raced-prompt" });
check("adopts a start that beat the response", t.running === true && t.view.total.textContent === "00:00:000", t.view.total.textContent);
emit("executing", { node: "42", prompt_id: "raced-prompt" });
NOW = 200100; pump();
check("and still names the node correctly", t.view.detail.textContent.startsWith("My Sampler"), t.view.detail.textContent);
release(); await queuing; holdResponse = null;
emit("execution_success", { prompt_id: "raced-prompt" });
check("the raced run stops cleanly", t.running === false);


// --- per-node events that carry no prompt_id -----------------------------------
/* execution.py sends "executing" with a prompt_id, but server.py's status/reconnect path
 * sends {node} alone and older servers sent the bare id as the whole detail. Looking up
 * strictly by prompt_id drops those, and the sub-line then sits on "waiting for the first
 * node" for the whole run while the total counts up. */
/* 105:9387 exists only in the prompt - not in the graph - so the title can only come from
 * the entry the timer stored at execution_start. This is the real-world failure: a nested
 * id arriving on an event with no prompt_id rendered as "node 105:9387". */
const nestedPrompt = makePrompt({
    7: ["WorkflowExecutionTimer", "Timer"],
    "105:9387": ["KSampler", "Deep Sampler"],
});
const r7 = await globalThis.__api.queuePrompt(1, nestedPrompt);
NOW = 900000; emit("execution_start", { prompt_id: r7.prompt_id });
emit("executing", { node: "105:9387" });              // no prompt_id
NOW = 900120; pump();
check("nested id with no prompt_id resolves its title", t.view.detail.textContent.startsWith("Deep Sampler"), t.view.detail.textContent);
check("and does not fall back to the raw id", !t.view.detail.textContent.includes("105:9387"), t.view.detail.textContent);

emit("executing", "7");                                // legacy: detail IS the id
NOW = 900200; pump();
check("a legacy bare-id executing event works too", !t.view.detail.textContent.startsWith("waiting"), t.view.detail.textContent);
emit("execution_success", { prompt_id: r7.prompt_id });
check("the stored prompt is released on completion", t.entry == null);

// --- progress_state as the only per-node source --------------------------------
/* Modern frontends read progress_state; a build that never sends "executing" to this
 * client would otherwise leave the sub-line stuck. */
const r8 = await globalThis.__api.queuePrompt(1, prompt1);
NOW = 1000000; emit("execution_start", { prompt_id: r8.prompt_id });
check("sub-line starts out waiting", t.view.detail.textContent.startsWith("waiting"), t.view.detail.textContent);

emit("progress_state", { prompt_id: r8.prompt_id, nodes: {
    42: { node_id: "42", state: "running", value: 0, max: 20 },
    7: { node_id: "7", state: "pending" },
} });
NOW = 1000300; pump();
check("progress_state names the running node", t.view.detail.textContent.startsWith("My Sampler"), t.view.detail.textContent);
const heldAt = t.view.detail.textContent;

// a repeat for the same node must not restart its clock
emit("progress_state", { prompt_id: r8.prompt_id, nodes: { 42: { node_id: "42", state: "running", value: 5, max: 20 } } });
NOW = 1000600; pump();
check("stays on the same node and keeps its clock", t.view.detail.textContent === "My Sampler — 00:00:600", t.view.detail.textContent);

emit("progress_state", { prompt_id: r8.prompt_id, nodes: {
    42: { node_id: "42", state: "finished" },
    7: { node_id: "7", state: "running" },
} });
NOW = 1000700; pump();
check("switches when the next node starts", t.view.detail.textContent.startsWith("Timer — 00:00:100"), t.view.detail.textContent);

// display_node_id wins over node_id: for an expanded or nested node that is the one the
// user actually sees on the canvas
emit("progress_state", { prompt_id: r8.prompt_id, nodes: {
    "42:inner": { node_id: "42:inner", display_node_id: "7", state: "running" },
} });
pump();
check("progress_state prefers display_node_id", t.view.detail.textContent.startsWith("Timer"), t.view.detail.textContent);
emit("execution_success", { prompt_id: r8.prompt_id });
check("the resting sub-line reports the slowest node after the progress_state run",
      t.view.detail.textContent.startsWith("slowest: "), t.view.detail.textContent);


// --- switching workflow tabs mid-run -------------------------------------------
/* The frontend destroys the inactive graph and rebuilds it on return, so the node object
 * that claimed the run is gone and a brand new one appears. It used to show 00:00:000 idle
 * while the workflow was still running, and the rest of the run went unreported.
 *
 * Uses its own timer node (77) so removing it cannot disturb the shared `t` the rest of the
 * suite asserts on. */
const tabNode = makeNode(77);
await ext.nodeCreated(tabNode);
const tab = tabNode.__timer;
tab.view.root.boxWidth = 400; tab.view.root.boxHeight = 180;

const tabPrompt = makePrompt({ 77: ["WorkflowExecutionTimer", "Timer"], 42: ["KSampler", "My Sampler"] });
tabPrompt.workflow = { id: "wf-alpha" };
graph.id = "wf-alpha";

const tabRun = await globalThis.__api.queuePrompt(1, tabPrompt);
NOW = 2000000; emit("execution_start", { prompt_id: tabRun.prompt_id });
emit("executing", { node: "42", prompt_id: tabRun.prompt_id });
NOW = 2001500; pump();
check("run is going before the tab switch", tab.running && tab.view.total.textContent === "00:01:500", tab.view.total.textContent);

// leaving the tab: ComfyUI removes the node
tabNode.onRemoved();
graph._nodes.splice(graph._nodes.indexOf(tabNode), 1);
check("leaving the tab only stops painting", tab.running === false);

/* Coming back: the frontend builds the node the way it really does - `nodeCreated` fires
 * from the ComfyNode constructor, BEFORE the node is added to a graph and before
 * deserialisation assigns its id. Rejoining at that moment is impossible, so this models
 * the real sequence: construct, then assign id + graph, then onAdded. */
NOW = 2004000;
const returned = { type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
                   size: [0, 0], addDOMWidget() {}, graph: null, id: undefined };
await ext.nodeCreated(returned);
const back = returned.__timer;
back.view.root.boxWidth = 400; back.view.root.boxHeight = 180;
check("cannot rejoin at construction time (no id, no graph yet)", back.running === false);

returned.id = 77; returned.graph = graph; graph._nodes.push(returned);
returned.onAdded();                    // what LGraph.add() calls
pump();
check("the recreated node rejoins the run", back.running === true);
check("and shows the true elapsed time, not zero", back.view.total.textContent === "00:04:000", back.view.total.textContent);
check("and the node line survived too", back.view.detail.textContent.startsWith("My Sampler"), back.view.detail.textContent);

emit("executing", { node: "77", prompt_id: tabRun.prompt_id });
NOW = 2004200; pump();
check("later events reach the recreated node", back.view.detail.textContent.startsWith("Timer"), back.view.detail.textContent);

NOW = 2005000; emit("execution_success", { prompt_id: tabRun.prompt_id });
check("it stops with the whole run measured", !back.running && back.view.total.textContent === "00:05:000", back.view.total.textContent);
check("and comes to rest on the slowest node", back.view.detail.textContent.startsWith("slowest: "), back.view.detail.textContent);

// a same-id timer in a DIFFERENT workflow must not hijack a live run
const liveRun = await globalThis.__api.queuePrompt(1, tabPrompt);
NOW = 3000000; emit("execution_start", { prompt_id: liveRun.prompt_id });
/* A genuinely different workflow: its own graph, its own unrelated node ids, and a timer
 * that happens to reuse id 77. The run's other nodes are absent from this graph, which is
 * what identifies it as somewhere else. */
const otherGraph = { id: "wf-beta", _nodes: [{ id: 900 }, { id: 901 }], getNodeById() { return null; } };
const intruder = { type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
                   size: [0, 0], addDOMWidget() {}, graph: null, id: undefined };
await ext.nodeCreated(intruder);
intruder.id = 77; intruder.graph = otherGraph; otherGraph._nodes.push(intruder);
intruder.onAdded();
check("a same-id timer in another workflow does not hijack the run", intruder.__timer.running === false);
emit("execution_success", { prompt_id: liveRun.prompt_id });
intruder.onRemoved(); returned.onRemoved();
graph._nodes.splice(graph._nodes.indexOf(returned), 1);

// --- a run of a DIFFERENT workflow, queued from this tab ------------------------
const before = t.view.total.textContent;
const foreignOwn = await globalThis.__api.queuePrompt(1, makePrompt({ 3: ["CheckpointLoaderSimple"], 9: ["SaveImage"] }));
emit("execution_start", { prompt_id: foreignOwn.prompt_id });
emit("executing", { node: "3", prompt_id: foreignOwn.prompt_id });
NOW = 300000; pump();
check("ignores a workflow without this node", t.running === false && t.view.total.textContent === before, t.view.total.textContent);

// --- a run from ANOTHER TAB (never passed through our queuePrompt) --------------
emit("execution_start", { prompt_id: "foreign-tab-prompt" });
emit("executing", { node: "42", prompt_id: "foreign-tab-prompt" });
NOW = 310000; pump();
check("ignores another tab's run entirely", t.running === false && t.view.total.textContent === before, t.view.total.textContent);

// --- a detached node is never claimed ------------------------------------------
graph._nodes.splice(graph._nodes.indexOf(timerNode), 1);
timerNode.graph = null;
const afterRemoval = await globalThis.__api.queuePrompt(1, makePrompt({ 7: ["WorkflowExecutionTimer", "Timer"] }));
emit("execution_start", { prompt_id: afterRemoval.prompt_id });
check("a detached node is not claimed", t.running === false);
timerNode.graph = graph; graph._nodes.push(timerNode);

// --- error / interrupt ---------------------------------------------------------
const r3 = await globalThis.__api.queuePrompt(1, prompt1);
NOW = 400000; emit("execution_start", { prompt_id: r3.prompt_id });
NOW = 401234; emit("execution_error", { prompt_id: r3.prompt_id });
check("stops on error", t.running === false && t.view.total.textContent === "00:01:234", t.view.total.textContent);
check("says why it stopped", t.view.detail.textContent === "stopped on error", t.view.detail.textContent);

const r4 = await globalThis.__api.queuePrompt(1, prompt1);
NOW = 500000; emit("execution_start", { prompt_id: r4.prompt_id });
NOW = 500500; emit("execution_interrupted", { prompt_id: r4.prompt_id });
check("stops on interrupt", t.running === false && t.view.detail.textContent === "interrupted", t.view.detail.textContent);

// --- legacy finish signal ------------------------------------------------------
const r5 = await globalThis.__api.queuePrompt(1, prompt1);
NOW = 600000; emit("execution_start", { prompt_id: r5.prompt_id });
NOW = 600010; emit("executing", { node: null, prompt_id: r5.prompt_id });
check("legacy null-node finish stops it", t.running === false && t.view.total.textContent === "00:00:010", t.view.total.textContent);

// --- subgraph-flattened ids ----------------------------------------------------
const subPrompt = makePrompt({ 7: ["WorkflowExecutionTimer", "Timer"], "54:38": ["KSampler", "Inner Sampler"] });
const sub = await globalThis.__api.queuePrompt(1, subPrompt);
emit("execution_start", { prompt_id: sub.prompt_id });
check("a top-level timer claims its own run", t.running === true);
emit("executing", { node: "54:38", prompt_id: sub.prompt_id });
pump();
check("names a subgraph child by its title", t.view.detail.textContent.startsWith("Inner Sampler"), t.view.detail.textContent);
emit("execution_success", { prompt_id: sub.prompt_id });

// --- the sub-line goes back to idle when the run ends --------------------------
const r6 = await globalThis.__api.queuePrompt(1, prompt1);
NOW = 700000; emit("execution_start", { prompt_id: r6.prompt_id });
emit("executing", { node: "42", prompt_id: r6.prompt_id });
NOW = 700300; pump();
check("sub-line shows the node while running", t.view.detail.textContent.startsWith("My Sampler"), t.view.detail.textContent);
emit("execution_success", { prompt_id: r6.prompt_id });
check("sub-line drops the running node on completion",
      !t.view.detail.textContent.startsWith("My Sampler"), t.view.detail.textContent);
check("total is still frozen at the final value", t.view.total.textContent === "00:00:300", t.view.total.textContent);

// --- the header: previous total and the delta -----------------------------------
/* Left cell = the previous COMPLETED run, right cell = this run minus it, so the three
 * readings stay consistent: left + delta == the clock. Either cell reads N/A when its
 * number does not exist yet.
 *
 * Its own workflow, graph and node, because these checks depend on an exact run history
 * and the shared `t` has a long one by now. */
const hdrGraph = { _nodes: [], getNodeById() { return null; }, id: "wf-header" };
const hdrNode = {
    id: 5, type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
    graph: hdrGraph, size: [0, 0], widgets: [{ name: "full_red_minutes", value: 10 }],
    addDOMWidget(name, widgetType, element) { const w = { name, element }; this.widgets.push(w); return w; },
};
hdrGraph._nodes.push(hdrNode);
await ext.nodeCreated(hdrNode);
const h = hdrNode.__timer;
h.view.root.boxWidth = 400; h.view.root.boxHeight = 200;
const hdrPrompt = makePrompt({ 5: ["WorkflowExecutionTimer", "Timer"], 42: ["KSampler", "My Sampler"] });
hdrPrompt.workflow = { id: "wf-header" };
const LIGHT_GREEN = "hsl(120.0, 70.0%, 72.0%)";

check("both cells read N/A before any run",
      h.view.last.textContent === "N/A" && h.view.delta.textContent === "N/A",
      `${h.view.last.textContent} | ${h.view.delta.textContent}`);

// run 1 takes 4s, and has nothing to be compared against
const h1 = await globalThis.__api.queuePrompt(1, hdrPrompt);
NOW = 4_000_000; emit("execution_start", { prompt_id: h1.prompt_id });
NOW = 4_004_000; pump();
check("still N/A during the very first run",
      h.view.last.textContent === "N/A" && h.view.delta.textContent === "N/A");
emit("execution_success", { prompt_id: h1.prompt_id });
check("the first run leaves the header at N/A", h.view.last.textContent === "N/A");
check("and freezes its own total", h.view.total.textContent === "00:04:000", h.view.total.textContent);

// run 2 is slower: 6s against 4s
const h2 = await globalThis.__api.queuePrompt(1, hdrPrompt);
NOW = 5_000_000; emit("execution_start", { prompt_id: h2.prompt_id });
check("the second run shows the first run's total on the left", h.view.last.textContent === "00:04:000", h.view.last.textContent);
pump();
check("the delta starts at minus the previous total", h.view.delta.textContent === "-00:04:000", h.view.delta.textContent);
check("and is light green there", h.view.delta.style.color === LIGHT_GREEN, h.view.delta.style.color);
NOW = 5_002_000; pump();
check("halfway through last time's budget the delta is amber",
      h.view.delta.textContent === "-00:02:000" && /^hsl\(60\.0,/.test(h.view.delta.style.color),
      `${h.view.delta.textContent} ${h.view.delta.style.color}`);
NOW = 5_004_000; pump();
check("matching last time's total turns the delta red",
      h.view.delta.textContent === "+00:00:000" && h.view.delta.style.color === RED,
      `${h.view.delta.textContent} ${h.view.delta.style.color}`);
NOW = 5_006_000; pump();
check("and it stays red however far the run overruns",
      h.view.delta.textContent === "+00:02:000" && h.view.delta.style.color === RED,
      `${h.view.delta.textContent} ${h.view.delta.style.color}`);
check("left + delta equals the clock", h.view.total.textContent === "00:06:000", h.view.total.textContent);

// the delta's hue only ever falls, over the whole range it is drawn across
const deltaHues = [0, 1000, 2000, 3000, 4000, 5000].map((ms) => {
    NOW = 5_000_000 + ms; pump();
    return parseFloat(h.view.delta.style.color.slice(4));
});
check("the delta's hue falls monotonically toward red",
      deltaHues.every((hue, i, a) => i === 0 || hue <= a[i - 1]), deltaHues.join(" -> "));

NOW = 5_006_000; pump();
emit("execution_success", { prompt_id: h2.prompt_id });
check("a finished run still compares against the previous one, not itself",
      h.view.last.textContent === "00:04:000" && h.view.delta.textContent === "+00:02:000",
      `${h.view.last.textContent} | ${h.view.delta.textContent}`);

// the left cell is coloured by the same rule as the clock, i.e. by full_red_minutes
const hdrRed = hdrNode.widgets.find((w) => w.name === "full_red_minutes");
hdrRed.value = 0.1;                    // 6 seconds, so the 4s baseline lands well up the ramp
h.render();
check("the previous-total cell follows full_red_minutes", /^hsl\(40\.0,/.test(h.view.last.style.color), h.view.last.style.color);
hdrRed.value = 10;
h.render();
check("and goes back to near-green at 10 minutes", /^hsl\(119\./.test(h.view.last.style.color), h.view.last.style.color);

// run 3 is far faster than run 2: 0.6s against 6s
const h3 = await globalThis.__api.queuePrompt(1, hdrPrompt);
NOW = 6_000_000; emit("execution_start", { prompt_id: h3.prompt_id });
check("the third run's baseline is the second run", h.view.last.textContent === "00:06:000", h.view.last.textContent);
NOW = 6_000_600; emit("execution_success", { prompt_id: h3.prompt_id });
check("a much faster run reads minus and stays green",
      h.view.delta.textContent === "-00:05:400" && parseFloat(h.view.delta.style.color.slice(4)) > 100,
      `${h.view.delta.textContent} ${h.view.delta.style.color}`);

/* A run that did not finish is not how long the workflow takes, so it must not become the
 * baseline - otherwise one cancelled run poisons the next comparison. */
const h4 = await globalThis.__api.queuePrompt(1, hdrPrompt);
NOW = 7_000_000; emit("execution_start", { prompt_id: h4.prompt_id });
NOW = 7_030_000; emit("execution_error", { prompt_id: h4.prompt_id });
const h5 = await globalThis.__api.queuePrompt(1, hdrPrompt);
NOW = 8_000_000; emit("execution_start", { prompt_id: h5.prompt_id });
check("a failed run does not become the baseline", h.view.last.textContent === "00:00:600", h.view.last.textContent);
NOW = 8_010_000; emit("execution_interrupted", { prompt_id: h5.prompt_id });
const h6 = await globalThis.__api.queuePrompt(1, hdrPrompt);
NOW = 9_000_000; emit("execution_start", { prompt_id: h6.prompt_id });
check("nor does an interrupted one", h.view.last.textContent === "00:00:600", h.view.last.textContent);
NOW = 9_000_500; emit("execution_success", { prompt_id: h6.prompt_id });

/* Switching workflow tabs while IDLE destroys and rebuilds the node, so the baseline is kept
 * per workflow rather than on the timer - otherwise the comparison resets every time you look
 * at another tab. tryRejoin only covers a run still in flight. */
hdrNode.onRemoved();
hdrGraph._nodes.splice(hdrGraph._nodes.indexOf(hdrNode), 1);
const hdrBack = {
    id: 5, type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
    graph: null, size: [0, 0], widgets: [{ name: "full_red_minutes", value: 10 }], addDOMWidget() {},
};
await ext.nodeCreated(hdrBack);
check("a node rebuilt before it has a graph does not borrow another workflow's history",
      hdrBack.__timer.view.last.textContent === "N/A", hdrBack.__timer.view.last.textContent);
hdrBack.graph = hdrGraph; hdrGraph._nodes.push(hdrBack);
hdrBack.onAdded();
check("once it has one, it recovers the workflow's last total",
      hdrBack.__timer.view.last.textContent === "00:00:500", hdrBack.__timer.view.last.textContent);
check("but has no current time of its own to compare yet",
      hdrBack.__timer.view.delta.textContent === "N/A", hdrBack.__timer.view.delta.textContent);
hdrBack.onRemoved();

/* The header holds two numbers side by side, so it runs out of width long before the clock:
 * a narrow node must scale it down rather than let the cells collide. */
h.baseline = 754_321;        // nine characters on the left, ten on the right
h.frozenTotal = 1_500_000;
h.render();
h.view.root.boxWidth = 170; h.view.root.boxHeight = 200;
// straight to fit(): this node has been through onRemoved, so its observer is disconnected
h.fitKey = ""; h.fit();
check("a narrow node shrinks the header to fit its two numbers",
      h.view.last.scrollWidth + h.view.delta.scrollWidth <= 170,
      `${h.view.last.textContent} + ${h.view.delta.textContent} = ${h.view.last.scrollWidth + h.view.delta.scrollWidth}px in 170px`);

// --- a long node name wraps rather than being cut off ---------------------------
/* nowrap plus an ellipsis used to be the whole story, so a node called "Ultimate SD Upscale
 * With Model..." read as "Ultimate SD Up…". It now wraps onto a second line when one is not
 * enough AND the node can spare the height without shrinking the clock; where it cannot, the
 * name is clamped rather than allowed to overflow. */
const longTitle = "Ultimate SD Upscale With Model And Tiled VAE Decode";
const wrapPrompt = makePrompt({ 7: ["WorkflowExecutionTimer", "Timer"], 99: ["KSampler", longTitle] });
const wrapRun = await globalThis.__api.queuePrompt(1, wrapPrompt);
sizeTo(320, 220);
NOW = 10_000_000; emit("execution_start", { prompt_id: wrapRun.prompt_id });
emit("executing", { node: "99", prompt_id: wrapRun.prompt_id });
NOW = 10_000_100; pump();
check("a long node name wraps onto a second line", t.view.detail.style.webkitLineClamp === "2",
      `clamp ${t.view.detail.style.webkitLineClamp}`);
check("the full name is in the text, not truncated", t.view.detail.textContent.startsWith(longTitle),
      t.view.detail.textContent);
check("and is on the tooltip as well", t.view.detail.title.startsWith(t.view.detail.textContent), t.view.detail.title);
const wrapped = verticalUse(320, 220);
check("two lines still fit inside the node", wrapped.used <= wrapped.h && wrapped.lines === 2,
      `${wrapped.used.toFixed(1)} <= ${wrapped.h} on ${wrapped.lines} line(s)`);

// the wrap has to follow the text, and the text changes without any resize
emit("executing", { node: "7", prompt_id: wrapRun.prompt_id });
NOW = 10_000_200; pump();
check("a short name goes back to one line with no resize", t.view.detail.style.webkitLineClamp === "1",
      t.view.detail.textContent);
emit("executing", { node: "99", prompt_id: wrapRun.prompt_id });
NOW = 10_000_300; pump();
check("and the long one wraps again", t.view.detail.style.webkitLineClamp === "2", t.view.detail.textContent);

/* Where the second line would have to come out of the counter, it is not worth it. */
const tight = verticalUse(320, 92);
check("a short node clamps the long name instead of shrinking the clock",
      tight.lines === 1 && tight.used <= tight.h, `${tight.used.toFixed(1)} <= ${tight.h} on ${tight.lines} line(s)`);

const longOverflow = boxes.map((b) => verticalUse(...b)).filter((r) => r.used > r.h);
check("no box overflows while a long name is showing", longOverflow.length === 0,
      longOverflow.map((r) => `${r.h}px using ${r.used.toFixed(1)}px`).join("; "));

emit("execution_success", { prompt_id: wrapRun.prompt_id });
sizeTo(400, 180);

// --- nested subgraphs, and a timer that lives inside one ------------------------
/* The prompt is flat: every executed node is a key, nested ones as "<a>:<b>:<c>". So the
 * sub-line can name any node in the run regardless of depth, and the timer itself works
 * whether it sits at the top level or inside a subgraph. */
const deepPrompt = makePrompt({
    42: ["KSampler", "My Sampler"],
    54: ["Subgraph", "Render Group"],
    "54:38": ["KSampler", "Inner Sampler"],
    "54:60": ["Subgraph", "Upscale Group"],
    "54:60:11": ["ImageScale", "Deep Upscale"],
    "54:9": ["WorkflowExecutionTimer", "Nested Timer"],
});

// a timer living inside subgraph 54 with local id 9
const subgraphGraph = { _nodes: [], getNodeById() { return null; } };
const nestedTimerNode = { id: 9, type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
                          graph: subgraphGraph, size: [0, 0], addDOMWidget() {} };
await ext.nodeCreated(nestedTimerNode);
const nested = nestedTimerNode.__timer;
nested.view.root.boxWidth = 400; nested.view.root.boxHeight = 180;

const deep = await globalThis.__api.queuePrompt(1, deepPrompt);
NOW = 800000; emit("execution_start", { prompt_id: deep.prompt_id });
check("a timer inside a subgraph claims the run", nested.running === true);
check("a top-level timer not in that prompt stays idle", t.running === false);

emit("executing", { node: "42", prompt_id: deep.prompt_id });
NOW = 800100; pump();
check("nested timer names a TOP-LEVEL node", nested.view.detail.textContent.startsWith("My Sampler"), nested.view.detail.textContent);

emit("executing", { node: "54:38", prompt_id: deep.prompt_id });
pump();
check("nested timer names a sibling in its own subgraph", nested.view.detail.textContent.startsWith("Inner Sampler"), nested.view.detail.textContent);

emit("executing", { node: "54:60:11", prompt_id: deep.prompt_id });
pump();
check("names a two-level-deep node", nested.view.detail.textContent.startsWith("Deep Upscale"), nested.view.detail.textContent);

// an id the prompt does not carry verbatim still reads as a path
emit("executing", { node: "54:60:999", prompt_id: deep.prompt_id });
pump();
check("unknown nested id reads as a path", nested.view.detail.textContent.startsWith("Render Group / Upscale Group / 999"), nested.view.detail.textContent);

emit("execution_success", { prompt_id: deep.prompt_id });
check("nested timer comes to rest too", nested.view.detail.textContent.startsWith("slowest: "), nested.view.detail.textContent);

// a top-level timer must NOT be claimed by a subgraph child that shares its local id
const decoy = makePrompt({ "54:7": ["KSampler", "Coincidence"] });
const decoyRun = await globalThis.__api.queuePrompt(1, decoy);
emit("execution_start", { prompt_id: decoyRun.prompt_id });
check("top-level timer ignores a same-id subgraph child", t.running === false);
t.stop();
nested.stop();

// --- recovering a run whose start was missed ------------------------------------
/* execution_start is the only event that starts the clock, and one missed one used to cost
 * the entire run: every per-node handler asks `if (timer.running)` first, so the timer sat at
 * its old frozen value while the workflow ran to completion. It can genuinely be missed - a
 * websocket reconnect, a queue of runs where the frontend batches faster than the responses
 * come back, an interrupt-and-rerun arriving out of order. Any per-node event is proof the run
 * is going, since nodes do not execute outside one. */
const recGraph = { _nodes: [], getNodeById() { return null; }, id: "wf-recover" };
function recoveryNode(id) {
    const node = {
        id, type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
        graph: recGraph, size: [0, 0], widgets: [{ name: "full_red_minutes", value: 10 }],
        addDOMWidget(name, ty, element) { const w = { name, element }; this.widgets.push(w); return w; },
    };
    recGraph._nodes.push(node);
    return node;
}
function recoveryPrompt() {
    const prompt = makePrompt({ 3: ["WorkflowExecutionTimer", "Timer"], 42: ["KSampler", "My Sampler"] });
    prompt.workflow = { id: "wf-recover" };
    return prompt;
}
const recNode = recoveryNode(3);
await ext.nodeCreated(recNode);
const rec = recNode.__timer;
rec.view.root.boxWidth = 400; rec.view.root.boxHeight = 200;

// 1. recovered from "executing", with NO execution_start at all
const missed = await globalThis.__api.queuePrompt(1, recoveryPrompt());
NOW = 20_000_000;
emit("executing", { node: "42", prompt_id: missed.prompt_id });
check("a missed execution_start is recovered from an executing event", rec.running === true);
NOW = 20_000_400; pump();
check("and the sub-line names the node it recovered from", rec.view.detail.textContent.startsWith("My Sampler"), rec.view.detail.textContent);
check("the recovered run counts up", rec.view.total.textContent === "00:00:400", rec.view.total.textContent);
check("and says on the counter that its total is short", /already under way/.test(rec.view.total.title), rec.view.total.title);
NOW = 20_001_000; emit("execution_success", { prompt_id: missed.prompt_id });
check("a recovered run still stops cleanly", rec.running === false && !rec.view.detail.textContent.startsWith("My Sampler"),
      rec.view.detail.textContent);

// a total that is missing its start must not become the baseline for the next comparison
const after = await globalThis.__api.queuePrompt(1, recoveryPrompt());
NOW = 21_000_000; emit("execution_start", { prompt_id: after.prompt_id });
check("a recovered run does not poison the baseline", rec.view.last.textContent === "N/A", rec.view.last.textContent);
check("and a normally started run is exact again", rec.view.total.title === "", rec.view.total.title);
NOW = 21_002_000; emit("execution_success", { prompt_id: after.prompt_id });

// 2. recovered from progress_state alone
const viaState = await globalThis.__api.queuePrompt(1, recoveryPrompt());
NOW = 22_000_000;
emit("progress_state", { prompt_id: viaState.prompt_id, nodes: { 42: { node_id: "42", state: "running" } } });
check("progress_state alone also recovers the run", rec.running === true);
NOW = 22_000_250; pump();
check("and names the node", rec.view.detail.textContent === "My Sampler — 00:00:250", rec.view.detail.textContent);
emit("execution_success", { prompt_id: viaState.prompt_id });

// 3. recovered from a bare progress event, the most frequent event of a run
const viaProgress = await globalThis.__api.queuePrompt(1, recoveryPrompt());
NOW = 23_000_000;
emit("progress", { prompt_id: viaProgress.prompt_id, node: "42", value: 3, max: 20 });
check("a sampler progress event recovers the run too", rec.running === true);
emit("execution_success", { prompt_id: viaProgress.prompt_id });

/* 4. Several runs queued back to back, with the POST responses stalled. The pending slot used
 * to be a single variable, so each queue call overwrote the one before it and every prompt but
 * the last lost its only chance of being adopted. */
let releaseAll;
holdResponse = new Promise((r) => { releaseAll = r; });
const first = globalThis.__api.queuePrompt(1, recoveryPrompt());
const second = globalThis.__api.queuePrompt(1, recoveryPrompt());
NOW = 24_000_000;
emit("execution_start", { prompt_id: "queued-a" });
check("the first of several queued runs is adopted", rec.running === true);
NOW = 24_000_500; emit("execution_success", { prompt_id: "queued-a" });
check("and it measured its own time", rec.view.total.textContent === "00:00:500", rec.view.total.textContent);
NOW = 24_001_000;
emit("execution_start", { prompt_id: "queued-b" });
check("the second one is still adoptable, not overwritten", rec.running === true);
NOW = 24_001_750; emit("execution_success", { prompt_id: "queued-b" });
check("and measured its own time as well", rec.view.total.textContent === "00:00:750", rec.view.total.textContent);
releaseAll(); await first; await second; holdResponse = null;

// adoption on a per-node event needs the node to actually be in the pending prompt
holdResponse = new Promise((r) => { releaseAll = r; });
const guarded = globalThis.__api.queuePrompt(1, recoveryPrompt());
emit("executing", { node: "8888", prompt_id: "someone-elses-prompt" });
check("a per-node event for a node we do not have claims nothing", rec.running === false);
emit("executing", { node: "42", prompt_id: "ours-after-all" });
check("but one naming a node we do have is adopted", rec.running === true);
releaseAll(); await guarded; holdResponse = null;
emit("execution_success", { prompt_id: "ours-after-all" });

/* 5. Stopping when nothing said the run was over. Clearing the queue discards pending prompts
 * silently, and an interrupt does not always reach this client as execution_interrupted, so a
 * timer could count up forever. queue_remaining is pending + running on the server: zero means
 * whatever we are counting has ended. */
const stranded = await globalThis.__api.queuePrompt(1, recoveryPrompt());
NOW = 25_000_000; emit("execution_start", { prompt_id: stranded.prompt_id });
NOW = 25_003_000; pump();
check("a run with no ending event keeps counting", rec.running === true && rec.view.total.textContent === "00:03:000");
emit("status", { exec_info: { queue_remaining: 2 } });
check("a non-empty queue leaves it alone", rec.running === true);
emit("status", { exec_info: { queue_remaining: 0 } });
check("an empty queue stops the stranded timer", rec.running === false && rec.view.total.textContent === "00:03:000",
      rec.view.total.textContent);
check("and says so rather than claiming a clean finish", rec.view.detail.textContent === "stopped", rec.view.detail.textContent);
recNode.onRemoved();

// --- the per-node breakdown, and the two ways to copy it ------------------------
/* Every node is already timed for the sub-line; the totals are now kept, so an idle timer can
 * report the one node most worth looking at and the whole table can go to the clipboard. */
const bdGraph = { _nodes: [], getNodeById() { return null; }, id: "wf-breakdown" };
const bdNode = {
    id: 6, type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
    graph: bdGraph, size: [0, 0], widgets: schemaWidgets(), title: "Run timer",
    addDOMWidget(name, ty, element) { const w = { name, element }; this.widgets.push(w); return w; },
    addWidget(ty, name, value, callback, options) { const w = { name, type: ty, value, callback, options }; this.widgets.push(w); return w; },
    setDirtyCanvas() {},
};
bdGraph._nodes.push(bdNode);
await ext.nodeCreated(bdNode);
const bd = bdNode.__timer;
bd.view.root.boxWidth = 400; bd.view.root.boxHeight = 200;
const bdPrompt = makePrompt({
    6: ["WorkflowExecutionTimer", "Run timer"],
    11: ["CheckpointLoaderSimple", "Load Model"],
    12: ["KSampler", "Big Sampler"],
    13: ["VAEDecode", "Decode"],
});
bdPrompt.workflow = { id: "wf-breakdown" };

const bdRun = await globalThis.__api.queuePrompt(1, bdPrompt);
NOW = 30_000_000; emit("execution_start", { prompt_id: bdRun.prompt_id });
emit("executing", { node: "11", prompt_id: bdRun.prompt_id });      // Load Model: 1s
NOW = 30_001_000; emit("executing", { node: "12", prompt_id: bdRun.prompt_id });  // Big Sampler: 4s
NOW = 30_005_000; emit("executing", { node: "13", prompt_id: bdRun.prompt_id });  // Decode: 0.5s
NOW = 30_005_500; emit("executing", { node: "12", prompt_id: bdRun.prompt_id });  // Big Sampler again: 2s
NOW = 30_007_500; emit("execution_success", { prompt_id: bdRun.prompt_id });

check("the idle sub-line names the slowest node",
      bd.view.detail.textContent === "slowest: Big Sampler — 00:06:000", bd.view.detail.textContent);
check("a node that ran twice has its times added up",
      bd.breakdown[0][0] === "Big Sampler" && Math.round(bd.breakdown[0][1]) === 6000,
      bd.breakdown.map(([n, ms]) => `${n}=${Math.round(ms)}`).join(" "));
check("and the rest are ordered biggest first",
      bd.breakdown.map(([n]) => n).join(" > ") === "Big Sampler > Load Model > Decode",
      bd.breakdown.map(([n]) => n).join(" > "));

const report = bd.breakdownText();
check("the clipboard text leads with the node title and the total",
      report.startsWith("Run timer  total 00:07:500"), report.split("\n")[0]);
check("every node appears with a share of the total",
      report.includes("00:06:000") && /80\.0%/.test(report), report.split("\n")[1]);
check("and it says why cached nodes are missing", /cache/.test(report));

check("the sub-line advertises the click", /click to copy/.test(bd.view.detail.title), bd.view.detail.title);
check("and shows a pointer cursor", bd.view.detail.style.cursor === "pointer");

// path 1: clicking the sub-line
copied = null;
bd.view.detail.fire("click");
check("clicking the sub-line copies the breakdown", copied === report, String(copied).split("\n")[0]);
await Promise.resolve();   // the clipboard write resolves on a microtask; the confirmation follows it
check("and confirms it in place", bd.view.detail.textContent === "breakdown copied", bd.view.detail.textContent);

// path 2: the node's right-click menu
copied = null;
const menu = [];
bdNode.getExtraMenuOptions({}, menu);
const entry = menu.find((option) => option.content === "Copy timing breakdown");
check("the right-click menu offers the breakdown", entry != null && entry.disabled === false);
entry.callback();
check("and the menu entry copies the same text", copied === report);

// a node that has never finished a run has nothing to offer
const emptyNode = makeNode(402);
await ext.nodeCreated(emptyNode);
const emptyMenu = [];
emptyNode.getExtraMenuOptions({}, emptyMenu);
check("with no finished run the menu entry is disabled",
      emptyMenu.find((o) => o.content === "Copy timing breakdown")?.disabled === true);
copied = null;
emptyNode.__timer.view.detail.fire("click");
check("and clicking the sub-line copies nothing", copied === null);
check("nor does it offer a pointer", emptyNode.__timer.view.detail.style.cursor === "default");
emptyNode.onRemoved();
graph._nodes.splice(graph._nodes.indexOf(emptyNode), 1);

// --- the progress bar -----------------------------------------------------------
/* elapsed / previous total, along the bottom edge, coloured by the same rule as the delta so the
 * bar and the number cannot disagree. Absolutely positioned, so it costs the line budget
 * nothing - which is why fit() never mentions it. */
check("no bar without a previous run to measure against", bd.view.bar.style.display === "none");

const barRun = await globalThis.__api.queuePrompt(1, bdPrompt);
NOW = 31_000_000; emit("execution_start", { prompt_id: barRun.prompt_id });
pump();
check("the bar starts empty", bd.view.bar.style.width === "0.0%", bd.view.bar.style.width);
check("and light green", bd.view.bar.style.backgroundColor === LIGHT_GREEN, bd.view.bar.style.backgroundColor);
NOW = 31_003_750; pump();     // half of the 7.5s the last run took
check("it fills as the run approaches last time's total", bd.view.bar.style.width === "50.0%", bd.view.bar.style.width);
check("and is amber halfway", /^hsl\(60\.0,/.test(bd.view.bar.style.backgroundColor), bd.view.bar.style.backgroundColor);
NOW = 31_007_500; pump();
check("it is full and red at last time's total",
      bd.view.bar.style.width === "100.0%" && bd.view.bar.style.backgroundColor === RED,
      `${bd.view.bar.style.width} ${bd.view.bar.style.backgroundColor}`);
NOW = 31_030_000; pump();
check("and does not overflow when the run overruns", bd.view.bar.style.width === "100.0%", bd.view.bar.style.width);
check("the bar agrees with the delta's colour", bd.view.bar.style.backgroundColor === bd.view.delta.style.color);
emit("execution_success", { prompt_id: barRun.prompt_id });
check("the bar stays at the final value rather than vanishing",
      bd.view.bar.style.display !== "none" && bd.view.bar.style.width === "100.0%");

// --- the baseline survives a page reload ----------------------------------------
/* In memory it survived a tab switch; in localStorage it survives a refresh, which on a workflow
 * you run a few times a day is the case that actually came up. */
check("the last total was written to storage",
      JSON.parse(storage.get("comfy-workflow-timer:last-totals"))["wf-breakdown"] === 30000,
      storage.get("comfy-workflow-timer:last-totals"));

/* And read back: a node dropped into a workflow whose time was recorded in an earlier browser
 * session starts out knowing it, without having run anything. */
const restoredGraph = { _nodes: [], getNodeById() { return null; }, id: "wf-restored" };
const restoredNode = {
    id: 8, type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
    graph: null, size: [0, 0], widgets: schemaWidgets(), addDOMWidget() {},
    addWidget(ty, name, value, callback, options) { const w = { name, type: ty, value, callback, options }; this.widgets.push(w); return w; },
    setDirtyCanvas() {},
};
await ext.nodeCreated(restoredNode);
restoredNode.graph = restoredGraph; restoredGraph._nodes.push(restoredNode);
restoredNode.onAdded();
check("a time saved in a previous session is restored on load",
      restoredNode.__timer.view.last.textContent === "00:12:345",
      restoredNode.__timer.view.last.textContent);
restoredNode.onRemoved();

// --- resetting the previous run time --------------------------------------------
/* The number lives in the per-workflow map, its localStorage copy, each timer's own field and the
 * record of any run in flight; leaving any one behind would have it reappear. A second timer on
 * the same workflow is included on purpose - the value belongs to the workflow, not to one node. */
const sibling = {
    id: 9, type: "WorkflowExecutionTimer", comfyClass: "WorkflowExecutionTimer",
    graph: bdGraph, size: [0, 0], widgets: schemaWidgets(), addDOMWidget() {},
    addWidget(ty, name, value, callback, options) { const w = { name, type: ty, value, callback, options }; this.widgets.push(w); return w; },
    setDirtyCanvas() {},
};
bdGraph._nodes.push(sibling);
await ext.nodeCreated(sibling);
sibling.onAdded();
check("a second timer on the workflow sees the same previous time",
      sibling.__timer.view.last.textContent === "00:30:000", sibling.__timer.view.last.textContent);

const resetMenu = [];
bdNode.getExtraMenuOptions({}, resetMenu);
const resetEntry = resetMenu.find((option) => option.content === "Reset previous run time");
check("the right-click menu offers the reset", resetEntry != null && resetEntry.disabled === false);
resetEntry.callback();

check("the header goes back to N/A", bd.view.last.textContent === "N/A" && bd.view.delta.textContent === "N/A",
      `${bd.view.last.textContent} | ${bd.view.delta.textContent}`);
check("and the progress bar has nothing left to measure", bd.view.bar.style.display === "none");
check("the sibling forgets it too", sibling.__timer.view.last.textContent === "N/A",
      sibling.__timer.view.last.textContent);
check("it is gone from storage as well",
      JSON.parse(storage.get("comfy-workflow-timer:last-totals"))["wf-breakdown"] === undefined,
      storage.get("comfy-workflow-timer:last-totals"));
check("the breakdown is deliberately kept", bd.view.detail.textContent.startsWith("slowest: "),
      bd.view.detail.textContent);

const emptiedMenu = [];
bdNode.getExtraMenuOptions({}, emptiedMenu);
check("with nothing left to forget the entry is disabled",
      emptiedMenu.find((o) => o.content === "Reset previous run time")?.disabled === true);

// and a later run starts the comparison again from scratch
const freshRun = await globalThis.__api.queuePrompt(1, bdPrompt);
NOW = 32_000_000; emit("execution_start", { prompt_id: freshRun.prompt_id });
check("the next run has no baseline to compare against", bd.view.last.textContent === "N/A");
emit("executing", { node: "12", prompt_id: freshRun.prompt_id });
NOW = 32_002_000; emit("execution_success", { prompt_id: freshRun.prompt_id });
const afterReset = await globalThis.__api.queuePrompt(1, bdPrompt);
NOW = 33_000_000; emit("execution_start", { prompt_id: afterReset.prompt_id });
check("and the run after it compares against that one", bd.view.last.textContent === "00:02:000",
      bd.view.last.textContent);
emit("execution_success", { prompt_id: afterReset.prompt_id });

sibling.onRemoved();
bdGraph._nodes.splice(bdGraph._nodes.indexOf(sibling), 1);
bdNode.onRemoved();
bdGraph._nodes.splice(bdGraph._nodes.indexOf(bdNode), 1);

// --- ownership map does not grow without bound ---------------------------------
const stale = await globalThis.__api.queuePrompt(1, prompt1);
// only prompts that contain this node are ever recorded, so the filler must too
for (let i = 0; i < 70; i++) await globalThis.__api.queuePrompt(1, prompt1);
emit("execution_start", { prompt_id: stale.prompt_id });
check("evicts old prompts (map is capped)", t.running === false);

rmSync(sandbox, { recursive: true, force: true });
console.log("=".repeat(74));
console.log(failures ? `${failures} FAILURE(S)` : "all checks passed");
process.exit(failures ? 1 : 0);
