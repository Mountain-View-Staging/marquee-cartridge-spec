# Vendored: nunjucks

| | |
|---|---|
| Package | `nunjucks` (https://mozilla.github.io/nunjucks/) |
| Version | **3.2.4** — `browser/nunjucks.min.js` from the npm package, unmodified |
| Licence | BSD-2-Clause, `LICENSE.nunjucks` beside this file |
| SHA-256 | `93769288b3eb63fff02d40406ba4d2d49f48b70f31576cdc330ee7f626856f3f` |
| Decision | 2026-10-01: vendored at a pinned release, **not forked** |

Nothing in it is edited. To take a new release: replace the file, update the version and
digest here, run `npm test`. The shim (`marquee-template.js`) never uses its loaders
(`WebLoader`, `FileSystemLoader`): every template source is inline in the page, so
nothing is fetched at render time.
