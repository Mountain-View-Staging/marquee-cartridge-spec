# Session Board Templates — the package, the data document and the host

**Status:** the contract behind specification §5.15, published 2026-10-01 with the format's first
baseline revision; manifest 1.3 and data 1.2 (the project-only **clock** layout) the same day. The reference template and engine are in [`template/`](template/):
`template/default/` is the package every reference client carries, and `template/engine/` the shim
it embeds (with a vendored, unmodified copy of [nunjucks](https://mozilla.github.io/nunjucks/) 3.2.4,
BSD-2-Clause).

A **session board template** is how a Surface draws a session board (specification §4.7): a zip a
Surface extracts and loads into a web view, which it feeds with one JSON **data document** per
render. The template's page renders the board; the Surface's engine decides what the board says
(now, next, the pages of the day) and when it changes. No server renders anything; any modern
browser engine draws it. A template may also draw the **clock** a project-only Surface shows over
the Show's wallpaper (specification §5.15), as a third layout.

## 1. The package

A zip, `<id>-v<version>.marqueetemplate.zip`, whose root holds:

```
template.json                 the manifest (§2)
index.html                    the page shell: the mount, the shared stylesheet, the engine
styles.css                    styles shared by every layout
layouts/<name>.html           one nunjucks source per layout the template offers (§3)
layouts/<name>.css            that layout's own styles, optional
fonts/*.woff2 | *.woff        the template's typefaces (§6)
engine/marquee-template.js    the shim (§4), versioned
engine/nunjucks.js            the template language, vendored
preview.html, preview.png     a self-contained preview and a picture, for pickers; never what a host loads
```

Everything a page references is inside the package, by a package-relative path. **No external
URL** is allowed in `index.html`, the stylesheets or the layout sources (a sign is offline); a
URL inside a comment is tolerated. A Surface refuses a package that breaks this, by name.

**The template is trusted content.** nunjucks does not sandbox: the people who author a template
and the operator who attaches it are trusted, and the data document is autoescaped. The shim fetches
nothing but the package; a host serves the package from an origin of its own (§7).

## 2. `template.json` — format `1.3`

```json
{
  "format": "1.3",
  "id": "example-board",
  "displayName": "Example — now / next and schedule",
  "version": 3,
  "basedOn": { "id": "example-board", "version": 2 },
  "engine": "1.3",
  "data": "1.2",
  "layouts": {
    "now-next": { "source": "layouts/now-next.html", "style": "layouts/now-next.css" },
    "schedule": { "source": "layouts/schedule.html", "style": "layouts/schedule.css" },
    "clock":    { "source": "layouts/clock.html",    "style": "layouts/clock.css",
                  "textRegion": { "x": 0.12, "y": 0.68, "w": 0.76, "h": 0.24 } }
  },
  "supports": { "orientations": ["portrait", "landscape"], "aspects": ["9x16", "16x9", "3x4", "4x3"] },
  "textRegion": { "x": 0, "y": 0, "w": 1, "h": 1 },
  "roles": {
    "title":       { "label": "Title",       "default": "text.auto",      "contrast": "large" },
    "name":        { "label": "Name",        "default": "text.auto",      "contrast": "large" },
    "description": { "label": "Description", "default": "text.autoMuted", "contrast": "large" },
    "clock":       { "label": "Clock",       "default": "text.auto",      "contrast": "large" },
    "accent":      { "label": "Accent",      "default": "palette.primary" }
  },
  "vars": {
    "sponsorName": { "label": "Sponsor line", "default": "" }
  },
  "modifiers": {
    "align":   { "kind": "choice", "label": "Text alignment", "options": ["left", "center", "right"], "default": "left" },
    "compact": { "kind": "toggle", "label": "Compact spacing", "default": false }
  },
  "brand": {
    "displayName": "Example",
    "cssFamily": "Inter",
    "palette": { "primary": "#3B82F6", "secondary": "#1E3A8A", "tertiary": "#F59E0B", "quaternary": "#64748B" },
    "text": { "onLight": "#111827", "onDark": "#F9FAFB", "mutedOnLight": "#4B5563", "mutedOnDark": "#C7CCD4" }
  },
  "fonts": [
    { "cssFamily": "Inter", "licence": "SIL Open Font License 1.1 (fonts/Inter-OFL-1.1.txt)",
      "faces": [
        { "file": "fonts/Inter-Regular.woff2", "weight": 400, "style": "normal", "postScriptName": "Inter-Regular" },
        { "file": "fonts/Inter-Bold.woff2",    "weight": 700, "style": "normal", "postScriptName": "Inter-Bold" }
      ] }
  ],
  "files": { "index.html": "sha256:…", "styles.css": "sha256:…", "layouts/now-next.html": "sha256:…" }
}
```

| Field | Rule |
|---|---|
| `format`, `engine`, `data` | The manifest, shim and data-document formats, `major.minor`. A host reads the major it knows; a newer minor is accepted. |
| `id` | `^[a-z0-9-]{1,64}$`. `version` a positive integer. A package is immutable once exported: a change is a new version. `basedOn` records what it was adapted from. |
| `layouts` | **The layouts the template offers**, an object keyed `now-next`, `schedule` and / or `clock`. Each names its `source` (a nunjucks fragment, `.html`) and an optional `style` (`.css`), package-relative, no `..`, no dot segment, and may name its own `textRegion` (below). A sign chooses which of the two boards it shows (specification §5.15); a template offers one board layout or both. `clock` (manifest 1.3) is the project-only Surface's date and time over the Show's wallpaper (§4, §7); a template that does not offer it leaves the clock to the Surface's default template. |
| `supports`, `textRegion` | Advisory: the orientations and aspect families the template was designed for (it still renders elsewhere), and where its text falls on the canvas — `{ x, y, w, h }`, fractions 0…1 — for a host that measures its backing there (§7). `layouts.<name>.textRegion` (manifest 1.3) overrides the top-level one for that layout: a clock in a band at the foot of the screen is read there, not across a board's whole canvas. |
| `roles` | Named colours the template draws with (§5). `default` is a brand slot (`palette.primary` …), a text colour (`text.onDark` …), `text.auto` / `text.autoMuted` (the text pair that reads over the backing), or `#RRGGBB`. |
| `vars` | Named variables with a `label` and a string `default`: content the Show fills (specification §5.15 `template_settings.vars`). |
| `modifiers` | The template's style switches, chosen by the sign (§5). `choice`: one of `options`, the class `mod-<name>-<option>`. `toggle`: on or off, the class `mod-<name>` when on. Names and options `^[a-z0-9-]{1,32}$`; `marquee` is reserved as a prefix; `default` is required and must be an option (or a boolean). |
| `brand` | The palette and text pair the template was authored against; `cssFamily` its family. The template's brand travels inside the package. |
| `fonts` | Each family's faces as files in `fonts/`, with `weight`, `style` and `postScriptName`; the shim writes `@font-face` from this (§6). |
| `files` | SHA-256 of every text file and font, so a tampered package is refused by name. `template.json`, the engine and the previews are never hashed. |

## 3. Layouts

A layout source is a nunjucks template that renders **the whole board** for that layout into the
page's mount, `<div id="marquee-root">`, from the data document (§4) as its context. The shim loads
every declared source from the package at page load, compiles it once, and on each update renders
the one whose name is the document's `board.renderMode`. A layout's `style`, when named, is linked
into the page before the first render. Nothing else in the page is touched.

The shim's filters: `time` and `date` (an instant in the venue zone, as the Surface's own board
writes them), `role` (a role's resolved colour). The template language is nunjucks as documented
publicly; `{% include %}` of a path is never used (every source is a file the manifest names).

The `clock` layout renders from the same context as a board: `clock.time` and `clock.date` are the
show clock in the venue zone, `board.header` the Show's name, and there are no slots.

## 4. The data document — format `1.2`

One JSON object per **render**. The Surface's engine produces it from its resolution of the
session set (specification §4.7, §5.8): the engine decides what a render needs and delivers that
subset. A schedule of several pages is several renders, one per page, each carrying that page's
rows; the template pages nothing and filters nothing.

```json
{
  "format": "1.2",
  "clock":  { "showNow": 1789570800000, "zone": "America/Los_Angeles", "projected": false,
              "time": "8:45 a.m.", "date": "Tuesday, September 15" },
  "board":  { "renderMode": "schedule", "header": "Main hall", "resolvedAt": 1789570800000,
              "pageCount": 3, "page": 0,
              "nowNext": null, "signage": null,
              "schedule": { "roomName": "Main hall", "rowCount": 12,
                            "rows": [ { "id": "s-1", "title": "Opening", "time": "9:00 a.m.", "status": "now" } ] } },
  "slots":  [ { "id": "s-1", "title": "Opening", "abstract": "…", "startTime": "9:00 a.m.", "endTime": "9:45 a.m.",
                "isNow": true, "isNext": false,
                "presenters": [ { "name": "A. Example", "company": "Example Co", "title": "CTO" } ], "attributes": [] } ],
  "vars":   { "sponsorName": "Example Co" },
  "modifiers": { "align": "right", "compact": true },
  "brand":  { "displayName": "Example", "cssFamily": "Inter", "ink": "onDark",
              "palette": { "primary": "#3B82F6" }, "text": { "onLight": "#111827", "onDark": "#F9FAFB" } },
  "roles":  { "title": "#F9FAFB", "name": "#F9FAFB", "description": "#C7CCD4", "clock": "#F9FAFB", "accent": "#3B82F6" },
  "canvas": { "width": 2160, "height": 3840, "host": "apple" }
}
```

| Key | Meaning |
|---|---|
| `clock` | The engine's show clock (specification §8), in the venue zone — never the device's clock. `projected` is true when the clock is not live (a preview). |
| `board` | The resolved board for THIS render: `renderMode` names the layout (`now-next`, `schedule` or `clock`); `page` / `pageCount` which page this is; `nowNext` + `signage` for a now / next render, `schedule` with this page's `rows` for a schedule render; the other is null. A **clock** render (data 1.2) is one page: `{ renderMode: "clock", header: <the Show's name>, page: 0, pageCount: 1, resolvedAt, nowNext: null, signage: null, schedule: null }`, with `slots: []`. |
| `slots` | The sessions this render shows, normalised: `presenters` as `{ name, company, title }`, times as strings in the venue zone, `isNow` / `isNext`. |
| `vars` | Every declared variable with the Show's value, else its default (specification §5.15). |
| `modifiers` | Every declared modifier with the device's value, else its default: an option name for a `choice`, a boolean for a `toggle`. |
| `brand`, `roles` | The package's brand with `ink` — the text pair that reads over the backing the host measured (`onLight` or `onDark`) — and every role resolved to `#RRGGBB`. |
| `canvas` | The destination's own pixel size and the host's name (`apple`, `browser`, or another host's). Orientation, aspect family and size tier are derived by the shim, not sent. |

Keys are sorted and numbers are integers, so two producers of the same render write the same bytes.

## 5. What the shim puts on `<html>`

Before every render the shim sets, on the root element only:

- **Classes from the canvas:** `marquee-portrait` · `marquee-landscape` · `marquee-square`;
  the nearest aspect family `marquee-aspect-9x16` · `16x9` · `3x4` · `4x3` · `1x1` · `marquee-aspect-other`;
  the size tier by the long edge `marquee-size-uhd` (≥ 3840) · `fhd` (≥ 1920) · `hd` (≥ 1280) · `marquee-size-small`;
  the host `marquee-host-<name>`.
- **Classes from the document:** `marquee-ink-light` / `marquee-ink-dark` (`brand.ink`);
  `marquee-layout-now-next` / `marquee-layout-schedule` / `marquee-layout-clock` (`board.renderMode`); `marquee-projected`.
- **The template's own modifiers:** `mod-<name>-<option>` for each `choice`, `mod-<name>` for each
  `toggle` that is on — validated against the manifest; a value that is not an option falls to the
  default with a warning, never an unknown class. The `marquee-` prefix is reserved for the shim.
- **Custom properties:** `--marquee-canvas-width`, `--marquee-canvas-height`, `--marquee-scale`
  (the long edge ÷ 3840); `--marquee-role-<role>` for every role; `--marquee-palette-<slot>`;
  `--marquee-text-<pair>`; `--marquee-ink`, `--marquee-ink-muted`.

A template keys its CSS on these and writes no JavaScript for it. The resolved modifiers are also on
the render context as `modifiers`.

## 6. Fonts

The shim writes one `@font-face` per declared face from `template.json`, loads **every** face
before reporting `ready` (a face no text has used yet would otherwise never be fetched), and lists
the faces that did not resolve in `ready.missingFonts`. A host passes a template's fonts to no
system font registry: they are the page's.

## 7. The host

A Surface rendering a template:

1. **Takes the package as the manifest names it** (specification §7.5), verified like any file,
   and **extracts it once per committed cartridge** into private storage. A package whose
   `template.json` breaks the rules of §2, or that lacks a declared file, is refused by name; the
   next template of the resolution applies (specification §5.15).
2. **Serves the package to the page from an origin of its own** — a custom URL scheme in a native
   web view, a same-origin route in a browser host — that answers only package-relative paths
   (`..` and dot-segments are not found). Loading from `file://` is not conforming: a browser
   engine makes every file its own origin there.
3. Loads `index.html` in a web view sized to the board's canvas at CSS scale 1 and a transparent
   background, and calls `marquee.configure({ host })` once.
4. Waits for `ready`, then **pushes one document per render** with `marquee.update(document)`:
   on the board's issue (its anchor page), on each page turn, on the venue minute for a now / next
   layout, on a cartridge commit, and on a change of orientation or of the device's board variant.
   For the variant `both` the first page is `now-next` and the rest `schedule`
   (specification §5.15). A document's `modifiers` are the device's settings for this template;
   its `vars` the Show's `template_settings`.
5. On `rendered`, **presents the page**: a native host captures it into its text layer, a browser
   host reveals it. The engine's first-frame rule applies to the first `rendered` after issue; a
   later page that never renders keeps the previous page up.
6. Measures the backing where the template's `textRegion` says its text falls (the brand rules a
   Surface already keeps), and sends the reading as `brand.ink`. A board waits for the reading.
