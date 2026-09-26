# Reference player

A Marquee Surface in a browser: the [engine](../engine/) decides what is on screen and
when, and this folder draws it. Plain JavaScript, no framework, no build step; sql.js is
the only thing it loads.

**Live:** https://mountain-view-staging.github.io/marquee-cartridge-spec/player/

It plays one hard-coded surface, the way an installed player's address effectively is.
Change three values at the top of `index.html` and it plays another:

```js
const SOURCE = { base: "../example", projectCode: "SHOW26", surfaceCode: "DEMO1" };
```

## The split

| | |
| --- | --- |
| [`../engine/`](../engine/) | Every rule: the show clock, the schedule, directives, takeovers, rotation, durations, the trace. Touches no DOM. |
| [`host.js`](host.js) | The browser host: calls the engine each frame, draws what it returns, reports first frames, completions and failures. Shared with the [explorer](../example/). |
| [`media.js`](media.js) | Media: chooses a rendition per file, fetches it, verifies size and SHA-256, and holds it. |
| [`index.html`](index.html) | The surface: loading, provisioning, keys, the status overlay. |

## What it does

- **Loads both artifacts** (§1) through the engine's Loader, which checks the SQLite magic, the
  artifact's kind and its format version, and refuses anything else with a reason.
- **Provisions** (§6). With one installation it takes it; with several it asks which one this
  is and remembers the answer while the cartridge still lists it. The answer is stored per
  show and surface code, so changing the address forgets it.
- **Fetches and verifies media** (§7) before the first frame: the browser's rendition order
  (`webOptimized` first; HEVC only if the browser says it can play it), then size, then
  SHA-256, each failure reported in its own words. A file that fails is not held, and the
  engine skips its entry when its turn comes.
- **Runs the engine** from `requestAnimationFrame` on the Surface show clock (§8.2): real
  venue time during the show, and Day 1 at the venue's time of day before and after it.
- **Follows the host frame rules** (§5.8): the next item is prepared out of sight and shown
  only when its first frame is ready, so nothing flashes to black; the stage clears only for
  an authored blank; a trimmed video stops on the last frame before its out-point; video
  plays with sound unless muted.

## Keys

`O` orientation (the operator's override, §6) · `M` mute · `S` status overlay ·
`F` fullscreen · `L` choose the installation again

The overlay reads the engine's own account of itself (`engine.inspect()`) and its trace: the
schedule entry and playlist, the working set and what a takeover suppresses, entries
excluded and why, the next change, what is on screen and for how long, and the last few
decisions with their reason codes. The full trace goes to the console.

## Sound

Video plays with its sound (§5.8). A browser may refuse sound until someone interacts with
the page; when it does, the player plays the video muted, says so on screen, and restores
sound at the first click or key press. `M` is the device's own mute and is remembered.
A kiosk browser can be started with its autoplay restriction lifted. A backing video is
kept silent by this player: the content's sound is the one that matters.

## Running it locally

`fetch` cannot read `file://`, and SHA-256 in the browser needs a secure context
(`localhost` counts), so serve the repository root:

```bash
python3 -m http.server 8000
# http://localhost:8000/player/
```
