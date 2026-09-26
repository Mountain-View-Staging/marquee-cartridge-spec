# Marquee Surface engine — TypeScript

The on-screen rules of the [specification](../README.md), implemented once: give it a
committed cartridge and the passage of time, and it says what is on screen, when that
changes, and why. It draws nothing. A **host** (a browser page, a kiosk shell, an
authoring tool's preview) calls it from its display loop and draws what it returns.

- **Conformance:** passes all 19 scenarios of the [conformance suite](../conformance/README.md).
- **No runtime dependencies.** The compiled ES modules in `dist/` are committed, so a
  page or a program imports them directly; there is no build step for consumers.
- **Two parts:** the **Loader** (cartridge bytes → an immutable, indexed Snapshot, or a
  named failure) and the **engine** (Snapshot + ticks → render items and a trace).

```
src/            TypeScript source
  model.ts        the Snapshot: records and indexes
  schema.ts       the v25.0.1 baseline the Loader checks
  loader.ts       bytes → Snapshot, through a small database adapter
  snapshot.ts     decoded rows → indexed Snapshot
  errors.ts       CartridgeError and its codes
  venue-time.ts   venue timezone offsets, Day 1, the Surface show clock
  clock.ts        surfaceClock(), previewClock()
  rules.ts        the pure rules: file by orientation, start and duration, directives
  engine.ts       the state machine: tick, reports, the trace
  render.ts       RenderItem
  trace.ts        TraceEvent and the reason codes
  board.ts        the board resolver contract, a minimal resolver, page timing
  sqljs.ts        the adapter for sql.js (browsers)
  index.ts        the public entry (any JavaScript runtime)
  node.ts         the Node entry: index + a node:sqlite binding
dist/           compiled ES modules and type declarations — committed, never edited by hand
test/           unit tests (node --test) and the benchmark
```

## Using it

### In a browser, with sql.js

```js
import { loadCartridge, sqlJsOpener, createEngine, surfaceClock } from "./engine/dist/index.js";

const SQL = await initSqlJs({ locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}` });
const bytes = new Uint8Array(await (await fetch("SHOW26/LOBBY3.db")).arrayBuffer());
const snapshot = await loadCartridge(bytes, { open: sqlJsOpener(SQL) });

const engine = createEngine({ snapshot, slot: "portrait", orientation: "portrait", clock: surfaceClock() });

