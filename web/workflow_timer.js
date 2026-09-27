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

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/*
 * Workflow Execution Timer
 *
 * Total elapsed time for THIS workflow's run, MM:SS:mmm, live, in Oxanium, fading
 * light green -> red over the number of minutes set by the widget at the bottom of the
 * node, plus a smaller line naming the node being executed right now and how long it has
 * been running. Both lines scale with the node.
 *
 * Only this workflow's runs count. Getting that right is the whole reason for the
 * `owners` map below -- see "Deciding whether a run is ours".
 */

const NODE_TYPE = "WorkflowExecutionTimer";
// the widget declared in nodes.py; its value is where the colour ramp ends, in minutes
const RED_WIDGET = "full_red_minutes";
const DEFAULT_FULL_RED_MINUTES = 10;
// a ramp cannot end at zero, and a value that small is indistinguishable from it anyway
const MIN_FULL_RED_MINUTES = 0.1;
/* The Google Fonts `family=` value, editable on the node. Oxanium is a variable face
 * (200-800), so the real 700 the counter asks for exists and the browser never has to
 * synthesise one; 400 is for the smaller lines. */
const FONT_WIDGET = "font_spec";
const DEFAULT_FONT_SPEC = "Oxanium:wght@400;700";
// the JS-only button that shows and hides every setting below it
const SETTINGS_TOGGLE = "settings";
// the monospace fallback matters for an offline install: Oxanium is proportional, and
// tabular-nums below only applies if the loaded face actually carries the tnum feature
const FALLBACK_FONTS = "'Courier New', monospace";
// for the sub-line and for a header cell that has nothing to say yet
const MUTED = "#8d97a8";
const NONE = "N/A";
/* The sub-line wraps rather than truncating when a node title is too long for the node's
 * width - but only so far, or one verbose title would crowd out the clock. -webkit-box is
 * what -webkit-line-clamp needs to apply; it is the de facto way to cap a wrapped block at
 * n lines and still get an ellipsis on the last one. */
const DETAIL_MAX_LINES = 2;
const DETAIL_DISPLAY = "-webkit-box";
/* The header's display value, as a CONSTANT because fit() has to restore it by name.
 * Assigning `style.display = ""` to un-hide an element DELETES the inline property, and
 * with `flex` gone the two cells become block divs that stack on separate lines - and,
 * being full-width blocks, report the container's width as their scrollWidth, so the
 * width correction then sees ~2x overflow and halves the font. One assignment, both
 * symptoms. The sub-line already restores DETAIL_DISPLAY for exactly this reason. */
const HEADER_DISPLAY = "flex";
// the fraction of its size the counter must keep for a second sub-line to be worth having
const WRAP_CLOCK_KEEP = 0.8;
/* Room for three lines plus the one widget row that is always there, the settings button. Wider
 * than it is tall because the header puts two nine-digit numbers side by side; below this fit()
 * starts shrinking them, and then dropping lines. */
const MIN_SIZE = [230, 132];
const WIDGET_ROW = 26;      // roughly what one widget costs the node's body

/* ------------------------------------------------------------------ font --- */

/* A `family=` value as Google Fonts wants it: "Oxanium:wght@400;700",
 * "Roboto+Mono:ital,wght@0,400;1,700".
 *
 * Whitespace becomes "+", and anything outside the small set of characters the syntax actually
 * uses is DROPPED rather than escaped. This value is interpolated into a URL query and, via the
 * family name, into a CSS font-family - an unescaped "&" would silently add a query parameter,
 * and a quote would break out of the style string. Neither belongs in a font spec, so throwing
 * them away is both safe and easier to diagnose than a mangled URL. */
function cleanSpec(spec) {
    const text = String(spec ?? "")
        .trim()
        .replace(/\s+/g, "+")
        .replace(/[^A-Za-z0-9+:;,@._-]/g, "");
    return text || DEFAULT_FONT_SPEC;
}

/* The family name for the CSS stack: everything before the first ":", "+" back to spaces. */
function familyOf(spec) {
    const family = cleanSpec(spec).split(":")[0].replace(/\+/g, " ").trim();
    return /^[A-Za-z0-9 ._-]+$/.test(family) ? family : "Oxanium";
}

function fontStackFor(spec) {
    return `'${familyOf(spec)}', ${FALLBACK_FONTS}`;
}

/* One <link> per distinct spec, kept for the life of the page.
 *
 * Per spec rather than one shared link, because the setting is per node: two timers asking for
 * different fonts both have to work, and rewriting a single link's href would make the last one
 * to change win for everybody. Stylesheets are tiny and the browser dedupes the font binaries.
 */
const fontLinks = new Map();   // cleaned spec -> link element
let preconnected = false;

function preconnect() {
    if (preconnected) return;
    preconnected = true;
    // the stylesheet lives on fonts.googleapis.com but the font binaries come from
    // fonts.gstatic.com, so both handshakes are worth starting early
    for (const [href, crossorigin] of [
        ["https://fonts.googleapis.com", false],
        ["https://fonts.gstatic.com", true],
    ]) {
        const pre = document.createElement("link");
        pre.rel = "preconnect";
        pre.href = href;
        if (crossorigin) pre.crossOrigin = "anonymous";
        document.head.appendChild(pre);
    }
}

function ensureFont(spec) {
    const clean = cleanSpec(spec);
    if (fontLinks.has(clean)) return clean;
    preconnect();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${clean}&display=swap`;
    // an offline / air-gapped install just falls through to FALLBACK_FONTS
    link.onerror = () => console.warn(`[WorkflowTimer] "${clean}" could not be fetched; using the fallback font.`);
    // the face only becomes real once the stylesheet lands, and every width measured before
    // that was measured against the fallback
    link.onload = () => refitAll();
    document.head.appendChild(link);
    fontLinks.set(clean, link);
    return clean;
}

function refitAll() {
    for (const node of instances) {
        const timer = node.__timer;
        if (!timer) continue;
        timer.fitKey = "";
        timer.fit();
    }
}

/* ----------------------------------------------------------- formatting --- */

function formatMs(ms) {
    if (!(ms >= 0)) ms = 0;
    const total = Math.floor(ms);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(millis).padStart(3, "0")}`;
}

/* Signed MM:SS:mmm, for the delta. */
function formatDelta(ms) {
    return `${ms < 0 ? "-" : "+"}${formatMs(Math.abs(ms))}`;
}

/* The one gradient, light green (t=0) -> pure red (t=1).
 *
 * Interpolated in HSL rather than RGB: hue 120 -> 0 walks green, yellow, orange, red,
 * which is the ramp people expect from a timer. The same trip in RGB would pass
 * through a muddy olive and read as "broken" rather than "getting late".
 *
 * Shared by the clock and the delta so that "light green" and "red" mean the same two
 * colours in both, rather than two ramps that merely look similar. */
function hslRamp(t) {
    const u = Math.min(1, Math.max(0, t));
    const hue = 120 * (1 - u);
    const saturation = 70 + 30 * u;   // 70% -> 100%, red arrives saturated
    const lightness = 72 - 22 * u;    // 72% (light green) -> 50% (pure red)
    return `hsl(${hue.toFixed(1)}, ${saturation.toFixed(1)}%, ${lightness.toFixed(1)}%)`;
}

/* Elapsed time: light green at zero, fully red from fullRedMs on. */
function rampColour(ms, fullRedMs) {
    return hslRamp(ms / fullRedMs);
}

/* The delta (this run minus the previous one), ramped over the previous run's duration.
 *
 * `span` is that duration, which makes the gradient mean "how far through last time's
 * budget are we": at the very start of a run the delta is exactly -span, so the colour is
 * light green; it walks to red as the clock approaches what the last run took; and from the
 * moment this run is the slower one - delta >= 0 - it is red and stays red however far it
 * overruns. Scaling by the previous run rather than by full_red_minutes is what keeps that
 * true for a five-second workflow and a five-hour one alike. */
function deltaColour(delta, span) {
    return hslRamp(span > 0 ? 1 + delta / span : 1);
}

/* Where the ramp ends, in ms, taken live off this node's own widget.
 *
 * Read on every paint rather than cached: the value can arrive by being typed in, by
 * deserialisation restoring a saved workflow, or from a connected primitive, and no single
 * event covers all three. Anything blank, non-numeric or non-positive falls back to the
 * default rather than dividing by zero or yielding `hsl(NaN, ...)` - a widget can legally
 * hold "" mid-edit. */
