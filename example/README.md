# A working example

A complete Marquee player in one HTML file, reading real cartridges.

**Live:** https://mountain-view-staging.github.io/marquee-cartridge-spec/example/

Nothing here is mocked. `SHOW26/` holds two ordinary SQLite cartridges built with
the DDL in the specification, plus the PNGs their `media_manifest` lists.
`index.html` opens them with sql.js and resolves what to show using the rules in
[§5](../README.md#5-the-resolution-algorithm). A static site is a complete
Marquee origin — the spec's addressing is `<base>/<projectCode>/<file>`, and this
directory *is* the base.

## What it demonstrates

| | Try it |
| --- | --- |
| **Per-slot schedule resolution** (§5.2) | Switch Landscape / Portrait — a different schedule entry resolves, so a different playlist plays |
| **Takeover suppression** (§5.5) | Scrub to 12:00–14:00 on Day 1. One takeover entry replaces the whole rotation; past 14:00 the standard rotation resumes |
| **Day-scoped directives** (§5.4) | The takeover is authored on Day 1 only. Scrub into Day 2 — it does not leak across |
| **Orientation fallback** (§5.6) | "Sponsors" has a landscape file only and is scheduled in the *portrait* playlist. It renders letterboxed rather than being dropped |
| **Provisioning** (§6) | The client adopts the orientation from the cartridge's single `screen_location` |
| **Hash-less media** (§7.3) | Every manifest row has `file_size` and no `content_hash`, like a legacy publisher's output. The client admits and *counts* them instead of rejecting the show |
| **Synthetic time** (§8.2) | The show's days are fixed in 2026. Opening the page any time projects your wall clock onto Day 1 |

## Running it locally

`fetch` cannot read `file://`, so serve the directory:

```bash
cd example
python3 -m http.server 8000
# http://localhost:8000
```

## Rebuilding the demo show

```bash
python3 build-demo.py
```

Rewrites `SHOW26/` from scratch — cartridges and media. No dependencies beyond
python3. The script is worth reading: it is a miniature publisher, and the
comments say why each row is shaped the way it is.

## What this client does not do

Video, the demo-station slot, session boards, and the trim and playback-state
columns. The specification marks each of those as carried-but-not-honoured by the
reference client, and this one is honest about the same gaps rather than
implying they are live.
