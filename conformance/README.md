# Marquee Conformance Suite

The executable definition of what a Marquee Surface puts on screen. A Surface engine conforms to
the specification when, for every scenario here, the trace it produces matches `expected.json`
exactly.

Both first-party engines — Swift and TypeScript — run this suite in CI. Third-party Surfaces are
welcome to run it too.

```
conformance/
  build.py            builds cartridges/*.db from the definitions in the script
  cartridges/         the fixture cartridges (committed; rebuild with build.py)
  scenarios/MCS-NN/   scenario.json (setup, clock, host behaviour) + expected.json (the trace)
  run.mjs             validates the suite, or runs it against an engine
```

```bash
python3 conformance/build.py                          # rebuild the cartridges
node conformance/run.mjs                              # validate the suite itself
node conformance/run.mjs --engine path/to/engine.js   # run every scenario
node conformance/run.mjs --engine path/to/engine.js MCS-02 MCS-10
```

No dependencies: `python3` 3.9+ and Node 22.13+ (built-in `node:sqlite`).

## The fixture show

All cartridges describe one fictional show: `SHOW26` / `LOBBY3`, venue timezone
`America/Los_Angeles`, Day 1 = 2026-09-15 (a whole venue-local day; `two-days` adds 2026-09-16).
One location, `LOBBY3-A`, portrait. There are no media bytes — an engine never reads them — so
manifest hashes are derived from file names.

IDs are systematic so a trace reads on its own:

| | |
|---|---|
| Playlist entry id | = its media item id = its position (playlist B uses 11, 12; a session board entry takes its position) |
| Portrait file id | 100 + item id |
| Landscape file id | 200 + item id |
| Stills | 10 s (`display_duration`) |
| Videos | 12 s (`intrinsic_duration`), no trim |

The **base** show: playlist A = entries 1–4, all standard ON at 08:00; entry 2 has a takeover
from 11:30 to 12:30. Other cartridges are variations, named for what they change.

## `scenario.json`

| Field | Meaning |
|---|---|
| `id`, `title`, `rules` | Identity and the rules under test |
| `cartridge` | Which `cartridges/<name>.db` to load |
| `engine` | `slot` and `orientation` the engine is configured with |
| `clock.source` | `surface` (real/synthetic show clock) or `preview` (Studio transport) |
| `clock.start` | Wall-clock start, ISO 8601 with offset |
| `clock.tickMs`, `clock.seconds` | Tick every `tickMs`; run ticks `0 … seconds − 1` |
| `clock.deviceTimeZone` | The process timezone while running. Engines must not depend on it. |
| `clock.commands` | Preview only: `{ atSecond, set?, action? }` with `action` `play` or `pause` |
| `host` | How the simulated host answers render items (below) |
| `events` | `{ atSecond, type: "wallJump", deltaMs }` — a wall-clock correction; `setOrientation` |

## The simulated host

The runner plays the host, the same way for every scenario. At each tick, in order:

1. Apply `events` and preview `commands` due at this second. The monotonic time is always
   `second × tickMs`; a `wallJump` moves only the wall clock.
2. Deliver scheduled video completions whose monotonic time has come.
3. Call `tick(wall, mono)`. If it returns a render item, answer it:
   - entry in `host.failEntries` → `onLoadFailed`, then **tick again at the same instant**
     (up to 64 times), so a skip and its replacement land on the same tick;
   - entry in `host.noFirstFrameEntries` → no answer at all;
   - otherwise → `onFirstFrame` at once. A video not in `host.stuckEntries` then has its
     completion scheduled at `mono + duration`. **Completions are delivered even if the item has
     since been replaced** — a real player's late callback — and the engine must ignore them.
4. A `blank` render item needs no answer.

Session board page counts come from `host.boardPages` (`{ "<session_set id>": pages }`) through
an injected board resolver. Production resolvers are checked against the same page counts
separately.

## The trace

`expected.json` is `{ id, trace: [event, …] }`. Events are compared field for field, in order.

| Field | Present on | Meaning |
|---|---|---|
| `t` | all | Show-clock time, ISO 8601 with the venue offset (compared as Unix ms) |
| `kind` | all | `render`, `cut`, `jump`, `hold`, `blank`, `skip`, `warning` |
| `code` | all | The stable reason code (below) |
| `entry` | render, cut, skip | The playlist entry concerned (for `cut`, the item that was on screen) |
| `set` | render | `standard` or `takeover` |
| `file` | render of a media item | The media file for this orientation |
| `board` | render of a session board | The session set |

A `render` event is recorded when the host reports the item's **first frame**. Nothing is
recorded for a natural end: the next `render` shows when it happened.

### Reason codes

Codes are the stable contract; any human-readable text an engine attaches is free to change.

