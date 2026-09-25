# marquee-cartridge-spec

**⚠️ THIS REPOSITORY IS PUBLIC.** Everything committed here is visible to anyone. Read the
rules below before adding a single line.

The consumer-facing specification of the Marquee delivered-cartridge format: what a client
on any platform needs in order to play a show. Part of [MVSCollective](../CLAUDE.md), but
unlike every sibling it is published to the world.

```
README.md          the specification — CANONICAL
example/           a spec explorer: clock scrubber, resolution trace
player/            a reference player: images + video, one hard-coded cartridge
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
  --include="*.md" --include="*.html" --include="*.js" . | grep -v "CLAUDE.md:"
```

Anchored deliberately: an unanchored `DF[0-9]` matches the hex colour `#e6edf3` in both
players, and a check that cries wolf is a check people stop reading.

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

## Honesty about what the reference clients do

`example/` and `player/` still implement the **pre-v25** rules, and the README says so in its
Status section. Until they are rebuilt against v25.0.1, keep that note accurate. When they
are, remove it — and if any rule is still unimplemented in a reference client, mark that
rule in the README rather than letting the client silently disagree with it.

## The demo show

`example/SHOW26/` is two real SQLite cartridges plus real media, not fixtures. Rebuild:

```bash
cd example && python3 build-demo.py
```

No dependencies beyond `python3`; ffmpeg is optional and only for the video item (without
it the demo builds image-only rather than failing). The content is chosen so the rules that
are easiest to get wrong are *visible*. **Pending the v25.0.1 rebuild,** it demonstrates the
pre-v25 rules. The v25 demo must make these visible instead: per-slot resolution, takeover
suppression and the immediate cut, day-scoped directives, an entry skipped for an empty
orientation slot, a landscape file playing in a portrait slot, and position-cursor resume
after a takeover. Media must carry hashes and sizes (v25 requires them).

## Verify before pushing

Pages serves from `main`, so a push is a publish.

```bash
python3 -m http.server 8000     # then check /example/ and /player/ actually run
```
