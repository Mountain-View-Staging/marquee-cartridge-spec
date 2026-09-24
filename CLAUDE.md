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

## Honesty about what the reference client does

Several schema fields are carried in cartridges but **not honoured** by the iOS/macOS
client: the v4 playback flags, `shuffle` and `audio_priority`. The spec marks each one.

Two items have left that list, each with a warning kept in the spec until the old
builds are gone from the field:
- `display_duration` and the per-orientation trim columns, from the Apple client's
  2026-09-23 build (§5.7).
- Session-set rendering, from its 2026-09-21 build (§4.7).
In both cases macOS has it from that build and iOS from its next release.
`player/` draws no boards, but `resolve(..., { sessionBoards: true })` keeps them in
the rotation for a client that does.

**Keep those marks accurate.** An implementer who honours a field the reference client
ignores has diverged, and that has to be a decision they made knowingly rather than a
surprise at a venue. `player/` implements §5.7's start and duration, the rule the
authoring tool resolves entries with, and says so in its own README.

## The demo show

`example/SHOW26/` is two real SQLite cartridges plus real media, not fixtures. Rebuild:

```bash
cd example && python3 build-demo.py
```

No dependencies beyond `python3`; ffmpeg is optional and only for the video item (without
it the demo builds image-only rather than failing). The content is chosen so the rules that
are easiest to get wrong are *visible* — per-slot resolution, takeover suppression,
day-scoped directives, orientation fallback, and hash-less media. If you change it, keep
each of those demonstrable, and keep `content_hash` NULL: a client that refuses hash-less
media must fail on this demo exactly as it would in the field.

## Verify before pushing

Pages serves from `main`, so a push is a publish.

```bash
python3 -m http.server 8000     # then check /example/ and /player/ actually run
```