function fullRedMsOf(node) {
    const widget = node?.widgets?.find?.((w) => w?.name === RED_WIDGET);
    const minutes = Number(widget?.value);
    if (!(minutes > 0)) return DEFAULT_FULL_RED_MINUTES * 60000;
    return Math.max(MIN_FULL_RED_MINUTES, minutes) * 60000;
}

/* ------------------------------------------- the previous run's duration --- */

/*
 * How long the last completed run of a workflow took, which is the baseline the header
 * compares against.
 *
 * Kept in a module-level map rather than on the timer, because the node object does not
 * survive a workflow tab switch - the frontend destroys the inactive graph and rebuilds it -
 * and a comparison that forgets itself every time you look at another tab is not much of a
 * comparison. Keyed by the workflow id the prompt carries; a prompt without one falls back
 * to the timer's own field, which is right for everything except that tab switch.
 *
 * Only a run that finished SUCCESSFULLY is recorded. The total of a run that died halfway is
 * not how long the workflow takes, and using it as a baseline would make the next run look
 * dramatically slower for no reason.
 */
const lastTotals = new Map();   // workflow id -> ms
const LAST_TOTALS_LIMIT = 64;
const LAST_TOTALS_KEY = "comfy-workflow-timer:last-totals";

/* Persisted, so the comparison survives a page reload as well as a tab switch. Without this the
 * header went back to N/A every time the browser was refreshed, which on a workflow you run a
 * few times a day is most of the time. localStorage is best-effort: a private window or a full
 * quota just means the comparison is session-only again, which is not worth an error dialog. */
function loadLastTotals() {
    try {
        const saved = JSON.parse(globalThis.localStorage?.getItem(LAST_TOTALS_KEY) || "null");
        if (!saved || typeof saved !== "object") return;
        for (const [id, ms] of Object.entries(saved)) {
            if (typeof ms === "number" && ms > 0) lastTotals.set(String(id), ms);
        }
        _log(`recalled ${lastTotals.size} previous run time(s)`);
    } catch (err) {
        _log(`could not read the saved run times: ${err}`);
    }
}

function saveLastTotals() {
    try {
        globalThis.localStorage?.setItem(LAST_TOTALS_KEY, JSON.stringify(Object.fromEntries(lastTotals)));
    } catch (err) {
        _log(`could not save the run times: ${err}`);
    }
}

function rememberLastTotal(entry, timer, ms) {
    timer.lastCompleted = ms;
    const key = entry?.workflowId;
    if (key == null) return;     // no id to file it under; this session only
    lastTotals.set(String(key), ms);
    // insertion-ordered, so the first key is the least recently recorded
    while (lastTotals.size > LAST_TOTALS_LIMIT) lastTotals.delete(lastTotals.keys().next().value);
    saveLastTotals();
}

function recallLastTotal(entry, timer) {
    const key = entry?.workflowId;
    if (key != null) {
        const known = lastTotals.get(String(key));
        if (known != null) return known;
    }
    return timer.lastCompleted ?? null;
}

/* --------------------------------------- Deciding whether a run is ours --- */

/*
 * A prompt queued anywhere - another browser tab, another workflow tab in this
 * browser, the API, a script - produces exactly the same websocket events as one
 * queued from here. `prompt_id` is the only thing distinguishing them, and nothing
 * in the event says which workflow it came from.
 *
 * So ownership is recorded at the moment of queueing, which is the one moment we can
 * see both things at once: the prompt about to be sent, and the live node objects on
 * the canvas. api.queuePrompt is wrapped once; for each timer instance that appears
 * in the outgoing prompt we remember (prompt_id -> that instance).
 *
 * Note this keys on the node OBJECT, not its id. Two different workflows can both
 * contain a node with id 7, so an id comparison would happily attribute another
 * workflow's run to this timer. Identity cannot collide.
 *
 * A prompt we never saw queued - i.e. from any other tab - is simply absent from the
 * map, and therefore not ours. That is exactly the required behaviour.
 */
const instances = new Set();
const owners = new Map(); // prompt_id -> {nodes: Set<node>, labels: Map<id, string>}
const OWNERS_LIMIT = 64;

/*
 * Prompts handed to the server whose prompt_id we do not know yet.
 *
 * execution_start can arrive over the websocket BEFORE the queue POST's response has
 * been parsed, and that is not a rare race: the first run of a session is slow to start
 * (models still loading) so the response always wins, but on a repeat run of the same
 * workflow everything is cached and execution begins almost immediately - which is
 * exactly the "running it again does not reset the counter" symptom. An event for an
 * unknown prompt_id therefore adopts from here while the entry is fresh.
 *
 * A LIST, not a single slot. Queue several runs in a row - a batch count, or just hitting
 * Run repeatedly - and the calls overlap: each new one used to overwrite the one before it,
 * so every prompt but the last lost its only chance of being adopted. They are held oldest
 * first and claimed one at a time.
 */
const pending = [];          // {entry, at}
const PENDING_WINDOW_MS = 15000;
const PENDING_LIMIT = 16;

function prunePending() {
    const now = Date.now();
    while (pending.length && now - pending[0].at > PENDING_WINDOW_MS) pending.shift();
    while (pending.length > PENDING_LIMIT) pending.shift();
}

function dropPending(entry) {
    const at = pending.findIndex((slot) => slot.entry === entry);
    if (at >= 0) pending.splice(at, 1);
}

function labelsFromPrompt(prompt) {
    /* The API prompt carries each node's workflow title in _meta.title - the same field
     * the server reads in execution.py - so titles come from the prompt rather than from
     * a graph lookup. That is what makes the sub-line show "My Sampler" instead of
     * "node 7", and it keeps working for nodes inside subgraphs, whose ids are flattened
     * to "<parent>:<child>" and never resolve against the top-level graph. */
    const labels = new Map();
    const output = prompt?.output;
    if (!output) return labels;
    for (const [id, entry] of Object.entries(output)) {
        const title = entry?._meta?.title;
        labels.set(String(id), title || entry?.class_type || `node ${id}`);
    }
    return labels;
}

function promptContains(prompt, node) {
    const output = prompt?.output;
    if (!output) return false;
    const id = String(node.id);
    if (Object.prototype.hasOwnProperty.call(output, id)) return true;

    if (!isNested(node)) return false;
    return Object.keys(output).some((key) => key.endsWith(`:${id}`));
}

/* Is this node inside a subgraph rather than on the top-level canvas?
 *
 * Only a nested node may match a prompt key by ":<id>" suffix. Without the distinction a
 * top-level node whose id happens to equal some subgraph child's local id would claim a
 * prompt it is not in - which is what a muted top-level timer looks like. */
function isNested(node) {
    try {
        return node.graph != null && app.graph != null && node.graph !== app.graph;
    } catch (err) {
        return false;
    }
}

function promptKeyFor(prompt, node) {
    /* The prompt key this node is serialized under, or null. Needed as well as identity:
     * identity dies when the frontend destroys the node (switching workflow tabs does
     * exactly that), and the key is what lets a recreated node find its own run again. */
    const output = prompt?.output;
    if (!output) return null;
    const id = String(node.id);
    if (Object.prototype.hasOwnProperty.call(output, id)) return id;
    if (!isNested(node)) return null;
    return Object.keys(output).find((key) => key.endsWith(`:${id}`)) ?? null;
}

function workflowIdOf(prompt) {
    // the serialized workflow carries its own id; used to stop a same-id timer in a
    // DIFFERENT workflow from adopting this run when tabs are switched
    return prompt?.workflow?.id ?? prompt?.workflow?.extra?.workflow_id ?? null;
}

function currentWorkflowId(node) {
    try {
        const root = node?.graph?.rootGraph ?? node?.graph ?? app.graph;
        return root?.id ?? root?.extra?.workflow_id ?? app.graph?.id ?? null;
    } catch (err) {
        return null;
    }
}

function collectOwners(prompt) {
    const nodes = new Set();
    const keys = new Set();
    for (const node of instances) {
        if (node.graph == null) continue;          // removed from the canvas
        const key = promptKeyFor(prompt, node);
        if (key == null) continue;
        nodes.add(node);
        keys.add(key);
    }
    if (!nodes.size) return null;
    return {
        nodes,
        keys,
        labels: labelsFromPrompt(prompt),
        workflowId: workflowIdOf(prompt),
        live: null,   // set while the run is in flight, so a recreated node can rejoin it
    };
}