7. Reports failures as it reports media failures: `template.load_failed`, `template.render_error`,
   `template.no_first_frame`, `template.variant_unavailable`.

**The project-only clock** (specification §5.15, data 1.2). A Surface with no surface code draws its
date and time with the `clock` layout of the Show's template — `project.template_item_id` in
`project.db`, taken and extracted as above — when that template offers one, else with its default
template's. It pushes one clock document on the venue minute and on a cartridge commit, over the
Show's wallpaper for its orientation (none is black); it measures the wallpaper where the clock
layout's `textRegion` says the text falls and sends the reading as `brand.ink`, and the clock waits
for the reading and for the wallpaper to be on screen, as a board waits for its backing. A clock
that fails to load or render falls to the default template's, then to nothing drawn over the
wallpaper — never a stale minute.

**Host → page:** `marquee.configure({ host })`, `marquee.update(document)`.
**Page → host:** one channel, `{ type: "ready" | "rendered" | "error" | "log", … }` — a
`WKScriptMessageHandler` named `marquee` where one exists, else a `CustomEvent` named `marquee` on
`window`. `ready` carries `{ engine, data, layouts, missingFonts, host }`; `rendered`
`{ page, pageCount, renderMode }`; `error` the message, never thrown into the host. The page runs no
timers and pages nothing: cadence is the host's.

## 8. Validation, in the words a host and an authoring tool share

`template.json` not an object · `format` / `engine` / `data` not a known major · `id` not
`[a-z0-9-]{1,64}` · `layouts: none declared` · `layouts.<name>: "x" is not one of now-next, schedule, clock` ·
`[layouts.<name>.]textRegion.<x|y|w|h>: … is not a fraction 0…1` · `[layouts.<name>.]textRegion: an empty region` ·
`layouts.<name>.source: "…" is not a package-relative .html path` · `<file>: declared as the "<name>"
layout's source, not in the package` · `fonts[i].faces[j].file: … is not fonts/<name>.woff2 or .woff` ·
`<file>: declared, not in the package` · `<file>:<line>: references an external URL — a sign is
offline` · `<file>: hash … is not template.json's …` · `modifiers.<name>: a modifier name is 1–32
lowercase letters, digits and dashes, and never starts with "marquee"` · `modifiers.<name>.default:
"…" is not one of its options` · `modifiers.<name>.kind: "…" is not choice or toggle`.

The reference implementation of these rules, the shim and the default template are in
[`template/`](template/); a host that refuses what they refuse, and renders what they render,
conforms.
