/**
 * Test helpers: fixture cartridges from the conformance suite, and variants
 * of them made by running SQL against a private copy.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { createEngine, loadCartridge, surfaceClock } from "../dist/node.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CARTRIDGES = join(HERE, "..", "..", "conformance", "cartridges");

/** The bytes of a conformance fixture cartridge. */
export function fixture(name) {
  return new Uint8Array(readFileSync(join(CARTRIDGES, `${name}.db`)));
}

/** The bytes of a fixture after running `sql` against a copy of it. */
export function variant(name, sql) {
  const dir = mkdtempSync(join(tmpdir(), "marquee-engine-test-"));
  try {
    const path = join(dir, "cartridge.db");
    copyFileSync(join(CARTRIDGES, `${name}.db`), path);
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();
    return new Uint8Array(readFileSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const at = (iso) => Date.parse(iso);

/**
 * A minimal simulated host, as conformance/README.md describes it: ticks once
 * a second, answers every render item with a first frame at once (unless the
 * entry is listed in `fail`), and returns the normalised trace.
 */
export async function run(bytes, { start, seconds, orientation = "portrait", slot = "portrait", fail = [], events = {}, clock, boardResolver } = {}) {
  const snapshot = bytes.kind ? bytes : await loadCartridge(bytes);
  const engine = createEngine({ snapshot, slot, orientation, clock: clock ?? surfaceClock(), boardResolver });
  const trace = [];
  const items = [];
  const take = (evs) => { for (const ev of evs) trace.push(ev); };
  for (let s = 0; s < seconds; s++) {
    events[s]?.(engine);
    const mono = s * 1000;
    const wall = at(start) + mono;
    for (let i = 0; i < 64; i++) {
      const out = engine.tick(wall, mono);
      take(out.trace);
      const item = out.renderItem;
      if (!item) break;
      items.push(item);
      if (item.kind === "blank") break;
      if (fail.includes(item.entryId)) { take(engine.onLoadFailed(item.token, "test")); continue; }
      take(engine.onFirstFrame(item.token));
      break;
    }
  }
  return { engine, trace, items };
}

/** A trace reduced to what conformance compares, times as venue ISO strings. */
export function brief(trace) {
  return trace.map((e) => {
    const out = { t: new Date(e.showTime).toISOString(), kind: e.kind, code: e.code };
    if (e.entryId != null) out.entry = e.entryId;
    if (e.set != null) out.set = e.set;
    if (e.mediaFileId != null) out.file = e.mediaFileId;
    if (e.sessionSetId != null) out.board = e.sessionSetId;
    return out;
  });
}