function remember(promptId, entry) {
    owners.set(String(promptId), entry);
    while (owners.size > OWNERS_LIMIT) {
        const keys = [...owners.keys()];
        /* Prefer a run that has already ended. If every remaining entry still claims to be
         * live then something never told us it finished - a cancelled queue does exactly that,
         * since the server sends no per-prompt event for a prompt it discards - so evict the
         * oldest anyway. Bailing out instead let the map grow without bound. */
        owners.delete(keys.find((key) => !owners.get(key)?.live) ?? keys[0]);
    }
}

let queueHooked = false;
function hookQueuePrompt() {
    if (queueHooked) return;
    const original = api.queuePrompt;
    if (typeof original !== "function") {
        console.warn("[WorkflowTimer] api.queuePrompt is missing; the timer cannot tell whose run is whose and will stay idle.");
        return;
    }
    api.queuePrompt = async function (number, prompt) {
        // computed BEFORE awaiting, so the websocket cannot beat us to it
        const entry = collectOwners(prompt);
        if (entry) {
            prunePending();
            pending.push({ entry, at: Date.now() });
        }
        let response;
        try {
            response = await original.apply(this, arguments);
        } catch (err) {
            dropPending(entry);
            throw err;
        }
        try {
            const promptId = response?.prompt_id ?? response?.promptId;
            if (promptId && entry) {
                remember(promptId, entry);
                dropPending(entry);
            }
        } catch (err) {
            console.error("[WorkflowTimer] could not record prompt ownership", err);
        }
        return response;
    };
    queueHooked = true;
}

/*
 * `adopt` claims a prompt we queued moments ago but whose id we have not been told yet.
 *
 * `node`, when given, is the id an event names, and it must appear in the pending prompt for
 * that prompt to be claimed. execution_start has no node to check, so it takes the oldest
 * fresh entry; a per-node event does have one, and requiring it keeps a foreign run's events
 * from walking off with a slot that is not theirs.
 */
function entryFor(promptId, { adopt = false, node = null } = {}) {
    if (promptId != null) {
        const known = owners.get(String(promptId));
        if (known) return known;
    }
    if (!adopt) return null;
    prunePending();
    const at = node == null
        ? (pending.length ? 0 : -1)
        : pending.findIndex((slot) => slot.entry.labels?.has(String(node)));
    if (at < 0) return null;
    const entry = pending.splice(at, 1)[0].entry;
    if (promptId != null) remember(promptId, entry);
    _log(`adopted a prompt whose id had not landed yet${promptId == null ? "" : ` (${promptId})`}`);
    return entry;
}

/* ------------------------------------------------------------- the view --- */

function buildView() {
    const root = document.createElement("div");
    Object.assign(root.style, {
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        // px, never %: percentage padding resolves against the element's WIDTH on both
        // axes, so a wide flat node would spend a huge slice of its height on vertical
        // padding and clip the second line. fit() recomputes these in px from the box.
        rowGap: "2px",
        padding: "4px 6px",
        background: "#12151a",
        border: "1px solid #2a2f3a",
        borderRadius: "6px",
        overflow: "hidden",
        userSelect: "none",
        position: "relative",      // the progress bar is positioned against this
    });

    /* How far through the previous run's duration this one is, as a fill along the bottom edge.
     *
     * Absolutely positioned, so it costs the line budget nothing and fit() never has to know it
     * exists; the root's overflow:hidden clips it to the rounded corners. Coloured by the same
     * rule as the delta, so the bar and the number always agree. */
    const bar = document.createElement("div");
    Object.assign(bar.style, {
        position: "absolute",
        left: "0",
        bottom: "0",
        height: "3px",
        width: "0%",
        display: "none",
        pointerEvents: "none",
        transition: "width 120ms linear, background-color 240ms linear",
    });

    /* The header: the previous run's total and this run's delta, TOGETHER on one line.
     *
     * They used to be pushed into opposite corners with space-between, which read as two
     * separate readings rather than one comparison - and put ~500px of empty node between
     * them. Centred and adjacent, they are one line you take in at a glance.
     *
     * alignItems CENTER, not baseline: the two cells always carry the same font size, so the
     * two agree, and center cannot be thrown off by a difference in content height the way a
     * baseline can. */
    const header = document.createElement("div");
    Object.assign(header.style, {
        width: "100%",
        display: HEADER_DISPLAY,
        justifyContent: "center",
        alignItems: "center",
        gap: "0.6em",              // scales with the font, so the pair stays a pair
        overflow: "hidden",
        whiteSpace: "nowrap",
    });

    const headerCell = () => {
        const cell = document.createElement("div");
        Object.assign(cell.style, {
            fontFamily: fontStackFor(DEFAULT_FONT_SPEC),
            fontWeight: "400",
            fontSize: "11px",          // fit() drives this too
            lineHeight: "1.2",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            // no shrinking and no ellipsis: fit() sizes the row to the width it needs, so a
            // cell that shrank would be hiding digits the layout had already made room for
            flexShrink: "0",
            transition: "color 240ms linear",
        });
        return cell;
    };
    const last = headerCell();
    const delta = headerCell();
    /* No "Δ" or other prefix, tempting as it is: Oxanium is a Latin-only face, so a Greek
     * capital delta would fall back to a different font mid-line or come out as a box. The
     * sign already tells the two cells apart, and the tooltips say the rest. */
    last.title = "how long the previous completed run took";
    delta.title = "this run minus the previous one - negative is faster, positive is slower";
    header.appendChild(last);
    header.appendChild(delta);

    const total = document.createElement("div");
    Object.assign(total.style, {
        fontFamily: fontStackFor(DEFAULT_FONT_SPEC),
        fontWeight: "700",
        fontSize: "32px",          // a starting point only; fit() drives it from here on
        lineHeight: "1.05",
        letterSpacing: "0.02em",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        transition: "color 240ms linear",
    });

    const detail = document.createElement("div");
    Object.assign(detail.style, {
        fontFamily: fontStackFor(DEFAULT_FONT_SPEC),
        fontWeight: "400",
        fontSize: "12px",
        lineHeight: "1.2",
        color: MUTED,
        // full width, so wrapping happens at the same inner width fit() measures against
        // rather than at whatever a shrink-to-fit flex item settles on
        width: "100%",
        textAlign: "center",
        display: DETAIL_DISPLAY,
        webkitBoxOrient: "vertical",
        webkitLineClamp: "1",       // fit() raises this to 2 when the text needs it and it fits
        // a node title can be one long unbroken token, which word-level wrapping would leave
        // sticking out of the box
        overflowWrap: "anywhere",
        overflow: "hidden",
    });

    root.appendChild(header);
    root.appendChild(total);
    root.appendChild(detail);
    root.appendChild(bar);
    return { root, header, last, delta, total, detail, bar };
}

/* ------------------------------------------------------------- layout --- */

/* Budget by LINE BOX height, not by font size. A 38px counter occupies 38*1.05px of height,
 * and each small line 1.2x its own size; adding the raw font sizes instead (as this once did)
 * overcommits the height by a few percent, which on a small node is exactly enough to push a
 * line out of an overflow:hidden box and make it vanish.
 *
 * Three lines now want the same height, so the combinations are tried in order of ambition
 * and the first that genuinely fits wins. The CLOCK is never dropped - a timer with no time
 * on it is pointless - so on an impossible box it is left at its floor and the box is simply
 * too small. The sub-line goes before the header because the header's two numbers are the
 * comparison the node exists to make, while the node currently executing is also visible on
 * the canvas itself. */
const TOTAL_LINE = 1.05;
const SMALL_LINE = 1.2;      // header cells and the sub-line share a line-height
/* Height shares. The HEADER gets a bigger one than the sub-line: it carries the two
 * numbers the node exists to compare, and at a common share it came out around a third
 * of the counter's size - legible, but small enough to have to lean in for. The sub-line
 * is a label for something already visible on the canvas, so it stays subordinate. */
const HEADER_SHARE = 0.30;
const SMALL_SHARE = 0.2;     // of the available height, per sub-line line
// Ceilings relative to the counter AS SIZED, so neither small line rivals it.
const HEADER_CAP = 0.60;
const SMALL_CAP = 0.45;

/* `detailLines` is how many lines the sub-line is being budgeted for. Blocks and line boxes
 * are counted separately: a sub-line wrapped onto two lines is two line boxes but still one
 * child of the column, so it pays for one row gap, not two. */