| Kind | Code | Meaning |
|---|---|---|
| render | `rotation.start` | First entry of a set: no cursor yet, or a takeover period beginning |
| render | `rotation.next` | The first entry after the cursor's position |
| render | `rotation.wrap` | Nothing after the cursor, so the first entry again |
| cut | `takeover.activate` | The standard → takeover transition (a `time` hint reached) |
| cut | `schedule.change` | A schedule boundary changed the active playlist |
| cut | `orientation.change` | The host changed orientation |
| cut | `cartridge.commit` | A new cartridge was committed |
| jump | `jump.backward`, `jump.forward` | A show-clock jump (Reference §5.5); re-evaluation follows at once |
| hold | `set.empty` | The working set is empty; the last frame stays |
| hold | `set.all_failed` | Every entry of the working set failed in a row; retrying after 2 s |
| blank | `schedule.blank` | The schedule entry's playlist is NULL: an authored blank |
| skip | `media.load_failed` | The host reported a load failure |
| skip | `media.no_first_frame` | No first frame within 10 s of monotonic time |
| skip | `media.watchdog` | A video did not complete within its duration + 10 s |
| skip | `media.not_playable` | A brand asset or other non-playable item in a playlist |
| warning | `orientation.missing` | No orientation supplied; the orientation gate was skipped |

**Holds are recorded on entry, not on retry.** A `hold` is recorded unless the previous
`render`, `hold`, or `blank` event was a `hold` with the same code. Skips are always recorded.

## The engine module

`run.mjs --engine <module>` imports an ES module exporting:

| Export | Contract |
|---|---|
| `loadCartridge(bytes) → Promise<Snapshot>` | The Loader |
| `surfaceClock()`, `previewClock()` | Clock sources; the preview clock has `set(showMs)`, `play()`, `pause()` |
| `createEngine({ snapshot, slot, orientation, clock, boardResolver })` | Returns an engine |

The engine has `tick(wallMs, monoMs) → { renderItem?, trace }`, and `onFirstFrame(token)`,
`onMediaCompleted(token)`, `onLoadFailed(token, reason)`, `setOrientation(o)`, each returning the
trace events they caused. A trace event carries `showTime` (ms), `kind`, `code`, and as relevant
`entryId`, `set`, `mediaFileId`, `sessionSetId`. A render item carries `token`, `kind`
(`media`, `sessionBoard`, `blank`), `entryId`, and for media `media.contentType` and
`media.duration` (seconds). The Swift runner in `MarqueeSurfaceEngine` reads the same folders and
applies the same host rules.

## Scenarios

| ID | Scenario | Cartridge | Rules |
|---|---|---|---|
| MCS-01 | Basic rotation | `base` | Reference §6.5, §6.6 |
| MCS-02 | A takeover starting mid-item cuts immediately | `base` | Reference §6.6, §6.7 |
| MCS-03 | A takeover ending mid-item lets it finish; standard resumes after its cursor | `short-takeover` | Reference §6.5, §6.7 |
| MCS-04 | A standard directive turning off mid-item lets it finish; the entry then drops out | `e3-off` | Reference §6.3, §6.7 |
| MCS-05 | The cursor's entry is excluded during a takeover; standard resumes at the next position | `e3-off-during-takeover` | Reference §6.5 |
| MCS-06 | Overlapping takeovers form one set in position order | `two-takeovers` | Reference §6.4 |
| MCS-07 | Outside the event, a device in another timezone shows Day 1 at the venue's time of day | `base` | Reference §5.3, INV-01 |
| MCS-08 | Synthetic time before the first directive holds, then plays when it turns on | `base` | Reference §5.3, §6.4 |
| MCS-09 | Show-clock jumps, backward and forward, force re-evaluation | `base` | Reference §5.5 |
| MCS-10 | A multi-page session board lasts duration × pages; a takeover cuts it mid-board | `board` | Reference §6.8, INV-08 |
| MCS-11 | Video: completion, a load failure, and the watchdog | `video` | Reference §6.6, §6.9 |
| MCS-12 | A schedule change to another playlist cuts immediately and resets cursors | `schedule-change` | Reference §6.2, §6.7 |
| MCS-13 | Directives are scoped to the current day | `two-days` | Reference §6.3 |
| MCS-14 | Studio preview: set, play, pause | `base` | Reference §5.4, §5.5 |
| MCS-15 | Orientation slots: an empty slot excludes; a slot's file plays as authored | `orientation` | Reference §9.4, INV-14 |
| MCS-16 | Every entry fails: the engine holds and retries, never disarming | `base` | Reference §6.6, INV-10 |
| MCS-17 | No first frame within 10 s is a load failure | `base` | Surface Engine PRD §5.6 |
| MCS-18 | A late completion from a replaced item is ignored | `late-callback` | Surface Engine PRD §5.6 |
| MCS-19 | Same-playlist boundary is a no-op; a NULL playlist blanks | `boundaries` | Reference §6.2 |

Expected traces were derived by hand from the specification and are reviewed before either
engine exists. When an engine disagrees with a trace, decide which is wrong against the
specification — never edit a trace to match an engine.

## Adding a scenario

1. Add or reuse a cartridge definition in `build.py`, and run it.
2. Add `scenarios/MCS-NN/scenario.json` and `expected.json`.
3. `node conformance/run.mjs` must report every scenario well-formed.
4. Keep everything fictional (see the repository's `CLAUDE.md`), and run its leak scan.