function frame() {
  const { renderItem, trace } = engine.tick(Date.now(), performance.now());
  for (const event of trace) console.log(event.code, event.message);
  if (renderItem) show(renderItem);   // your drawing code; see "The host" below
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

### In Node

`dist/node.js` is the same API with `loadCartridge` reading through `node:sqlite`
(Node 22.13 or later), so nothing needs installing:

```js
import { loadCartridge, createEngine, surfaceClock } from "./engine/dist/node.js";
const snapshot = await loadCartridge(new Uint8Array(readFileSync("LOBBY3.db")));
```

It is the module the conformance runner loads:

```bash
node conformance/run.mjs --engine engine/dist/node.js
```

## The host

Each tick, call `engine.tick(wallMs, monoMs)` with the wall clock (Unix ms) and a
monotonic clock (`performance.now()`). The engine samples one show-clock instant and
uses it for every decision in that tick. The returned object is **reused** by the next
tick; read it before ticking again.

When `renderItem` is not null, put it on screen and report back with its `token`:

| Report | When |
|---|---|
| `onFirstFrame(token)` | Its first frame is actually on screen. The engine arms the render marker from this moment and records the `render` event. |
| `onMediaCompleted(token)` | A video reached the end of its window (the out-point, or the end of the clip). |
| `onLoadFailed(token, reason)` | It cannot be shown: not held, not decodable, not fetched. The engine skips it. |

Only reports for the item on screen, from its first frame until its time is over or it is
cut, and for the item awaiting its first frame, are acted on; anything else is ignored, so a
late or repeated callback cannot move the rotation. A new render item supersedes any
earlier one that has not reported its first frame. With no first frame within 10 s of
monotonic time, the item counts as a load failure. A takeover that falls due while an item
is still loading, or before a late first frame's natural end, still cuts at its time.

Render items come in three kinds:

| `kind` | Put on screen |
|---|---|
| `media` | `media.mediaFileId` (the file in this orientation's slot, played as authored whatever its shape). Choose the rendition you hold (§7.6). Start a video at `media.start`; `media.duration` seconds later is its out-point (`null`: to the end of the clip). |
| `sessionBoard` | The board for `board.sessionSetId`, drawn from `board.model` (what your board resolver returned). Page `i` shows from the first frame + `i × board.pageDuration`, from `board.anchorPage`, wrapping — `boardPageAt()` computes it from a tick's `showNow`. |
| `blank` | Clear the screen: an authored blank (§5.2). Needs no report. |

`backing`, when present, goes behind the content (§5.10): a still holds, a video loops,
and neither advances the rotation. The frame rules that make a Surface look right are the
host's: hold the previous frame until the next item's first frame is ready and never
flash to black; clear only for a `blank`; stop a trimmed video on the last frame before
its out-point; play video with sound, muted only by a local device choice (§5.8).

Tell the engine about the world with `setOrientation(o)` (the operator's override, or a
new mount) and `commit(snapshot)` (a newly delivered cartridge). Both take effect at the
next tick, which cuts and re-evaluates.

## API

### Loader

| Export | |
|---|---|
| `loadCartridge(bytes, { open?, kind? }) → Promise<Snapshot>` | The Loader. `kind: "project"` reads `project.db` into a `ProjectSnapshot`. In `index.js`, `open` is required (`sqlJsOpener(SQL)`); `node.js` defaults to node:sqlite. |
| `sqlJsOpener(SQL)` | The database adapter for a loaded sql.js module. |
| `readCartridge(adapter, kind)` | The same checks over an adapter you already have: `{ all(sql) → rows, close?() }`. |
| `buildSnapshot(kind, rows, warnings)` | Rows keyed by wire column → Snapshot. For a tool that has the data without a file. |
| `isSqlite(bytes)` | The 16-byte magic check (§8.5). |
| `CartridgeError` | Thrown for a cartridge the Loader will not use. `code` is stable; `table` and `row` say where. |

`CartridgeError.code`: `not_sqlite`, `not_v25` (no `cartridge_meta`), `format_unsupported`
(first version component not 25), `kind_mismatch`, `meta_invalid`, `table_missing`,
`column_missing`, `table_unreadable`, `row_undecodable` (names the table and the row;
§10.3), `structure_invalid` (not exactly one `project` or `surface_config` row), `damaged`
(the magic is there but SQLite cannot read the file: a truncated or corrupted copy),
`no_sqlite_binding`.

Unknown tables and columns, and rows with an unknown enumerated value, load with a
**warning** in `snapshot.warnings` and are ignored (§10.4). So do dangling references,
malformed JSON columns, an unknown timezone, and a cartridge with no days.

A row holding a NUL byte (U+0000) in a text column is malformed (§4): skipped with a
`value.malformed` warning that names the column, or refused with the table's own code in
`cartridge_meta` (`meta_invalid`), `project` and `surface_config` (`structure_invalid`).
SQLite itself finds the byte, so every binding answers alike — including sql.js and
node:sqlite before Node 24, which end the string at it.

### Engine

| Export | |
|---|---|
| `createEngine({ snapshot, slot, orientation, clock, boardResolver? })` | One engine per lane. A Surface passes its orientation as both `slot` and `orientation`. |
| `engine.tick(wallMs, monoMs) → { showNow, projected, renderItem, trace }` | Evaluates the next content when the marker is forced (0) or `showNow ≥ marker`. A forced marker is a state of its own, not an instant compared with the show time, so a show time before 1970 (negative milliseconds, reachable from a preview clock) evaluates at the next tick like any other (§5.9). |
| `engine.onFirstFrame(token)`, `onMediaCompleted(token)`, `onLoadFailed(token, reason)` | Each returns the trace events it caused. |
| `engine.setOrientation(o)`, `engine.commit(snapshot)` | Applied at the next tick. The lane follows the orientation when it was the orientation's own. |
| `engine.inspect()` | What the engine sees at its last tick — the day, the schedule entry, every entry's gate and directive states, the working set, cursors, marker. For status views; allocates. |
| `engine.current`, `engine.currentSince`, `engine.pending`, `engine.showNow` | |
| `surfaceClock()` | The Surface show clock (§8.2). |
| `previewClock()` | An authoring tool's transport: `set(showMs)`, `play()`, `pause()`. Opens on the Surface value and runs at real-time rate on the monotonic clock. Commands apply at the next tick. |
| `minimalBoardResolver`, `boardPageAt(board, sinceShow, showNow)` | The board contract below. |
| `playbackWindow`, `fileIdFor`, `DirectiveSeries`, `Calendar`, … | The pure rules, for tools that want one without an engine. |

### Trace events

`{ showTime, kind, code, entryId?, set?, mediaFileId?, sessionSetId?, message }`. `code`
is the stable reason code from [the suite's table](../conformance/README.md#reason-codes);
`message` is plain words for operators and is never compared. A `render` is recorded at
the first frame; a `hold` on entering the hold, not on each retry.

### Session boards

A board's look is each platform's decision, so the engine asks an injected
`boardResolver(set, { showNow, timezone, entries, sessions, snapshot })` for
`{ model, pageCount, anchorPage }` once per render item. The board lasts
`session_set.duration × pageCount`. The resolver shipped here is minimal: one page, the
set's sessions in start order, each marked past, now, next or later.

## Where the specification leaves a choice

The rules the specification states are implemented as stated. Where it was silent, the
engine had to do something; these are the choices. The specification now lists them in its
§5.14, so a second implementation makes the same ones.

| Situation | What this engine does |
|---|---|
| Two directives, schedule entries or playlist entries share a timestamp or position | The higher `id` is later. Cursors compare (position, id). |
| No schedule entry for the lane has started yet | Holds (`set.empty`), like an empty working set, and plays from the first changeover. |
| Which `cut` an interruption records | One event per cause: a jump records `jump` only; a playlist change it causes resets the cursors silently. A cut is recorded only when an entry is on screen, naming it. |
| An authored blank | Re-evaluated every 2 s like a hold, without repeating the `blank` event. |
| Orientation change, new cartridge | Applied at the next tick; the `cut` carries that tick's show time. |
| Which failures count toward `set.all_failed` | Load failures (before or after the first frame), missing first frames, and entries that are not image or video media. The streak ends when an item finishes its time: naturally, at its watchdog, when it completes, or when a takeover cuts it. |
| A takeover due while the next item is still loading, or before a late first frame's natural end | It still cuts at its time (§5.9: only a takeover preempts a standard item, and it does so at its activation). The loading item is abandoned; a late item's marker is armed at the takeover instead. |
| The preview clock before its first command | Reads what a Surface would show now, and runs. |
| Day 1 on a daylight-saving date | §8.2's "next valid instant", read literally: a skipped local time becomes the moment the clocks change, and a repeated one the earlier instant. So on the days around a show whose Day 1 springs forward, the show clock stands at that moment for the hour the clocks skip, and whatever is on screen waits. The specification keeps this reading and says so in §8.2; shifting by the length of the gap was rejected because it adds one backward jump a day. |
| No orientation from the host | The gate is skipped (§5.1) and each entry plays the lane's slot, else the other one. |
| Day 1 clamp | A projection that lands outside Day 1 becomes Day 1's start, as §8.2 now states. The alternative reading, its end for a late time, differed only for a Day 1 that is not a whole day, which Studio does not produce. |
| Boundaries on the `demo_station` lane | Not the engine's: it resolves one playlist lane and has no mode. A host with a DemoStation mode watches that lane itself (§5.11). |

## Build and test

TypeScript is the only development dependency.

```bash
cd engine
npm ci
npm run build          # tsc: src/ → dist/ (commit dist/ with the source)
npm test               # unit tests: the Loader's refusals and warnings, engine behaviour
npm run conformance    # the 19 scenarios
npm run bench          # performance against the targets below
```

CI builds `dist/` and fails if it differs from what is committed.

## Performance

`npm run bench` on an Apple M-series laptop with Node 24, and the same cartridges loaded in
Chromium 152 through sql.js 1.10.3:

| | Node 24 | Chromium, sql.js | Target |
|---|---|---|---|
| A tick with no transition | 0.02 µs in the event, 0.04 µs outside it (synthetic Day 1) | 0.01 µs | < 100 µs |
| Allocation by an idle tick | 0 bytes over 1,000,000 ticks beyond the host's own call | — | none |
| `renderNext` | 500 entries: median 9 µs, p99 15 µs | 1,004 entries: mean 8 µs | < 2 ms for 500 |
| Loading a ~12,000-row cartridge | median 14 ms (node:sqlite) | median 22 ms | < 500 ms in a browser |

During a hold the engine evaluates the playlist again every 2 s of show time. That pass
builds no strings unless the hold is being recorded, but it runs too rarely for the
JavaScript engine to optimize, so its arithmetic allocates boxed numbers: about 110 bytes
per pass with the four-entry fixture (56 KB over 1,000,000 ticks, 500 passes). The ticks
between passes allocate nothing.

Outside the event, the venue's UTC offset is re-read from the platform once per quarter
hour; every other tick is arithmetic on numbers already held.