function planLines(avail, gap, detailLines = 1) {
    let fallback = null;
    for (const [showHeader, showDetail] of [[true, true], [true, false], [false, false]]) {
        const blocks = (showHeader ? 1 : 0) + (showDetail ? 1 : 0);
        const claimed = (showHeader ? HEADER_SHARE : 0) + (showDetail ? detailLines * SMALL_SHARE : 0);
        let headerPx = Math.max(7, Math.floor((avail * HEADER_SHARE) / SMALL_LINE));
        let smallPx = Math.max(7, Math.floor((avail * SMALL_SHARE) / SMALL_LINE));
        let totalPx = Math.max(8, Math.floor((avail * Math.max(0.25, 1 - claimed)) / TOTAL_LINE));
        // keep both small lines subordinate to the counter once there is room to spare
        headerPx = Math.min(headerPx, Math.max(7, Math.round(totalPx * HEADER_CAP)));
        smallPx = Math.min(smallPx, Math.max(7, Math.round(totalPx * SMALL_CAP)));

        // the floors can overcommit on a tiny node: take it out of the counter first
        const smallBox = (showHeader ? headerPx * SMALL_LINE : 0)
                       + (showDetail ? detailLines * smallPx * SMALL_LINE : 0)
                       + blocks * gap;
        if (totalPx * TOTAL_LINE + smallBox > avail) {
            totalPx = Math.floor((avail - smallBox) / TOTAL_LINE);
        }
        const plan = {
            showHeader, showDetail, headerPx, smallPx,
            totalPx: Math.max(8, totalPx),
            detailLines: showDetail ? detailLines : 0,
        };
        if (totalPx >= 8 && totalPx * TOTAL_LINE + smallBox <= avail) return plan;
        fallback = plan;
    }
    return fallback;
}

/* ------------------------------------------------------------ the timer --- */

class Timer {
    constructor(node) {
        this.node = node;
        this.view = buildView();
        this.running = false;
        this.startedAt = 0;
        this.frozenTotal = 0;
        this.nodeLabel = "";
        this.nodeId = null;
        this.nodeStartedAt = 0;
        this.frozenNode = 0;
        this.nodeRunning = false;
        this.frame = null;
        this.suffix = "";
        this.entry = null;
        this.fitKey = "";
        this.shape = "";
        /* baseline: how long the previous completed run took, which is what the header's left
         * cell shows and what the delta is measured against. It is read once when a run starts
         * and deliberately NOT advanced when that run finishes - otherwise the frozen header
         * would compare the run to itself and read +00:00:000. The next run picks up the new
         * value. lastCompleted is the same number for a workflow whose prompt carries no id,
         * where the module-level map cannot be keyed. */
        this.baseline = null;
        this.lastCompleted = null;
        /* Set when the run was already under way by the time the timer noticed it, so the
         * total is measured from that moment rather than from the real start. Surfaced on the
         * counter's tooltip - a number that is known to be short should say so. */
        this.recovered = false;
        /* Per-node totals for the run in progress, and the finished breakdown of the last run
         * that produced one - biggest first. The finished one is kept until a later run replaces
         * it, so the sub-line has something to report while idle and the clipboard always has
         * the most recent complete answer. */
        this.nodeTimes = new Map();
        this.breakdown = null;
        this.breakdownTotal = 0;
        this.observeSize();
        this.render();
    }

    /* --- sizing ---------------------------------------------------------- */

    observeSize() {
        if (typeof ResizeObserver !== "function") return;
        this.observer = new ResizeObserver(() => this.fit());
        this.observer.observe(this.view.root);
    }

    /* Scale all three lines to fill the node.
     *
     * Height sets the first guess, then the measured width of the rendered text corrects
     * it: text width is linear in font size, so one measure-and-scale pass lands within a
     * pixel. Guessing from a per-character advance instead would only be right for the
     * font it was tuned on, and Oxanium is proportional.
     *
     * Called on resize and when any line gains or loses a character - never per frame,
     * because reading scrollWidth forces layout and doing that inside the animation loop
     * would make the timer the most expensive thing on the canvas. */
    fit() {
        const { root, header, last, delta, total, detail } = this.view;
        const w = root.clientWidth;
        const h = root.clientHeight;
        if (!w || !h) return;

        /* The text lengths are part of the key, not just the box: the header grows when a
         * delta crosses a minute or leaves N/A behind, and the width correction below has to
         * be redone when it does. */
        const key = `${w}x${h}:${total.textContent.length}:${last.textContent.length}:${delta.textContent.length}:${detail.textContent.length}`;
        if (key === this.fitKey) return;
        this.fitKey = key;

        /* Padding and gap in px, recomputed from the box. clientWidth/clientHeight already
         * exclude the border and include the padding, so the content box is the box minus
         * the padding we are about to set - no border term. */
        const padY = Math.max(2, Math.min(10, Math.round(h * 0.06)));
        const padX = Math.max(3, Math.min(14, Math.round(w * 0.04)));
        const gap = Math.max(1, Math.min(6, Math.round(h * 0.03)));
        root.style.padding = `${padY}px ${padX}px`;
        root.style.rowGap = `${gap}px`;

        const avail = Math.max(10, h - padY * 2);
        const innerWidth = Math.max(12, w - padX * 2);

        /* Size the counter from the plan, then correct it against its measured text width. */
        const sizeClock = (px) => {
            total.style.fontSize = `${px}px`;
            const measured = total.scrollWidth;
            if (measured > innerWidth && measured > 0) {
                px = Math.max(8, Math.floor(px * (innerWidth / measured)));
                total.style.fontSize = `${px}px`;
            }
            return px;
        };

        /* Keep a small line subordinate to the counter as ACTUALLY SIZED, not to the
         * height-derived guess. On a wide flat node the counter loses a lot of size to the
         * width correction, and a line capped against the guess ends up nearly as large as
         * the clock - and wide enough to wrap when it had no business wrapping.
         * The header gets the looser ceiling: it is the comparison, not a label. */
        const subordinate = (px, clockPx, cap) => Math.min(px, Math.max(7, Math.round(clockPx * cap)));

        /* How many lines the sub-line needs at a given size.
         *
         * Measured with wrapping switched OFF: what we want is the text's natural single-line
         * width, and scrollWidth on an already-wrapped element is just its own client width,
         * which says nothing. */
        const linesNeeded = (px) => {
            detail.style.fontSize = `${px}px`;
            const previous = detail.style.whiteSpace;
            detail.style.whiteSpace = "nowrap";
            const width = detail.scrollWidth;
            detail.style.whiteSpace = previous;
            return Math.min(DETAIL_MAX_LINES, Math.max(1, Math.ceil(width / innerWidth)));
        };

        let chosen = planLines(avail, gap);
        let totalPx = sizeClock(chosen.totalPx);
        let smallPx = subordinate(chosen.smallPx, totalPx, SMALL_CAP);
        let headerPx = subordinate(chosen.headerPx, totalPx, HEADER_CAP);
        let detailLines = 1;

        /* A node title too long for the width wraps onto a second line rather than being cut
         * off at an ellipsis. The extra line costs height, so the plan is recomputed for it and
         * kept only if it still fits; on a node too short, the sub-line stays on one clamped
         * line, which is the old behaviour. The count is re-derived afterwards because the new
         * plan may size the text smaller, and reserving height for a line that ends up empty
         * would shrink the clock for nothing. */
        if (chosen.showDetail) {
            const want = linesNeeded(smallPx);
            if (want > 1) {
                const roomier = planLines(avail, gap, want);
                /* Judged on the WIDTH-CORRECTED counter, not on the plan's height-derived
                 * guess. Very often the clock is width-bound anyway, so the second line is
                 * free and the two guesses differ for nothing; where the extra line really
                 * does cost the clock, it is not worth it - the clock is the point of the
                 * node - and the name stays on one clamped line instead. */
                const roomierClock = roomier.detailLines === want ? sizeClock(roomier.totalPx) : 0;
                if (roomierClock >= totalPx * WRAP_CLOCK_KEEP) {
                    chosen = roomier;
                    totalPx = roomierClock;
                    smallPx = subordinate(chosen.smallPx, totalPx, SMALL_CAP);
                    headerPx = subordinate(chosen.headerPx, totalPx, HEADER_CAP);
                    detailLines = linesNeeded(smallPx);
                } else {
                    totalPx = sizeClock(chosen.totalPx);      // undo the trial
                }
            }
        }

        header.style.display = chosen.showHeader ? HEADER_DISPLAY : "none";
        detail.style.display = chosen.showDetail ? DETAIL_DISPLAY : "none";
        detail.style.webkitLineClamp = String(detailLines);
        detail.style.fontSize = `${smallPx}px`;

        /* The header holds two numbers side by side, so it runs out of WIDTH long before the
         * clock does - a 12-character delta next to a 9-character total is more than twice
         * the clock's own glyph count. Correct it the same way, measuring the two cells and
         * the gap between them rather than the row, whose own scrollWidth says nothing about
         * how much its flex children want. */
        last.style.fontSize = `${headerPx}px`;
        delta.style.fontSize = `${headerPx}px`;
        if (chosen.showHeader) {
            const wanted = last.scrollWidth + delta.scrollWidth + gap;
            if (wanted > innerWidth && wanted > 0) {
                headerPx = Math.max(8, Math.floor(headerPx * (innerWidth / wanted)));
                last.style.fontSize = `${headerPx}px`;
                delta.style.fontSize = `${headerPx}px`;
            }
        }
    }

