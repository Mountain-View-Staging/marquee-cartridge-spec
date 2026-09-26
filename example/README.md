# Explorer and demo show

**Live:** https://mountain-view-staging.github.io/marquee-cartridge-spec/example/

`SHOW26/` is a complete v25.0.1 show: two ordinary SQLite cartridges, built with the DDL
in the specification, and every file their manifests name, with the size and SHA-256
the manifests give. A static site is a complete Marquee origin: the addressing is
`<base>/<projectCode>/<file>`, and this directory is the base.

`index.html` plays the show with the [reference engine](../engine/) on a **preview
clock**, the kind an authoring tool uses: pick any moment of either day and watch what a
Surface would put on screen, and read why in the engine's trace. The stage is drawn by
the same host as the [reference player](../player/).

## What the show makes visible

| Rule | Where to look |
| --- | --- |
| **Per-slot schedule resolution** (§5.2) | Switch Landscape / Portrait. Each lane runs its own playlist, and the switch cuts (`orientation.change`) and resolves the other lane. |
| **Takeover suppression and the immediate cut** (§5.5, §5.9) | Day 1, 11:59:50. At 12:00:00 SAFETY NOTICE takes over both lanes: the item on screen is cut (`takeover.activate`) and the standard rotation is suppressed entirely. |
| **Position cursors** (§5.6) | Day 1, 13:59:50. The takeover turns off at 14:00: the notice finishes its time, then the standard rotation resumes after the entry the takeover cut, not at the top. |
| **Day-scoped directives** (§5.4) | RECEPTION turns on at 17:00 on Day 1 and has no OFF. On Day 2 at 17:00 it is not on: Day 1's directive governs Day 1 only. The noon takeover was authored for Day 1 and does not happen on Day 2. |
| **An empty orientation slot excludes** (§5.7) | WAYFINDING has a portrait file only: the landscape playlist lists it and never plays it; the explorer says why. |
| **A slot's file plays as authored** (§5.7) | SPONSORS' portrait slot holds its landscape file: in portrait it plays letterboxed, over the project's backing. |
| **Composition** (§5.10) | The project's backing shows wherever content does not cover the stage; the session board has its own backing. |
| **A trimmed video** (§5.8) | The landscape SIZZLE REEL plays 1 s to 5 s of a 6 s clip and stops on the last frame before 5 s. |
| **A session board** (§4.7) | MAIN HALL: the room's sessions, now and next, drawn over its backing for `duration × pages`. |
| **An authored blank** (§5.2) | Day 2, 17:59:52. At 18:00 both lanes are scheduled with no playlist, and the screen clears. |
| **Synthetic time** (§8.2) | "Now, as a Surface sees it": outside the show's days, Day 1 at the venue's current time of day. |
| **Integrity** (§7.2) | Every file is checked against its size and SHA-256 before it is used. |

## Running it locally

`fetch` cannot read `file://`, and SHA-256 in the browser needs a secure context
(`localhost` counts). Serve the repository root, since the page imports `../engine/` and
`../player/`:

```bash
python3 -m http.server 8000
# http://localhost:8000/example/
```

## Rebuilding the demo show

```bash
cd example && python3 build-demo.py
```

It rewrites `SHOW26/` from scratch: both cartridges and all media, byte for byte the same
on every run with the same `ffmpeg`. No dependencies beyond `python3`. `ffmpeg` is optional
and only makes the video item; without it the show builds without that item rather than
failing. The script is a miniature publisher, and its comments say why each row is shaped
the way it is.
