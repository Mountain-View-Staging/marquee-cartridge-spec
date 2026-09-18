# Reference player

A Marquee player in plain JavaScript. No framework, no build step, no
dependencies beyond a SQLite binding.

**Live:** https://mountain-view-staging.github.io/marquee-cartridge-spec/player/

Images and video. One hard-coded cartridge, the way an installed player's
address effectively is — change three values at the top of `index.html` and it
plays a different screen.

```js
const SOURCE = { base: "../example", projectCode: "SHOW26", screenCode: "DEMO1" };
```

## The split, and why it is the point

| | |
| --- | --- |
| [`player.js`](player.js) | The resolution core. Takes an open cartridge and a moment in time, returns what should be on screen. **Touches no DOM.** |
| [`index.html`](index.html) | The shell. Fetching, `<img>`/`<video>`, timers, keys. |

`player.js` is the part worth porting. Every function is one section of the
[specification](../README.md), it is ordinary synchronous code with no
reactivity library, and `resolve()` is pure — same cartridge and same inputs,
same answer. That makes it testable with no screen attached, and it translates
directly into Kotlin, Swift, C++ or anything else with a SQLite binding.

## Keys

`O` orientation · `N` next · `S` overlay · `F` fullscreen

The status overlay reports what was resolved and why, including entries that
were **skipped and the reason**. A silently dropped asset is an empty slot every
rotation with nothing in any log, and it is the most expensive failure mode in
this system — so this player never drops one quietly.

## Two deliberate divergences from the iOS/macOS reference client

Both are things the specification carries but marks as not honoured there. This
player honours them, and the overlay says which number it used:

- **`media_item.display_duration`** — how long a still is held, instead of a flat 8 s.
- **The per-orientation trim window** — `start_time_*` / `end_time_*` as video in/out points.

## On state management

There is none, and that is a choice rather than an omission.

The TC39 [Signals proposal](https://github.com/tc39/proposal-signals) is a
natural fit for this shape — the resolution chain is a dependency graph, and
`Signal.Computed` with a custom `equals` would stop a once-a-second clock tick
from repainting the screen. It is **Stage 1** and has not shipped in any engine;
`globalThis.Signal` is undefined in current Chrome, Safari and Firefox, so using
it here would mean shipping a polyfill in a reference implementation.

The same problem is four lines without one: resolve, take a
[`signatureOf()`](player.js), and repaint only when it changes. That is what
`tick()` does, and it is why the video does not restart every second.

## Running it locally

`fetch` cannot read `file://`, so serve the repository root — the player reads
the demo show from `../example/`:

```bash
python3 -m http.server 8000
# http://localhost:8000/player/
```