    /* --- state transitions ----------------------------------------------- */

    start(entry = null) {
        // hold on to the prompt this run belongs to: per-node events that arrive without a
        // prompt_id have no entry to pass in, and resolving a label without the prompt's
        // _meta titles is what produces "node 105:9387" instead of the node's name
        this.entry = entry;
        this.running = true;
        this.startedAt = performance.now();
        this.frozenTotal = 0;
        this.nodeRunning = false;
        this.nodeLabel = "";
        this.nodeId = null;
        this.frozenNode = 0;
        this.suffix = "";
        this.recovered = false;      // caught at execution_start, so the total is exact
        // the run record carries it so that every timer in the workflow, including one that
        // rejoins later, compares against the same number
        this.baseline = entry?.live?.baseline ?? recallLastTotal(entry, this);
        // one map per RUN, shared by every timer watching it - they are all observing the
        // same nodes, so two timers must not each count half of them
        this.nodeTimes = new Map();
        if (entry?.live) entry.live.nodeTimes = this.nodeTimes;
        this.render();
        this.loop();
    }

    /* Continue a run that started before this node object existed, or before the timer knew
     * the run was happening at all. */
    resume(entry, live) {
        this.entry = entry;
        this.running = true;
        this.startedAt = live.startedAt;
        this.frozenTotal = 0;
        this.suffix = "";
        this.recovered = live.recovered === true;
        this.baseline = live.baseline ?? null;
        // pick up what the run has already measured, rather than starting a second tally
        if (!(live.nodeTimes instanceof Map)) live.nodeTimes = new Map();
        this.nodeTimes = live.nodeTimes;
        if (live.nodeId != null) {
            this.nodeLabel = live.nodeLabel;
            this.nodeId = live.nodeId;
            this.nodeStartedAt = live.nodeStartedAt;
            this.nodeRunning = true;
        }
        this.render();
        this.loop();
    }

    beginNode(label, id = null) {
        this.nodeLabel = label;
        this.nodeId = id == null ? null : String(id);
        this.nodeStartedAt = performance.now();
        this.nodeRunning = true;
    }

    endNode() {
        if (!this.nodeRunning) return;
        this.frozenNode = performance.now() - this.nodeStartedAt;
        this.nodeRunning = false;
        /* Accumulated, not assigned: a node inside a loop or run with a batch count executes
         * many times, and what matters is its total share of the run. Keyed by the label rather
         * than the id for the same reason the sub-line uses it - it is the name on the canvas. */
        if (this.nodeLabel) {
            this.nodeTimes.set(this.nodeLabel, (this.nodeTimes.get(this.nodeLabel) ?? 0) + this.frozenNode);
        }
    }

