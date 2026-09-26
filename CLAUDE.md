# marquee-cartridge-spec

**⚠️ THIS REPOSITORY IS PUBLIC.** Everything committed here is visible to anyone. Read the
rules below before adding a single line.

The consumer-facing specification of the Marquee delivered-cartridge format: what a client
on any platform needs in order to play a show. Part of [MVSCollective](../CLAUDE.md), but
unlike every sibling it is published to the world.

```
README.md          the specification — CANONICAL
engine/            the reference engine: the Loader and the on-screen rules, in TypeScript;
                   compiled ES modules committed in engine/dist
conformance/       the conformance suite: fixture cartridges, 19 scenarios, the runner
example/           the explorer and the demo show: the engine on a preview clock
player/            the reference player: the engine on a browser host, one hard-coded surface
.github/workflows/ CI: the suite against the engine, dist/ freshness, unit tests, the leak scan
LICENSE            Apache-2.0, © 2026 Mountain View Staging
```

Live: <https://mountain-view-staging.github.io/marquee-cartridge-spec/>
(GitHub Pages, `main` branch, repo root — a push to `main` republishes.)

## What must never go in

- **No live infrastructure URLs.** The S3 media library and the R2 mirror bases are
  replaced with `example.net` placeholders. That bucket is world-readable, so a real base
  beside a real show code hands anyone a client's signage media.
- **No real show codes, screen codes, project ids, or client/event names.** Use the
  established examples: `SHOW26` / `LOBBY3`, `SHOW25` / `ATRIUM1`.
- **No internal record ids** (`AB-T-…`, `AB-D-…`), internal repo paths, or component names
  that only mean something inside the org. Describe roles instead — "the legacy web
  publisher", "the reference client".

Before committing, scan for leaks:

```bash
grep -rnE "\b(DF[0-9]{4}[A-Z]*|TBF[0-9]+|RG[0-9]+)\b|amazonaws|mvsmarquee|r2\.dev|\bAB-[TDL]-[0-9]{4}\b" \
  --exclude-dir=node_modules --exclude-dir=.git \
  --include="*.md" --include="*.html" --include="*.js" --include="*.mjs" --include="*.ts" \
  --include="*.py" --include="*.json" --include="*.yml" . | grep -v -e "CLAUDE.md:" -e "workflows/ci.yml:"
```

Anchored deliberately: an unanchored `DF[0-9]` matches the hex colour `#e6edf3` in both
players, and a check that cries wolf is a check people stop reading.

CI runs the same scan on every push and pull request. It does not catch everything the rules
above forbid — internal component names, for one — so read what you add as a stranger would.

The unsanitised version — the one with the real worked example — lives at
`MarqueeStudio/Documentation/SPEC-Cartridge-Client.md`, which is a pointer file. Keep it
that way; two copies of a 900-line format spec is how they drift.

## The README is the specification

Edit it here. There is also a Claude Docs rendering of it (a readable, commentable
mirror), and it is **not** canonical — it carries a banner saying so. A correction that
lands only there is lost.

When the format changes, this repo changes with it. The DDL is transcribed from the shared
schema (`MarqueeSchema`), so a migration there means a revision here.

## v25.0.1 — the format is greenfield

The README specifies **v25.0.1**, a clean break from the pre-v25 format: `surface_*` names,
`cartridge_meta` in both artifacts, required hashes and sizes, no Studio-player runtime
modifiers, no orientation fallback, position cursors, one render marker on synthetic time.
§14 lists every change. From v25.0.1 on, the compatibility contract (§10) governs: additive
changes only.

The on-screen rules (§5, §8) restate Marquee's internal platform specification. The two
change together, internal first. Keep the README complete on its own — it must never
require the internal document to be read.

## The engine

`engine/` is the one TypeScript implementation of §5 and §8; `player/` and `example/` only
draw what it returns. Rules for changing it:

- **Never edit a conformance trace to match the engine.** When they disagree, decide which is
  wrong against the specification and bring it back as a question. The traces are approved.
- **Rebuild and commit `engine/dist/` with the source** (`cd engine && npm run build`). CI
  fails when `dist/` is not what the source compiles to.
- **A rule the specification does not state is not invented.** Where the engine had to choose,
  the choice is listed in `engine/README.md` ("Where the specification leaves a choice") until
  the specification settles it. Keep that table true.
- A second engine (another language) must produce byte-identical traces, so the tie-breaks
  and choices in that table are part of the contract.

## Honesty about what the reference clients do

`player/` and `example/` run on the engine, and the README's Status note says what the
reference player does not do (it keeps nothing between page loads and does not re-pull).
Keep that note accurate, and if any rule is unimplemented in a reference client, mark that
rule in the README rather than letting the client silently disagree with it.

## The demo show

`example/SHOW26/` is two real SQLite cartridges plus real media, not fixtures. Rebuild:

```bash
cd example && python3 build-demo.py
```

No dependencies beyond `python3`; ffmpeg is optional and only for the video item (without
it the demo builds without that item rather than failing). The build is byte-for-byte
reproducible with the same ffmpeg. The content is chosen so the rules that are easiest to
get wrong are *visible*: per-slot resolution, takeover suppression and the immediate cut,
day-scoped directives, an entry skipped for an empty orientation slot, a landscape file
playing in a portrait slot, position-cursor resume after a takeover, a trimmed video, a
session board, backings, and an authored blank. `example/README.md` says where to look for
each. Every file carries its hash and size, and the Loader must load both cartridges with
no warnings.

## Verify before pushing

Pages serves from `main`, so a push is a publish.

```bash
cd engine && npm ci && npm run build && npm test && cd ..
node conformance/run.mjs --engine engine/dist/node.js     # 19/19
python3 -m http.server 8000     # then check /example/ and /player/ actually run
```
