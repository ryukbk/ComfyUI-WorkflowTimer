# ComfyUI Workflow Execution Timer

A display-only node showing how long the current workflow has been running, live, in
`MM:SS:mmm`, with a second smaller line naming the node being executed right now and
timing it, and a header comparing this run against the previous one.

```
 01:35:120          +00:12:272   <- previous run          this run minus it
          01:47:392              <- light green -> red over full_red_minutes
      KSampler — 00:12:004       <- the node running right now, and its own timer
 ████████████████████░░░░░░░░    <- how far through last run's duration
 [      show settings       ]    <- reveals the two fields below
 full_red_minutes        10.0    <- where the ramp ends, in minutes
 font_spec  Oxanium:wght@400;700 <- any Google Fonts family= value
```

Idle, with a finished run behind it, the sub-line reports the run's worst offender instead —
`slowest: KSampler — 01:12:004`. Click it, or use **Copy timing breakdown** in the node's
right-click menu, for the whole table. The same menu has **Reset previous run time**.

## Install

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI (a full process
restart, not Manager's reload — the node registers a web extension). Then add
**Workflow Execution Timer** from the `utils` category.

Requires a ComfyUI recent enough to support Nodes 2.0 (`comfy_api.latest`,
`comfy_entrypoint`).

## Behaviour

| | |
|---|---|
| **Format** | `MM:SS:mmm`, zero-padded. Minutes keep counting past 59, so a 65-minute run reads `65:00:000`. |
| **Start** | Resets to `00:00:000` and starts counting on `execution_start` for this workflow. |
| **Update** | Every animation frame. Elapsed time is derived from timestamps rather than accumulated, so a backgrounded browser tab (where the frame callback stops firing) resumes with the correct time instead of drifting behind. |
| **Size** | All three lines scale to fill the node. A `ResizeObserver` drives `fit()`, which budgets the height by **line box** (`font-size x line-height`), sets padding and gap in **px** computed from the box, then corrects the counter against its measured text width — width is linear in font size, so one pass lands within a pixel. The header gets the same correction, measured across **its two cells plus the gap** rather than the row (a flex row's own `scrollWidth` says nothing about what its children want), because two nine-digit numbers side by side run out of width long before the counter does. The two small lines are then re-capped against the counter **as actually sized**, not against the height-derived guess — on a wide flat node the counter loses a lot to the width pass, and a line capped against the guess ends up nearly as large as the clock. They get **different** ceilings and different height shares: the header **60% / 0.30**, the sub-line **45% / 0.20**, because the header carries the two numbers the node exists to compare while the sub-line labels something already visible on the canvas. At a shared size the header came out around a third of the counter and had to be leaned in for. In practice the header ends up **width-bound**, not height-bound: two nine- and ten-character numbers are over twice the counter's nine glyphs, so on a 700px-wide node it fills ~660 of 672 available px and cannot grow further without a wider node or a shorter format. It runs on resize and when any line changes length, never per frame: reading `scrollWidth` forces layout, and doing that in the animation loop would make the timer the most expensive thing on the canvas. On a node too short for everything, lines are hidden rather than clipped — the **sub-line first, the header second, the counter never**. |
| **Long node names** | The sub-line **wraps onto a second line** when one is not enough, rather than being cut off — `Ultimate SD Upscale With Model And Tiled VAE Decode` used to read `Ultimate SD Up…`. Capped at two lines (`-webkit-line-clamp`, which still puts an ellipsis on the last line it allows) so one verbose title cannot crowd out the clock, and `overflow-wrap: anywhere` so a single unbroken token breaks instead of sticking out. The line count is measured with wrapping switched **off** — the text's natural single-line width is what decides it, and `scrollWidth` on an already-wrapped element is just its own client width, which says nothing. The second line is taken only if it costs the counter little: the two candidate layouts are compared on their **width-corrected** counter sizes, since the clock is frequently width-bound anyway and the extra line is then free. Where it would really cost the clock, the name stays on one clamped line. The full text is always on the tooltip. |
| **Progress bar** | A three-pixel fill along the bottom edge: this run's elapsed time as a fraction of the previous run's total, coloured by the **same rule as the delta** so the bar and the number can never disagree. Absolutely positioned, so it costs the line budget nothing and `fit()` never has to know it exists. Hidden when there is no previous run to measure against, or no run of our own to measure — a bar with nothing behind it would be a made-up number. |
| **Per-node breakdown** | Every node is already timed for the sub-line; the totals are now kept. **Accumulated, not assigned**: a node in a loop or a batched run executes many times, and its total share of the run is the number worth reporting. While **idle** the sub-line shows `slowest: <node> — MM:SS:mmm`; why a run stopped still outranks it, so `interrupted` and `stopped on error` are unaffected. The finished breakdown survives until a later run replaces one, so the clipboard always holds the most recent complete answer, and a `stop` with nothing behind it cannot wipe it out. Nodes served **from cache** never execute and so never appear — the copied text says so, because their absence otherwise looks like a bug. |
| **Resetting the comparison** | **Reset previous run time** in the right-click menu forgets it, so the header returns to `N/A`, the delta with it, and the bar disappears until a run completes. The number lives in four places at once — the per-workflow map, its `localStorage` copy, every timer's own field, and the record of any run in flight — and leaving any one behind would have it reappear at the next paint or the next run. **Every timer on the same workflow** is reset, not just the one clicked, since the value belongs to the workflow rather than to one node. The per-node breakdown is deliberately *kept*: it describes a run that did happen, which resetting the previous *time* does not ask to forget. Disabled when there is nothing to forget. |
| **Copying it** | Two routes, neither costing the node any space: **click the sub-line** (it advertises itself in the tooltip and shows a pointer cursor only when there is something to copy), or **Copy timing breakdown** in the node's right-click menu, which is where ComfyUI puts per-node actions and which is disabled until a run has finished. The text is the node's title, the total, then every node with its time and percentage share, biggest first. A brief `breakdown copied` replaces the sub-line — only while idle, since a running timer repaints every frame and would wipe it. |
| **Stop** | The counter freezes at its final value. The sub-line drops the node name and returns to **`idle`** on completion, or says `stopped on error` / `interrupted` / `stopped` when a run did not finish or ended without saying how — a stale node name next to a stopped clock reads as though something is still running. |
| **Colour** | `hsl(120, 70%, 72%)` light green at zero, ramping to `hsl(0, 100%, 50%)` pure red at exactly **`full_red_minutes`**, and staying red after that. Interpolated in HSL, so it passes through amber rather than the muddy olive an RGB ramp would give. The counter, the previous-run cell and the delta all share the one `hslRamp(t)` gradient — only what they map onto `t` differs — so "light green" and "red" mean the same two colours everywhere on the node rather than three ramps that merely look alike. |
| **`full_red_minutes`** | The one setting, a float on the widget at the **bottom of the node**: how many minutes the counter takes to reach full red. Default `10.0`, range `0.1`–`600`, step `0.5`, unrounded. Declared in `nodes.py` so the graph serializes and restores it like any other widget; a widget added from JS alone would have to carry its own persistence. Read off the widget on **every paint** rather than captured once, because the value can arrive by being typed, by deserialisation, or from a connected primitive, and no single event covers all three. A blank (a widget legitimately holds `""` mid-edit), non-numeric or non-positive value falls back to the default instead of dividing by zero or painting `hsl(NaN, …)`; anything below `0.1` is clamped. Editing it repaints immediately, so a **stopped** clock re-colours as you type instead of waiting for the next run. |
| **Header** | One centred line at the top, holding both numbers **side by side**: the previous completed run's total, then the **delta** — this run minus that one, signed. They used to be pushed into opposite corners with `space-between`, which read as two unrelated readings with half the node between them instead of one comparison. Cross-axis alignment is `center` rather than `baseline`: both cells always carry the same size, so the two agree, and `center` cannot be thrown off by a content-height difference. **`fit()` restores the row's `display` by name (`HEADER_DISPLAY`), never as `""`** — assigning an empty string *deletes* the inline `display: flex`, and without it the two cells become block divs on separate lines which, being full-width, report the container's width as their `scrollWidth` and make the width pass halve the font. One assignment, both symptoms; the sub-line restores `DETAIL_DISPLAY` for the same reason. The three numbers on the node are kept consistent, so `left + delta == the counter`, which is what lets the header go without labels (there are tooltips instead). A cell reads **`N/A`** in muted grey when its number does not exist: no previous run to compare against, or no current time to compare with. |
| **Baseline** | The left cell is the run *before* the one on the clock, and it deliberately does **not** advance when a run finishes — otherwise the frozen header would compare a run against itself and read `+00:00:000`. The new value is picked up when the next run starts. Only a run that **completed** counts: the total of one that errored or was interrupted is not how long the workflow takes, and letting it in would make the next run look dramatically slower for no reason. Kept per workflow in a module-level map (capped at 64), not on the node, so it survives the node being destroyed and rebuilt — see the tab-switch note below — and **written to `localStorage`**, so it also survives a page reload. Before that, refreshing the browser sent the header back to `N/A`, which on a workflow you run a few times a day is most of the time. Storage is best-effort: a private window or a full quota just means the comparison is session-only again, which is not worth an error dialog. A node rebuilt while the workflow is idle recovers the baseline, but only once it actually has a graph: before that, `currentWorkflowId` falls back to `app.graph` and would hand it whichever workflow is on screen. |
| **Delta colour** | Ramped over **the previous run's duration**, not over `full_red_minutes`, which makes the gradient mean *how far through last time's budget are we*. At the instant a run starts the delta is exactly `-previous`, so it is light green; it walks through amber as the clock approaches what the last run took; and from the moment this run is the slower one — delta `>= 0` — it is **full red and stays red**, however far it overruns. Scaling by the previous run is what keeps that true for a five-second workflow and a five-hour one alike. The left cell, by contrast, is coloured by the same rule as the counter: `full_red_minutes`. |
| **Font** | Oxanium by default, pulled from `fonts.googleapis.com/css2?family=Oxanium:wght@400;700&display=swap`. Oxanium is a variable face (200-800), so the 700 used for the counter is real rather than a synthesised fake bold. Falls back to `'Courier New', monospace` if the request fails — Oxanium is proportional, so the monospace fallback is what keeps the digits from jittering on an offline install. |
| **`font_spec`** | The `family=` value, editable on the node: `Oxanium:wght@400;700` by default, `Roboto+Mono:wght@400;700` or `Inter:ital,wght@0,400;1,700` just as well. Spaces become `+`. Changing it loads that face and restyles the node **in place** — no reload. The value is per node, so the `<link>` is created **per distinct spec** rather than by rewriting one shared href, which would let whichever node changed last win for everybody. A different face means different metrics, so the layout is re-measured on change and again on the stylesheet's `load`, since every width measured before it landed was measured against the fallback. |
| **Sanitising it** | The value goes into a URL query *and*, via the family name, into a CSS `font-family`. Characters outside the small set the syntax actually uses are **dropped, not escaped**: an unescaped `&` would silently add a query parameter of its own, and a quote would end the quoted family name. A legitimate spec never contains them, so discarding them only ever affects garbage — and a visibly mangled family is easier to diagnose than a URL that quietly did something else. Blank or unusable falls back to the default. |
| **The toggle** | One **button** for both settings, added from JS rather than declared as a boolean input, because whether the fields are showing is view state and has no business in the serialized prompt. `serialize: false` also keeps it out of `widgets_values`: a button has no value, and letting it take a slot there would shift every widget after it on reload. Hiding uses `widget.hidden`, the frontend's own extension hook — it drops the widget out of layout (`getLayoutWidgets` filters `suppression.byExtension`) while leaving it in `node.widgets`, so **values still serialize while the fields are put away**. Opening it grows the node by a row per field rather than taking those rows off the clock; growing is one-way, since shrinking back would discard a size you had chosen. |
| **Reloaded workflows** | Deserialisation assigns widget values *without* calling their callbacks, so the font is re-applied from `onAdded` / `onConfigure` as well. Any setting that is no longer at its default also **opens the panel** on load, so a customised node does not look as though its settings were lost. Once you press the button yourself, it stops deciding for you. |
| **Per-node line** | Driven by **two independent sources** — `executing` and `progress_state` (whose `nodes` map reports every non-pending node's state). Either alone is enough, and both are idempotent, because a build may send only one of them to a given client. Shows the node's **workflow title** plus its own elapsed time. The title comes from the queued prompt's `_meta.title` — the same field the server reads in `execution.py` — not from a graph lookup, which is what made earlier versions fall back to showing a bare node id. Falls back to `class_type`, then a graph lookup, then the id. |
| **Subgraphs** | The prompt is flat: every executed node is a key, nested ones as `<a>:<b>:<c>`. So the sub-line names **any node in the run at any depth**, and the timer works whether it sits at the top level or inside a subgraph. Nested ids the prompt does not carry verbatim are rendered as a path (`Render Group / Upscale Group / 999`). |

### Why the settings have to be moved to the bottom

Widgets declared in the schema are built by the `ComfyNode` constructor, and `nodeCreated`
is invoked at the end of that same constructor — so the DOM widget holding the clock is
always *appended after* them, which would leave the settings sitting on top of the display.
The extension therefore reorders `node.widgets` into `timer → full_red_minutes → font →
font_spec` rather than relying on a construction order it does not control. The test models
the same order and asserts the result.

## Only this workflow's runs count

This is the part worth explaining, because it is the requirement that shapes the code.

Every run produces identical websocket events regardless of where it was queued —
another browser tab, another workflow tab, a script hitting the API. `prompt_id` is the
only thing that distinguishes them, and no event says which workflow a prompt came from.

So ownership is recorded at the one moment both facts are visible at once: queueing.
`api.queuePrompt` is wrapped, and for every timer node present in the outgoing prompt
the mapping `prompt_id -> that node` is stored. On `execution_start` the timer starts
only if its own node is in that prompt's owner set.

**The race that broke repeat runs.** `execution_start` can arrive over the websocket
before the queue POST's response has been parsed. On the first run of a session that
never happens — models are still loading, so the response always wins. On a repeat run
of the same workflow everything is cached and execution begins almost immediately, the
websocket gets there first, and a strictly response-keyed map misses it: the counter
keeps its old frozen value and never resets. So ownership is computed *before* the
await and parked in a **pending list**, and an event for an unknown `prompt_id` adopts from
it while the entry is fresh (15s). The test suite reproduces the race by stalling the
response on purpose.

A list rather than one slot, because the calls overlap. Queue several runs in a row — a batch
count, or just hitting Run repeatedly — and each new call used to overwrite the slot the one
before it had parked, so **every prompt but the last lost its only chance of being adopted**.
Entries are now held oldest first and claimed one at a time.

The map keys on the **node object**, not its id. Two different workflows can each
contain a node with id `7`, so an id comparison would cheerfully attribute a foreign
run to this timer; object identity cannot collide. A prompt this tab never queued is
simply absent from the map and therefore never owned — which is exactly the required
behaviour for another tab's run.

Consequences worth knowing:

- A run queued from a **different browser tab is ignored**, including a run of this same
  workflow. The timer only reports runs it saw queued.
- Per-node events do not all carry a `prompt_id`: `execution.py` sends one with
  `executing`, but `server.py`'s status/reconnect path sends `{node}` alone and older
  servers sent the bare id as the whole detail. Those fall back to "every timer currently
  mid-run", which is safe because a timer only runs once it has claimed an
  `execution_start`. Each timer also **keeps the prompt it claimed**, so those events still
  resolve titles from `_meta` — without that, a nested id on a prompt_id-less event renders
  as `node 105:9387` instead of the node's name. Without that fallback the sub-line sits on *waiting for the first
  node* for an entire run while the total counts up perfectly happily.
- A node's id is matched exactly at the top level, and by `:<id>` suffix only when the
  node really is nested. Without that condition a top-level timer would claim a prompt
  it is not in whenever some subgraph child happened to share its local id — which is
  precisely what a muted top-level timer looks like.
- Only prompts containing a timer node are recorded at all, and the map is capped at 64
  entries, so it cannot grow unbounded across a long session.
- **Switching workflow tabs mid-run is handled.** The frontend destroys the inactive graph
  and rebuilds it on return, so the node object that claimed the run no longer exists.
  Identity cannot survive that, but the prompt key can: the run remembers which keys belong
  to timer nodes, and a recreated node with a matching key rejoins the run and continues
  from the original start time (`performance.now()` is process-wide, so the elapsed time
  stays exact).

  **Timing is the subtle part.** `nodeCreated` fires from the ComfyNode constructor —
  `setInitialSize(this), this.serialize_widgets=!0, e.invokeExtensionsAsync('nodeCreated', this)`
  — which is *before* the node joins a graph and before deserialisation assigns its id. A
  rejoin attempted there can only fail, so it is retried from `onAdded`, `onConfigure` and a
  zero timeout, and is idempotent.

  To decide the node is in the right workflow, an equal workflow id is accepted as proof;
  otherwise the run's **other** node ids are looked for in this graph. Comparing
  `prompt.workflow.id` against a live `LGraph.id` is not safe on its own — they need not come
  from the same namespace, and an over-strict comparison refuses every rejoin. The timer's own
  id is excluded from that probe, since it matches by construction and would otherwise let a
  lone same-id timer in an unrelated workflow adopt the run. Removing a node stops its painting but
  never cancels the run record — deleting it was what left the returning timer at
  `00:00:000 idle` with the rest of the run unreported.

  **The header's baseline needs the same treatment for a different reason.** Rejoining only
  applies to a run still in flight; come back to a tab whose run has already finished and
  there is nothing to rejoin, yet the comparison should still be there. So the previous total
  is held per workflow rather than on the timer, and a rebuilt node recovers it — which is
  also why it must wait for a graph before asking which workflow it belongs to.

## Recovery: catching a run whose start was missed

`execution_start` is the only event that starts the clock, and one missed one used to cost the
**entire run**. Every per-node handler asks `if (timer.running)` first, so a timer that never
started ignored the whole stream of events that followed and sat at its last frozen value while
the workflow ran to completion. That start can genuinely go missing — a websocket reconnect
swallowing it, a queue of runs where the frontend batches faster than the responses come back,
an interrupt-and-immediately-rerun delivering events out of the expected order.

So the timer no longer depends on catching it.

| | |
|---|---|
| **Starting late** | Any per-node event for a prompt we own now starts the timer if it is not already running, on the grounds that **nodes do not execute outside a run**. Three independent events can trigger it: `executing`, `progress_state`, and `progress` — the last being the per-step sampler event, by far the most frequent of a run and therefore the quickest way back. |
| **Honesty about the total** | A recovered run's true start is unknown, so the count begins at the moment of recovery and the run is **flagged**, not silently passed off as exact. The counter's tooltip says the total is short by however long the run had been going, and the total is **not recorded as the baseline** for the next run's delta — the same reasoning that keeps a failed run out of it. If another timer in the workflow already caught the run properly, its exact start time is on the run record and gets used instead, and nothing is flagged. |
| **Adoption is guarded** | A per-node event may only claim a *pending* prompt when the node it names actually appears in that prompt. `execution_start` has no node to check and takes the oldest fresh entry, as before; broadening adoption to the much chattier per-node events without that check would let a foreign run's events walk off with a slot that is not theirs. |
| **Stopping when nothing says so** | The other half. Clearing the queue discards pending prompts **silently**, and an interrupt does not always reach this client as `execution_interrupted`, so a timer could count up forever. `status` carries `queue_remaining`, which is `len(queue) + len(currently_running)` on the server — zero means nothing is pending *and* nothing is executing, so whatever is still being counted has ended. The timer stops and says **`stopped`** rather than `idle`: a run that really finished would have produced `execution_success`, so this ending is genuinely unknown and its total is not trusted as a baseline either. |
| **The owners map** | Capped at 64, and the eviction no longer bails out when every remaining entry still claims to be live. A cancelled queue leaves entries that were never told they ended, and refusing to evict them let the map grow without bound; the oldest now goes regardless. |

## Files

| File | |
|---|---|
| `nodes.py` | The Nodes 2.0 schema. Two inputs (`full_red_minutes` and `font_spec`, both `socketless`, neither read server-side — they exist so the frontend gets persisted widgets), no outputs, nothing computed. `is_output_node` so the server executes it even though nothing consumes it; `not_idempotent` so it is not served from cache on later runs. |
| `web/workflow_timer.js` | Everything visible: the DOM widget, the font loading and the disclosure button, the progress bar, the per-node breakdown, the colour ramps, the three-line layout, the event wiring, the ownership map and the per-workflow record of the last completed run. |
| `test/run.mjs` | Headless test of the frontend logic against stubbed `app`/`api`/DOM — formatting, colour ramp, ownership, event handling. `cd test && node run.mjs`. |

## Tests

```
$ cd test && node run.mjs
  OK   00:00:000 at zero  00:00:000
  OK   65.432s -> 01:05:432  01:05:432
  OK   over an hour keeps counting minutes  60:00:001
  OK   starts light green  hsl(120.0, 70.0%, 72.0%)
  OK   mid ramp is amber  hsl(60.0, 85.0%, 61.0%)
  OK   fully red at 10:00  hsl(0.0, 100.0%, 50.0%)
  OK   stays red past 10:00  hsl(0.0, 100.0%, 50.0%)
  OK   hue falls monotonically
  OK   the settings sit below the clock, in order  timer -> settings -> full_red_minutes -> font_spec
  OK   full red at the configured 2 minutes  hsl(0.0, 100.0%, 50.0%)
  OK   and amber halfway to it  hsl(60.0, 85.0%, 61.0%)
  OK   raising it to 20 makes 10:00 no longer red  hsl(60.0, 85.0%, 61.0%)
  OK   but 20:00 is  hsl(0.0, 100.0%, 50.0%)
  OK   a blank or nonsense value falls back to 10 minutes  hsl(0.0, 100.0%, 50.0%) hsl(0.0, 100.0%, 50.0%) hsl(0.0, 100.0%, 50.0%) hsl(0.0, 100.0%, 50.0%) hsl(0.0, 100.0%, 50.0%) hsl(0.0, 100.0%, 50.0%) hsl(0.0, 100.0%, 50.0%)
  OK   an absurdly small value is clamped, not divided by zero  hsl(119.8, 70.0%, 72.0%)
  OK   editing the setting recolours a stopped clock at once  hsl(60.0, 85.0%, 61.0%) -> hsl(0.0, 100.0%, 50.0%)
  OK   a node with no widget list still ramps over the default 10 minutes  hsl(0.0, 100.0%, 50.0%)
  OK   the default stylesheet is requested at setup  https://fonts.googleapis.com/css2?family=Oxanium:wght@400;700&display=swap
  OK   every text element uses the default stack  'Oxanium', 'Courier New', monospace
  OK   the toggle is a button
  OK   and is kept out of widgets_values
  OK   both settings start hidden
  OK   and the button says what it will do  show settings
  OK   pressing it reveals both fields
  OK   and the label flips  hide settings
  OK   pressing it again puts them away
  OK   a new spec requests its own stylesheet  https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;700&display=swap
  OK   and every element switches to the new family  'Roboto Mono', 'Courier New', monospace
  OK   re-applying the same spec changes nothing
  OK   a dangerous spec cannot inject a second query parameter  https://fonts.googleapis.com/css2?family=Bad+FontfamilyEvil:wght@400&display=swap
  OK   and cannot break out of the quoted family name  Bad FontfamilyEvil
  OK   a blank spec falls back to the default  'Oxanium', 'Courier New', monospace
  OK   changing the font re-measures the layout  fit() called 1x
  OK   a freshly created node keeps the fields hidden
  OK   a loaded custom spec reveals the settings
  OK   and is applied without any callback  'Inter', 'Courier New', monospace
  OK   opening the panel grows the node rather than squeezing the clock  132 -> 184
  OK   closing it keeps the size  184
  OK   and reopening does not keep growing  184
  OK   counter grows with the node  32 < 67 < 143
  OK   sub-line grows with the node  13 < 26 < 56
  OK   sub-line stays smaller than the counter
  OK   the header is larger than the sub-line  32/19/13  67/40/26  143/85/56
  OK   but still smaller than the counter
  OK   and both header cells share one size
  OK   the header stays a flex row after a re-fit  display="flex"
  OK   and the sub-line keeps its -webkit-box  -webkit-box
  OK   a hide/show round trip restores flex, not empty  flex / -webkit-box
  OK   width constrains the counter  text 184px in 200px
  OK   never scales to zero  8
  OK   nothing overflows the node vertically
  OK   the sub-line is visible at every usable size
  OK   the header is visible at every usable size
  OK   wide flat node keeps all three lines  75.8 <= 76
  OK   an impossibly short node drops the sub-line instead of clipping  26.0 <= 26
  OK   and keeps the header in preference to the sub-line
  OK   a crushed node keeps the clock alone  13.5 <= 14
  OK   fit is not recomputed every frame
  OK   starts on our execution_start
  OK   counts up live  00:00:500
  OK   shows the workflow title, not the id  My Sampler — 00:00:250
  OK   times the executing node  My Sampler — 00:00:250
  OK   uses _meta.title when present  Timer — 00:00:050
  OK   stops on success
  OK   freezes the final total  00:03:321
  OK   stays frozen after the run  00:03:321
  OK   a second run restarts the counter  00:00:000
  OK   and counts from zero again  00:00:250
  OK   adopts a start that beat the response  00:00:000
  OK   and still names the node correctly  My Sampler — 00:00:100
  OK   the raced run stops cleanly
  OK   nested id with no prompt_id resolves its title  Deep Sampler — 00:00:120
  OK   and does not fall back to the raw id  Deep Sampler — 00:00:120
  OK   a legacy bare-id executing event works too  Timer — 00:00:080
  OK   the stored prompt is released on completion
  OK   sub-line starts out waiting  waiting for the first node…
  OK   progress_state names the running node  My Sampler — 00:00:300
  OK   stays on the same node and keeps its clock  My Sampler — 00:00:600
  OK   switches when the next node starts  Timer — 00:00:100
  OK   progress_state prefers display_node_id  Timer — 00:00:100
  OK   the resting sub-line reports the slowest node after the progress_state run  slowest: My Sampler — 00:00:600
  OK   run is going before the tab switch  00:01:500
  OK   leaving the tab only stops painting
  OK   cannot rejoin at construction time (no id, no graph yet)
  OK   the recreated node rejoins the run
  OK   and shows the true elapsed time, not zero  00:04:000
  OK   and the node line survived too  My Sampler — 00:04:000
  OK   later events reach the recreated node  Timer — 00:00:200
  OK   it stops with the whole run measured  00:05:000
  OK   and comes to rest on the slowest node  slowest: My Sampler — 00:04:000
  OK   a same-id timer in another workflow does not hijack the run
  OK   ignores a workflow without this node  00:00:700
  OK   ignores another tab's run entirely  00:00:700
  OK   a detached node is not claimed
  OK   stops on error  00:01:234
  OK   says why it stopped  stopped on error
  OK   stops on interrupt  interrupted
  OK   legacy null-node finish stops it  00:00:010
  OK   a top-level timer claims its own run
  OK   names a subgraph child by its title  Inner Sampler — 00:00:000
  OK   sub-line shows the node while running  My Sampler — 00:00:300
  OK   sub-line drops the running node on completion  slowest: My Sampler — 00:00:300
  OK   total is still frozen at the final value  00:00:300
  OK   both cells read N/A before any run  N/A | N/A
  OK   still N/A during the very first run
  OK   the first run leaves the header at N/A
  OK   and freezes its own total  00:04:000
  OK   the second run shows the first run's total on the left  00:04:000
  OK   the delta starts at minus the previous total  -00:04:000
  OK   and is light green there  hsl(120.0, 70.0%, 72.0%)
  OK   halfway through last time's budget the delta is amber  -00:02:000 hsl(60.0, 85.0%, 61.0%)
  OK   matching last time's total turns the delta red  +00:00:000 hsl(0.0, 100.0%, 50.0%)
  OK   and it stays red however far the run overruns  +00:02:000 hsl(0.0, 100.0%, 50.0%)
  OK   left + delta equals the clock  00:06:000
  OK   the delta's hue falls monotonically toward red  120 -> 90 -> 60 -> 30 -> 0 -> 0
  OK   a finished run still compares against the previous one, not itself  00:04:000 | +00:02:000
  OK   the previous-total cell follows full_red_minutes  hsl(40.0, 90.0%, 57.3%)
  OK   and goes back to near-green at 10 minutes  hsl(119.2, 70.2%, 71.9%)
  OK   the third run's baseline is the second run  00:06:000
  OK   a much faster run reads minus and stays green  -00:05:400 hsl(108.0, 73.0%, 69.8%)
  OK   a failed run does not become the baseline  00:00:600
  OK   nor does an interrupted one  00:00:600
  OK   a node rebuilt before it has a graph does not borrow another workflow's history  N/A
  OK   once it has one, it recovers the workflow's last total  00:00:500
  OK   but has no current time of its own to compare yet  N/A
  OK   a narrow node shrinks the header to fit its two numbers  12:34:321 + +12:25:679 = 148px in 170px
  OK   a long node name wraps onto a second line  clamp 2
  OK   the full name is in the text, not truncated  Ultimate SD Upscale With Model And Tiled VAE Decode — 00:00:100
  OK   and is on the tooltip as well  Ultimate SD Upscale With Model And Tiled VAE Decode — 00:00:100
  OK   two lines still fit inside the node  176.3 <= 220 on 2 line(s)
  OK   a short name goes back to one line with no resize  Timer — 00:00:100
  OK   and the long one wraps again  Ultimate SD Upscale With Model And Tiled VAE Decode — 00:00:100
  OK   a short node clamps the long name instead of shrinking the clock  90.0 <= 92 on 1 line(s)
  OK   no box overflows while a long name is showing
  OK   a timer inside a subgraph claims the run
  OK   a top-level timer not in that prompt stays idle
  OK   nested timer names a TOP-LEVEL node  My Sampler — 00:00:100
  OK   nested timer names a sibling in its own subgraph  Inner Sampler — 00:00:000
  OK   names a two-level-deep node  Deep Upscale — 00:00:000
  OK   unknown nested id reads as a path  Render Group / Upscale Group / 999 — 00:00:000
  OK   nested timer comes to rest too  slowest: My Sampler — 00:00:100
  OK   top-level timer ignores a same-id subgraph child
  OK   a missed execution_start is recovered from an executing event
  OK   and the sub-line names the node it recovered from  My Sampler — 00:00:400
  OK   the recovered run counts up  00:00:400
  OK   and says on the counter that its total is short  this run was already under way when the timer picked it up, so the total is measured from that moment and is short by however long it had been going
  OK   a recovered run still stops cleanly  slowest: My Sampler — 00:01:000
  OK   a recovered run does not poison the baseline  N/A
  OK   and a normally started run is exact again
  OK   progress_state alone also recovers the run
  OK   and names the node  My Sampler — 00:00:250
  OK   a sampler progress event recovers the run too
  OK   the first of several queued runs is adopted
  OK   and it measured its own time  00:00:500
  OK   the second one is still adoptable, not overwritten
  OK   and measured its own time as well  00:00:750
  OK   a per-node event for a node we do not have claims nothing
  OK   but one naming a node we do have is adopted
  OK   a run with no ending event keeps counting
  OK   a non-empty queue leaves it alone
  OK   an empty queue stops the stranded timer  00:03:000
  OK   and says so rather than claiming a clean finish  stopped
  OK   the idle sub-line names the slowest node  slowest: Big Sampler — 00:06:000
  OK   a node that ran twice has its times added up  Big Sampler=6000 Load Model=1000 Decode=500
  OK   and the rest are ordered biggest first  Big Sampler > Load Model > Decode
  OK   the clipboard text leads with the node title and the total  Run timer  total 00:07:500
  OK   every node appears with a share of the total  00:06:000   80.0%  Big Sampler
  OK   and it says why cached nodes are missing
  OK   the sub-line advertises the click  slowest: Big Sampler — 00:06:000
  OK   and shows a pointer cursor
  OK   clicking the sub-line copies the breakdown  Run timer  total 00:07:500
  OK   and confirms it in place  breakdown copied
  OK   the right-click menu offers the breakdown
  OK   and the menu entry copies the same text
  OK   with no finished run the menu entry is disabled
  OK   and clicking the sub-line copies nothing
  OK   nor does it offer a pointer
  OK   no bar without a previous run to measure against
  OK   the bar starts empty  0.0%
  OK   and light green  hsl(120.0, 70.0%, 72.0%)
  OK   it fills as the run approaches last time's total  50.0%
  OK   and is amber halfway  hsl(60.0, 85.0%, 61.0%)
  OK   it is full and red at last time's total  100.0% hsl(0.0, 100.0%, 50.0%)
  OK   and does not overflow when the run overruns  100.0%
  OK   the bar agrees with the delta's colour
  OK   the bar stays at the final value rather than vanishing
  OK   the last total was written to storage  {"wf-restored":12345,"wf-alpha":0,"wf-header":500,"wf-recover":750,"wf-breakdown":30000}
  OK   a time saved in a previous session is restored on load  00:12:345
  OK   a second timer on the workflow sees the same previous time  00:30:000
  OK   the right-click menu offers the reset
  OK   the header goes back to N/A  N/A | N/A
  OK   and the progress bar has nothing left to measure
  OK   the sibling forgets it too  N/A
  OK   it is gone from storage as well  {"wf-restored":12345,"wf-alpha":0,"wf-header":500,"wf-recover":750}
  OK   the breakdown is deliberately kept  slowest: Big Sampler — 00:06:000
  OK   with nothing left to forget the entry is disabled
  OK   the next run has no baseline to compare against
  OK   and the run after it compares against that one  00:02:000
  OK   evicts old prompts (map is capped)
all checks passed
```

These run against stubs, not a live ComfyUI: they prove the timing arithmetic, the
colour ramp and the ownership rules, not that the widget renders correctly in your
frontend build.

## Licence

GNU Affero General Public License v3.0 **or later** — full text in [`LICENSE`](LICENSE),
fetched verbatim from `gnu.org/licenses/agpl-3.0.txt`. Every source file carries the
standard notice plus `SPDX-License-Identifier: AGPL-3.0-or-later`.

Two things worth knowing about AGPL specifically, since this is a web extension:

- **§13, remote network interaction.** If you modify this and let people use the modified
  version over a network — a shared or hosted ComfyUI instance counts — you must offer
  those users the corresponding source of your modified version. Running an unmodified
  copy imposes no such duty.
- **It is copyleft, and strongly so.** Anything that combines with this code has to be
  AGPL-compatible. If you want this pack vendored into a permissively licensed project,
  that will not work without relicensing, which only the copyright holder can do.