    /* Stop painting because this node is going away - the run itself is unaffected. */
    halt() {
        this.running = false;
        if (this.frame != null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
    }

    /* `completed` means the run reached its end rather than erroring out or being
     * interrupted - only then is its total worth keeping as the next run's baseline. */
    stop(suffix, completed = false) {
        const wasRunning = this.running;
        if (wasRunning) this.frozenTotal = performance.now() - this.startedAt;
        this.endNode();
        this.running = false;
        if (this.frame != null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
        // the run is over, so the sub-line goes back to its resting state rather than
        // leaving the last node's name and a stopped clock sitting there looking live
        this.nodeLabel = "";
        this.nodeId = null;
        this.frozenNode = 0;
        /* Only replace the stored breakdown when this run actually measured something. A stop
         * with nothing behind it - the run was another tab's, or the timer was never started -
         * must not wipe out the last real one. */
        if (this.nodeTimes.size) {
            this.breakdown = [...this.nodeTimes.entries()].sort((a, b) => b[1] - a[1]);
            this.breakdownTotal = this.frozenTotal;
        }
        /* A recovered run is short by however long it had been going before the timer noticed,
         * so its total is not a measurement of the workflow and must not become the baseline -
         * the same reasoning that keeps a failed run out. */
        if (completed && wasRunning && !this.recovered) {
            rememberLastTotal(this.entry, this, this.frozenTotal);
        } else if (completed && wasRunning) {
            _log("not recording a recovered run's total as the baseline: it is missing its start");
        }
        this.entry = null;
        this.suffix = suffix || "idle";
        this.render(); // one last paint so the frozen total is the exact final one
    }

    /* --- painting -------------------------------------------------------- */

    loop() {
        if (this.frame != null) cancelAnimationFrame(this.frame);
        const tick = () => {
            if (!this.running) {
                this.frame = null;
                return;
            }
            this.render();
            this.frame = requestAnimationFrame(tick);
        };
        this.frame = requestAnimationFrame(tick);
    }

    totalMs() {
        // derived from timestamps, never accumulated, so a throttled or hidden tab
        // (where rAF stops firing) resumes with the correct time instead of drifting
        return this.running ? performance.now() - this.startedAt : this.frozenTotal;
    }

    nodeMs() {
        if (this.nodeRunning) return performance.now() - this.nodeStartedAt;
        return this.frozenNode;
    }

    /* The previous run's total on the left, this run minus it on the right.
     *
     * The three readings are kept consistent - left + delta == the clock - so the header
     * explains itself without labels. Either cell reads N/A when its number does not exist
     * yet: no previous run to compare against, or no current time to compare (a node freshly
     * rebuilt on an idle workflow knows the baseline but has no run of its own). */
    renderHeader(fullRedMs) {
        const { last, delta } = this.view;
        const baseline = this.baseline;
        const muted = (cell, text) => { cell.textContent = text; cell.style.color = MUTED; };

        if (!(baseline > 0)) {
            muted(last, NONE);
            muted(delta, NONE);
            return;
        }
        last.textContent = formatMs(baseline);
        last.style.color = rampColour(baseline, fullRedMs);

        if (!this.running && !(this.frozenTotal > 0)) {
            muted(delta, NONE);
            return;
        }
        const difference = this.totalMs() - baseline;
        delta.textContent = formatDelta(difference);
        delta.style.color = deltaColour(difference, baseline);
    }

    /* The fill along the bottom edge: this run's elapsed time as a fraction of the previous
     * run's total. Hidden when there is no previous run to measure against, or no run of our own
     * to measure - a bar with nothing behind it would be a made-up number. */
    renderProgress(ms) {
        const { bar } = this.view;
        const baseline = this.baseline;
        if (!(baseline > 0) || (!this.running && !(this.frozenTotal > 0))) {
            bar.style.display = "none";
            return;
        }
        bar.style.display = "";
        bar.style.width = `${(Math.min(1, Math.max(0, ms / baseline)) * 100).toFixed(1)}%`;
        bar.style.backgroundColor = deltaColour(ms - baseline, baseline);
    }

    /* The last finished run, node by node, biggest first - what the clipboard gets. */
    breakdownText() {
        if (!this.breakdown?.length) return "";
        const total = this.breakdownTotal || 0;
        const lines = [`${this.node?.title || "Workflow Execution Timer"}  total ${formatMs(total)}`];
        for (const [name, ms] of this.breakdown) {
            const share = total > 0 ? `  ${((ms / total) * 100).toFixed(1).padStart(5)}%` : "";
            lines.push(`${formatMs(ms)}${share}  ${name}`);
        }
        // worth saying, because their absence looks like a bug otherwise
        lines.push("", "Nodes served from cache never execute, so they are not listed.");
        return lines.join("\n");
    }

    render() {
        const ms = this.totalMs();
        const text = formatMs(ms);
        const fullRedMs = fullRedMsOf(this.node);
        this.view.total.textContent = text;
        this.view.total.style.color = rampColour(ms, fullRedMs);
        this.view.total.title = this.recovered
            ? "this run was already under way when the timer picked it up, so the total is measured from that moment and is short by however long it had been going"
            : "";
        this.renderHeader(fullRedMs);
        this.renderProgress(ms);

        let line;
        if (this.nodeLabel) {
            line = `${this.nodeLabel} — ${formatMs(this.nodeMs())}`;
        } else if (this.running) {
            line = "waiting for the first node…";
        } else if (this.suffix && this.suffix !== "idle") {
            line = this.suffix;                 // why it stopped outranks any statistic
        } else if (this.breakdown?.length) {
            // idle with something to report: the one node most worth looking at
            const [name, worst] = this.breakdown[0];
            line = `slowest: ${name} — ${formatMs(worst)}`;
        } else {
            line = this.suffix || "idle";
        }
        this.view.detail.textContent = line;
        // the full name on hover when it is ellipsised, plus the way to get the rest
        const copyable = this.breakdown?.length > 0;
        this.view.detail.title = copyable ? `${line}\n\nclick to copy the full timing breakdown` : line;
        this.view.detail.style.cursor = copyable ? "pointer" : "default";

        /* Re-fit only when a line changes LENGTH - the counter gaining a digit
         * (99:59:999 -> 100:00:000), a header cell leaving N/A or crossing a minute, or the
         * sub-line naming a different node, which is what decides whether it has to wrap.
         * Never per frame: fit() reads scrollWidth, which forces layout. The times inside
         * these strings are fixed-width, so a length change really does mean new content. */
        const shape = [text, this.view.last.textContent, this.view.delta.textContent, line]
            .map((s) => s.length).join(":");
        if (shape !== this.shape) {
            this.shape = shape;
            this.fit();
        }
    }
}

/* -------------------------------------------------------------- wiring --- */

function labelForId(id, entry) {
    /* Resolve a node id against the prompt's own _meta titles first - that is the name
     * shown on the workflow - and only fall back to a graph lookup, then to the bare id. */
    if (id == null) return null;
    id = String(id);

    const fromPrompt = entry?.labels?.get(id);
    if (fromPrompt) return fromPrompt;

    /* A node inside a subgraph is flattened into the prompt as "<parent>:<child>", and
     * nesting just keeps appending: "<a>:<b>:<c>". The flattened id normally IS a key in
     * the prompt, so the lookup above already answered; this is the fallback for ids the
     * prompt does not carry verbatim (runtime-expanded nodes, for one). Resolve every
     * segment that is known and join them, so a nested node still reads as a path rather
     * than as a colon-separated number. */
    if (id.includes(":")) {
        const parts = id.split(":");
        const named = parts.map((part, i) => {
            const prefix = parts.slice(0, i + 1).join(":");
            return entry?.labels?.get(prefix) ?? entry?.labels?.get(part) ?? part;
        });
        // drop repeats: a parent resolved by prefix and by segment yields the same name
        const path = named.filter((name, i) => i === 0 || name !== named[i - 1]);
        if (path.some((name, i) => name !== parts[i])) return path.join(" / ");
    }

    let found = null;
    try {
        found = app.graph?.getNodeById?.(id) ?? app.graph?.getNodeById?.(Number(id)) ?? null;
        if (!found && Array.isArray(app.graph?._nodes)) {
            found = app.graph._nodes.find((n) => String(n.id) === id) ?? null;
        }
    } catch (err) {
        found = null;
    }
    if (found) return found.title || found.type || `node ${id}`;
    return `node ${id}`;
}

function promptIdOf(detail) {
    return (detail && typeof detail === "object") ? detail.prompt_id : undefined;
}

function forEachTimer(entry, fn) {
    if (!entry) return;
    for (const node of entry.nodes) if (node.__timer) fn(node.__timer);
}

/* Apply to every timer currently mid-run.
 *
 * Not every per-node event carries a prompt_id: execution.py sends one with "executing",
 * but server.py's status/reconnect path sends `{node}` alone, and older servers sent the
 * bare node id as the whole detail. Without this fallback such an event is dropped, the
 * node line never leaves "waiting for the first node" while the total counts up happily -
 * which is exactly what happens if you only look up by prompt_id. Falling back to the
 * running timers is safe: a timer only runs because it already claimed an execution_start. */
function forEachRunningTimer(fn) {
    for (const node of instances) if (node.__timer?.running) fn(node.__timer);
}

/* Start a timer on a run that is demonstrably in progress but which it never saw begin.
 *
 * `execution_start` is the only event that starts the clock, and a single missed one used to
 * cost the whole run: the timer sat at its last frozen value while the workflow ran to
 * completion, because every per-node handler asks `if (timer.running)` first. It can be missed
 * for real reasons - a websocket reconnect swallowing it, a queue of runs where the frontend
 * batches faster than the responses come back, an interrupt-and-rerun that gets the events out
 * of order - and none of them should cost more than a moment of the count.
 *
 * Any per-node event for a prompt we own is proof enough: nodes do not execute outside a run.
 * The start time is unknown, so the count begins here and the run is flagged as recovered
 * rather than pretending to a precision it does not have. If another timer already caught the
 * same run, its exact start time is on the record and gets used instead.
 */
function recoverRun(entry, timer) {
    if (!entry || timer.running) return false;
    if (!entry.live) {
        entry.live = {
            startedAt: performance.now(), nodeId: null, nodeLabel: "", nodeStartedAt: 0,
            baseline: recallLastTotal(entry, timer),
            recovered: true,
        };
        _log("a run was already in progress; starting the count from here");
    }
    timer.resume(entry, entry.live);
    return true;
}

function switchNode(timer, id, entry) {
    if (id == null) return;
    const key = String(id);
    if (timer.nodeId === key) return;          // already timing this one
    timer.endNode();
    // fall back to the entry the timer claimed at execution_start, so an event that came
    // without a prompt_id still resolves titles from the prompt
    const owner = entry ?? timer.entry;
    const label = labelForId(key, owner) || `node ${key}`;
    timer.beginNode(label, key);
    // mirror it onto the run so a node recreated mid-run picks up where this left off
    if (owner?.live) {
        owner.live.nodeId = key;
        owner.live.nodeLabel = label;
        owner.live.nodeStartedAt = timer.nodeStartedAt;
    }
}

/* Rejoin a run that is already in flight.
 *
 * Switching workflow tabs makes the frontend destroy the inactive graph and rebuild it on
 * return, so the node object that claimed the run no longer exists and the recreated one
 * knows nothing - it showed 00:00:000 idle while the workflow was still running. Identity
 * cannot survive that, but the prompt key can: the run records which keys belong to timer
 * nodes, so a fresh node with a matching key adopts the run and continues from its original
 * start time (performance.now() is process-wide, so the elapsed time stays exact).
 *
 * TIMING MATTERS. The frontend fires `nodeCreated` from the ComfyNode constructor, before
 * the node is added to a graph and before deserialisation assigns its id - so at that point
 * node.id and node.graph are both useless here. This is therefore retried from onAdded and
 * onConfigure, and once off a zero timeout, and is idempotent so the extra calls are free.
 */
function canRejoin(node, entry) {
    /* Is this node's workflow the one the run belongs to?
     *
     * prompt.workflow.id and a live LGraph's id need not come from the same namespace, so a
     * mismatch is NOT taken as proof of a different workflow - an over-strict comparison
     * here simply refuses every rejoin, which is the bug this is meant to fix. Equality is
     * accepted as proof; otherwise the graph's own node ids are compared against the run's,
     * which is namespace-safe because it compares ids to ids. */
    const here = currentWorkflowId(node);
    if (entry.workflowId != null && here != null && entry.workflowId === here) return true;

    const root = node.graph?.rootGraph ?? node.graph;
    const nodes = root?._nodes ?? root?.nodes;
    if (!Array.isArray(nodes) || !nodes.length) return true;      // nothing to judge on
    const present = new Set(nodes.map((n) => String(n.id)));
    /* Probe with the run's OTHER nodes, never the timer's own key: that one matches by
     * construction (it is why we are here), so including it would let a lone same-id timer
     * in an unrelated workflow score half the vote and adopt the run. */
    const probe = new Set([...(entry.labels?.keys() ?? [])]
        .filter((key) => !entry.keys?.has(String(key)))
        .map((key) => String(key).split(":")[0]));
    if (!probe.size) return true;
    let hits = 0;
    for (const id of probe) if (present.has(id)) hits += 1;
    const score = hits / probe.size;
    if (score >= 0.5) return true;
    _log(`not rejoining: only ${hits}/${probe.size} of the run's nodes are in this graph`);
    return false;
}

function tryRejoin(node, timer) {
    if (timer.running) return true;                    // already on a run
    if (node.graph == null || node.id == null) return false;   // too early to tell
    const id = String(node.id);
    for (const entry of owners.values()) {
        if (!entry.live) continue;
        const matches = entry.keys?.has(id) || [...(entry.keys ?? [])].some((key) => key.endsWith(`:${id}`));
        if (!matches) continue;
        if (!canRejoin(node, entry)) continue;

        entry.nodes.add(node);                  // events reach the new object from now on
        timer.resume(entry, entry.live);
        _log(`rejoined a run already in progress (node ${id})`);
        return true;
    }
    return false;
}

function _log(message) {
    console.debug?.(`[WorkflowTimer] ${message}`);
}

/* Recover the baseline for a node rebuilt while the workflow is IDLE.
 *
 * tryRejoin only covers a run still in flight. Coming back to a tab whose last run has
 * already finished, the new node has no history of its own and would show N/A until the next
 * run - even though the workflow's last total is sitting in the map. The right cell stays N/A
 * regardless, because this node has no current time to compare yet. */
function seedBaseline(node, timer) {
    if (timer.running || timer.baseline != null) return;
    /* Not before the node has a graph. currentWorkflowId falls back to app.graph, which at
     * construction time is whatever workflow is on screen - so seeding from it would hand a
     * node being built for one workflow the history of another. */
    if (node.graph == null) return;
    const id = currentWorkflowId(node);
    if (id == null) return;
    const ms = lastTotals.get(String(id));
    if (ms == null) return;
    timer.baseline = ms;
    timer.render();
}

/* Apply a node's own font_spec to its own elements.
 *
 * Per node rather than globally: the spec is a widget, so two timers may legitimately want
 * different fonts, and one shared stack would let whichever changed last win for everybody.
 * A no-op when the spec has not changed, which is what makes it safe to call from every hook
 * that might have brought a new value in. */
function applyFont(node, timer) {
    const widget = node.widgets?.find?.((w) => w?.name === FONT_WIDGET);
    const spec = cleanSpec(widget?.value ?? DEFAULT_FONT_SPEC);
    if (spec === timer.fontSpec) return;
    timer.fontSpec = spec;
    ensureFont(spec);
    const stack = fontStackFor(spec);
    for (const el of [timer.view.total, timer.view.detail, timer.view.last, timer.view.delta]) {
        el.style.fontFamily = stack;
    }
    // a different face means different metrics, so every width measured so far is now wrong
    timer.fitKey = "";
    timer.fit();
    _log(`font is now ${spec}`);
}

/* Move the named widgets to the end of the list, in the order given.
 *
 * Widgets declared in the schema are built by the ComfyNode constructor, and nodeCreated is
 * invoked at the end of that same constructor - so the DOM widget holding the clock is always
 * appended AFTER them, which would leave the settings sitting on top of the display.
 * Reordering the array is the fix; depending on the construction order would not be one. */
function orderWidgets(node, names) {
    const widgets = node.widgets;
    if (!Array.isArray(widgets)) return;
    for (const name of names) {
        const at = widgets.findIndex((w) => w?.name === name);
        if (at >= 0) widgets.push(widgets.splice(at, 1)[0]);
    }
}

/* The settings below the clock: the red threshold, a disclosure button, and the font field it
 * shows and hides.
 *
 * Returns a `sync` to be called again whenever a new value may have arrived - deserialising a
 * saved workflow sets widget values without going through their callbacks, so a custom font
 * would otherwise never be applied and its field never revealed.
 */
function wireWidgets(node, timer) {
    const find = (name) => node.widgets?.find?.((w) => w?.name === name) ?? null;
    const chain = (widget, after) => {
        if (!widget) return;
        const previous = widget.callback;
        widget.callback = function () {
            const result = previous?.apply(this, arguments);
            after();
            return result;
        };
    };

    // a stopped timer paints only on demand: without this, editing the number leaves the frozen
    // total in its old colour until the next run
    chain(find(RED_WIDGET), () => timer.render());

    const spec = find(FONT_WIDGET);
    chain(spec, () => applyFont(node, timer));

    /* A button rather than a boolean input, because whether the fields are showing is view state
     * and has no business in the serialized prompt. `serialize: false` keeps it out of
     * widgets_values as well - a button has no value, and letting it take a slot there would
     * shift every widget after it when the workflow is reloaded. */
    const managed = [find(RED_WIDGET), spec].filter(Boolean);
    let touched = false;      // once the user has had an opinion, stop having one for them
    let open = false;
    let button = null;
    const paint = () => {
        // `hidden` is the frontend's own extension hook: it drops the widget out of layout while
        // leaving it in node.widgets, so values still serialize while the fields are put away
        for (const widget of managed) widget.hidden = !open;
        if (button) button.label = open ? "hide settings" : "show settings";
        /* Revealing the fields takes rows out of the node's body, which would otherwise come
         * straight off the clock. Grow to make room - but only grow: shrinking again would throw
         * away a size the user chose, and this is idempotent so repeated calls settle. */
        const wanted = MIN_SIZE[1] + (open ? managed.length * WIDGET_ROW : 0);
        if (Array.isArray(node.size) && node.size[1] < wanted) {
            node.setSize?.([node.size[0], wanted]);
            node.size[1] = wanted;
        }
    };
    if (managed.length && typeof node.addWidget === "function") {
        button = node.addWidget("button", SETTINGS_TOGGLE, null, () => {
            touched = true;
            open = !open;
            paint();
            node.setDirtyCanvas?.(true, true);
        }, { serialize: false });
    }

    orderWidgets(node, [SETTINGS_TOGGLE, RED_WIDGET, FONT_WIDGET]);

    /* Anything left at its default has nothing to say, so the panel stays shut; a setting that
     * has been changed shows itself, so a loaded workflow does not look as though it was lost. */
    const customised = () => {
        const red = find(RED_WIDGET);
        if (red && Number(red.value) !== DEFAULT_FULL_RED_MINUTES) return true;
        return spec != null && cleanSpec(spec.value) !== DEFAULT_FONT_SPEC;
    };

    const sync = () => {
        if (!touched) open = customised();
        paint();
        applyFont(node, timer);
    };
    sync();
    return sync;
}

/* Forget the previous run's time, so the header starts over from N/A.
 *
 * The number lives in four places at once - the per-workflow map, its localStorage copy, each
 * timer's own field, and the record of any run currently in flight - and leaving any one of them
 * behind would have it reappear at the next paint or the next run.
 *
 * The per-node breakdown is deliberately left alone: it describes a run that did happen, and
 * "reset the previous execution time" does not ask for it to be forgotten. */
function resetBaseline(node, timer) {
    const id = currentWorkflowId(node);
    if (id != null) {
        lastTotals.delete(String(id));
        saveLastTotals();
    }
    /* Every timer on the same workflow, not only this one: the value being reset belongs to the
     * workflow, so a sibling node still holding its own copy would go on showing it. */
    for (const other of instances) {
        const peer = other.__timer;
        if (!peer) continue;
        if (other !== node) {
            // a detached node would match by currentWorkflowId's fallback to app.graph
            if (other.graph == null || id == null || currentWorkflowId(other) !== id) continue;
        }
        peer.lastCompleted = null;
        peer.baseline = null;
        if (peer.entry?.live) peer.entry.live.baseline = null;
        peer.render();
    }
    _log(`forgot the previous run time${id == null ? "" : ` for ${id}`}`);
}

/* Put the last finished run's per-node breakdown on the clipboard.
 *
 * Reachable two ways, neither of which costs the node any space: the right-click menu, which is
 * where ComfyUI puts per-node actions, and a click on the sub-line, which is where the number
 * being summarised is already showing. */
function copyBreakdown(timer) {
    const text = timer.breakdownText();
    if (!text) {
        _log("nothing to copy yet: no run has finished");
        return false;
    }
    const confirm = () => {
        // only worth showing while idle: a running timer repaints every frame and would wipe it
        if (timer.running) return;
        timer.view.detail.textContent = "breakdown copied";
        setTimeout(() => {
            if (timer.view.detail.textContent === "breakdown copied") timer.render();
        }, 1200);
    };
    try {
        const written = navigator.clipboard?.writeText?.(text);
        if (written?.then) written.then(confirm, (err) => console.warn("[WorkflowTimer] could not copy the breakdown", err));
        else confirm();
    } catch (err) {
        console.warn("[WorkflowTimer] could not copy the breakdown", err);
        return false;
    }
    return true;
}

function registerEvents() {
    api.addEventListener("execution_start", ({ detail }) => {
        // adopt: on a repeat run the websocket routinely beats the queue response
        const entry = entryFor(promptIdOf(detail), { adopt: true });
        if (!entry) return;            // another workflow, another tab, or the API: ignore
        entry.live = { startedAt: performance.now(), nodeId: null, nodeLabel: "", nodeStartedAt: 0, baseline: null };
        // one baseline for the whole run, so two timers in the same workflow - and any node
        // that rejoins the run later - all compare against the same previous total
        for (const node of entry.nodes) {
            const recalled = recallLastTotal(entry, node.__timer ?? {});
            if (recalled != null) { entry.live.baseline = recalled; break; }
        }
        forEachTimer(entry, (timer) => timer.start(entry));
    });

    /* One node is executing, on a prompt we own. Recovery lives here: a timer that is not
     * running gets started, because a node cannot execute outside a run. */
    const onNodeRunning = (promptId, raw) => {
        const entry = entryFor(promptId, { adopt: true, node: raw });
        if (entry) {
            forEachTimer(entry, (timer) => {
                if (recoverRun(entry, timer) || timer.running) switchNode(timer, raw, entry);
            });
        } else if (promptId == null) {
            // no prompt to look up: the running timers are the best guess, and a safe one
            forEachRunningTimer((timer) => switchNode(timer, raw, null));
        }
    };

    api.addEventListener("executing", ({ detail }) => {
        const promptId = promptIdOf(detail);
        const raw = (detail && typeof detail === "object") ? detail.node : detail;

        if (raw == null) {
            // the classic "execution finished" signal - a completion, so it sets the baseline
            const entry = entryFor(promptId);
            if (entry) {
                entry.live = null;
                forEachTimer(entry, (timer) => timer.stop(undefined, true));   // -> "idle"
            } else if (promptId == null) {
                forEachRunningTimer((timer) => { if (timer.entry) timer.entry.live = null; timer.stop(undefined, true); });
            }
            return;
        }
        onNodeRunning(promptId, raw);
    });

    /* Per-step sampler progress. Not needed to name the node - the two handlers below do that -
     * but it is by far the most frequent event of a run, which makes it the quickest way back
     * for a timer that missed the start. */
    api.addEventListener("progress", ({ detail }) => {
        const node = (detail && typeof detail === "object") ? (detail.node ?? detail.display_node_id) : null;
        if (node == null) return;
        onNodeRunning(promptIdOf(detail), node);
    });

    /* The modern per-node source. progress_state carries every non-pending node's state
     * for a prompt, so it reports the running node even on a build that does not send
     * "executing" to this client. Both handlers are idempotent - switchNode ignores a
     * repeat of the node already being timed - so having both costs nothing. */
    api.addEventListener("progress_state", ({ detail }) => {
        const states = Object.values(detail?.nodes ?? {});
        const running = states.filter((state) => state?.state === "running");
        if (!running.length) return;
        const pick = running[0];
        const picked = pick.display_node_id ?? pick.node_id;
        const entry = entryFor(promptIdOf(detail), { adopt: true, node: picked });
        if (!entry) return;
        forEachTimer(entry, (timer) => {
            if (!recoverRun(entry, timer) && !timer.running) return;
            // stay on the node already being timed while it is still running
            if (running.some((state) => String(state.display_node_id ?? state.node_id) === timer.nodeId)) return;
            switchNode(timer, picked, entry);
        });
    });

    /* `completed` distinguishes a run that ran to the end from one that died: only the former
     * becomes the baseline the next run's delta is measured against. */
    const finish = (suffix, completed = false) => ({ detail }) => {
        const promptId = promptIdOf(detail);
        const entry = entryFor(promptId);
        if (entry) {
            entry.live = null;         // the run is over; nothing left to rejoin
            forEachTimer(entry, (timer) => timer.stop(suffix, completed));
        }
        else if (promptId == null) {
            forEachRunningTimer((timer) => { if (timer.entry) timer.entry.live = null; timer.stop(suffix, completed); });
        }
        if (promptId != null) owners.delete(String(promptId));
    };

    api.addEventListener("execution_success", finish(undefined, true));   // -> "idle"
    api.addEventListener("execution_error", finish("stopped on error"));
    api.addEventListener("execution_interrupted", finish("interrupted"));

    /* The other half of recovery: stopping when nothing told us the run was over.
     *
     * `queue_remaining` is `len(queue) + len(currently_running)` on the server, so zero means
     * nothing is pending AND nothing is executing - whatever we are still counting has ended.
     * That covers the cases with no per-prompt event at all: clearing the queue discards
     * pending prompts silently, and an interrupt does not always produce an
     * execution_interrupted this client sees. Without it a timer could count up forever.
     *
     * Recorded as an unknown ending, not a completion: if the run really did finish we would
     * have had execution_success, so a total arrived at this way is not trustworthy enough to
     * become the baseline the next run is compared against. */
    api.addEventListener("status", ({ detail }) => {
        const remaining = detail?.exec_info?.queue_remaining ?? detail?.status?.exec_info?.queue_remaining;
        if (remaining !== 0) return;
        forEachRunningTimer((timer) => {
            if (timer.entry) timer.entry.live = null;
            timer.stop("stopped");
            _log("the queue is empty but the timer was still running; stopped it");
        });
    });
}

app.registerExtension({
    name: "comfy.workflow_timer",

    async setup() {
        ensureFont(DEFAULT_FONT_SPEC);
        loadLastTotals();
        hookQueuePrompt();
        registerEvents();
    },

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE) return;

        const timer = new Timer(node);
        node.__timer = timer;
        instances.add(node);

        if (typeof node.addDOMWidget === "function") {
            node.addDOMWidget("timer", "div", timer.view.root, {
                serialize: false,
                hideOnZoom: false,
            });
        } else {
            console.warn("[WorkflowTimer] addDOMWidget is unavailable on this frontend; the node will show nothing.");
        }

        const syncWidgets = wireWidgets(node, timer);

        /* Two ways to the breakdown, both free of node space. The click listener is on the
         * sub-line because that is where the summary of it already is; stopPropagation keeps the
         * click from also reaching the canvas and starting a node drag. */
        timer.view.detail.addEventListener?.("click", (event) => {
            event.stopPropagation?.();
            copyBreakdown(timer);
        });
        const previousMenu = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            const result = previousMenu?.apply(this, arguments);
            if (Array.isArray(options)) {
                options.push({
                    content: "Copy timing breakdown",
                    disabled: !timer.breakdown?.length,
                    callback: () => copyBreakdown(timer),
                }, {
                    content: "Reset previous run time",
                    disabled: timer.baseline == null && timer.lastCompleted == null,
                    callback: () => resetBaseline(node, timer),
                });
            }
            return result;
        };

        /* A node recreated while its workflow is still running picks the run back up, and a node
         * being deserialised gets its font applied. Both are attempted from every point at which
         * the id, the graph or the saved widget values might have arrived: the constructor hook
         * is too early for all three. */
        const attempt = () => {
            syncWidgets();
            seedBaseline(node, timer);
            return tryRejoin(node, timer);
        };
        attempt();
        for (const hook of ["onAdded", "onConfigure"]) {
            const previous = node[hook];
            node[hook] = function () {
                const result = previous?.apply(this, arguments);
                attempt();
                return result;
            };
        }
        setTimeout(attempt, 0);

        node.size = [Math.max(node.size?.[0] ?? 0, MIN_SIZE[0]), Math.max(node.size?.[1] ?? 0, MIN_SIZE[1])];

        // ResizeObserver covers the normal case; onResize catches frontends that resize
        // the node without the widget's own box changing
        const onResize = node.onResize;
        node.onResize = function () {
            timer.fitKey = "";
            timer.fit();
            return onResize?.apply(this, arguments);
        };

        const onRemoved = node.onRemoved;
        node.onRemoved = function () {
            timer.halt();
            timer.observer?.disconnect();
            instances.delete(node);
            /* Drop this object from the ownership records but KEEP the records themselves.
             * Switching workflow tabs removes the node while the run continues; deleting the
             * entry here orphaned the run, so coming back showed an idle timer and the rest
             * of the run went unreported. */
            for (const entry of owners.values()) entry.nodes.delete(node);
            return onRemoved?.apply(this, arguments);
        };
    },
});
