/**
 * Performance of the engine against its targets:
 *
 *   a tick with no transition      under 0.1 ms, and no allocation
 *   renderNext, 500-entry playlist under 2 ms
 *   loading a 10,000-row cartridge under 500 ms (TypeScript, browser target)
 *
 *   npm run bench        (node --expose-gc --max-semi-space-size=64 test/bench.mjs)
 *
 * Allocation is measured as young-generation bytes used across a million
 * idle ticks, driven by an optimized loop, and compared with the same loop
 * calling a no-op in the engine's place: whatever the no-op costs is the
 * harness (the host's own call), and the difference is the engine's.
 */
import { performance } from "node:perf_hooks";
import v8 from "node:v8";

import { createEngine, loadCartridge, surfaceClock } from "../dist/node.js";
import { at, variant } from "./helpers.mjs";

if (!globalThis.gc) {
  console.error("run with --expose-gc (npm run bench)");
  process.exit(1);
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const youngBytes = () => v8.getHeapSpaceStatistics().find((s) => s.space_name === "new_space").space_used_size;

/** The host's display loop, reduced to its calls. */
function drive(engine, t0, from, n) {
  let events = 0;
  for (let i = 0; i < n; i++) {
    const out = engine.tick(t0 + from + i, from + i);
    events += out.trace.length + (out.renderItem === null ? 0 : 1);
  }
  return events;
}
const noop = { out: { trace: [], renderItem: null }, tick(wall, mono) { return wall > mono ? this.out : this.out; } };

async function idleTicks(label, start) {
  // Stills that hold for an hour, so a million 1 ms ticks cross no transition.
  const snapshot = await loadCartridge(variant("base", "UPDATE media_item SET display_duration = 3600"));
  const engine = createEngine({ snapshot, slot: "portrait", orientation: "portrait", clock: surfaceClock() });
  const t0 = at(start);
  const first = engine.tick(t0, 0).renderItem;
  if (first) engine.onFirstFrame(first.token); // else: a hold, re-evaluated every 2 s of show time
  let from = 1;
  for (let k = 0; k < 30; k++, from += 20_000) { // warm up both loops until optimized
    drive(engine, t0, from, 20_000);
    drive(noop, t0, from, 20_000);
  }
  const N = 1_000_000;
  globalThis.gc();
  const b0 = youngBytes();
  drive(noop, t0, from, N);
  const baseline = youngBytes() - b0;
  globalThis.gc();
  const e0 = youngBytes();
  const began = performance.now();
  const events = drive(engine, t0, from, N);
  const elapsed = performance.now() - began;
  const used = youngBytes() - e0;
  console.log(label);
  console.log(`  ${N.toLocaleString()} ticks, ${events} transitions`);
  console.log(`  ${((elapsed / N) * 1000).toFixed(3)} µs per tick (target < 100 µs)`);
  console.log(`  ${(used / N).toFixed(3)} bytes per tick; the same loop calling a no-op: ${(baseline / N).toFixed(3)} bytes per call`);
  console.log(`  allocation attributable to the engine: ${Math.max(0, used - baseline)} bytes over ${N.toLocaleString()} ticks`);
}

function playlistSql(entries) {
  const values = [];
  const lines = [];
  // Items share the fixture's files: what matters here is the playlist's size.
  for (let id = 5; id <= entries; id++) values.push(`(${id}, 'Item ${id}', 101, 201, 10, NULL, 0, 0)`);
  lines.push(`INSERT INTO media_item VALUES ${values.join(",")};`);
  const rows = [];
  for (let id = 5; id <= entries; id++) rows.push(`(${id}, 1, ${id}, 'media_item', ${id}, NULL, NULL, NULL, NULL, NULL, 0, 0)`);
  lines.push(`INSERT INTO playlist_entry VALUES ${rows.join(",")};`);
  const directives = [];
  let did = 1000;
  const day = at("2026-09-15T00:00:00-07:00");
  for (let id = 1; id <= entries; id++) {
    // A standard history of four changes, and for one entry in ten a future takeover.
    for (const [hour, on] of [[6, 1], [7, 0], [7.5, 1], [8, 1]]) {
      directives.push(`(${did++}, ${id}, 'standard', ${day + hour * 3_600_000}, ${on}, NULL, 0, 0)`);
    }
    if (id % 10 === 0) {
      directives.push(`(${did++}, ${id}, 'takeover', ${day + 13 * 3_600_000 + id * 1000}, 1, NULL, 0, 0)`);
      directives.push(`(${did++}, ${id}, 'takeover', ${day + 14 * 3_600_000 + id * 1000}, 0, NULL, 0, 0)`);
    }
  }
  lines.push(`INSERT INTO directive VALUES ${directives.join(",")};`);
  return lines.join("\n");
}

async function renderNext() {
  const snapshot = await loadCartridge(variant("base", playlistSql(500)));
  const entries = snapshot.playlists.get(1).entries.length;
  const engine = createEngine({ snapshot, slot: "portrait", orientation: "portrait", clock: surfaceClock() });
  const t0 = at("2026-09-15T09:00:00-07:00");
  const samples = [];
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const began = performance.now();
    const out = engine.tick(t0 + i, i); // the marker is 0: this tick runs renderNext
    const took = performance.now() - began;
    if (!out.renderItem) throw new Error("expected a render item");
    engine.onFirstFrame(out.renderItem.token);
    engine.onMediaCompleted(out.renderItem.token); // force the next tick to choose again
    if (i >= 1000) samples.push(took);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(`renderNext on a ${entries}-entry playlist (${samples.length} passes after warm-up)`);
  console.log(`  median ${(quantile(samples, 0.5) * 1000).toFixed(1)} µs, p99 ${(quantile(samples, 0.99) * 1000).toFixed(1)} µs, mean ${(mean * 1000).toFixed(1)} µs (target < 2000 µs)`);
}

async function load() {
  const extra = [];
  // 1,000 items with a file per orientation, each with a manifest row and a rendition.
  const items = [], files = [], manifest = [], variants = [], entries = [], directives = [];
  let did = 5000;
  for (let n = 0; n < 1000; n++) {
    const item = 1000 + n, p = 10000 + 2 * n, l = p + 1;
    items.push(`(${item}, 'Item ${item}', ${p}, ${l}, 10, NULL, 0, 0)`);
    for (const f of [p, l]) {
      files.push(`(${f}, 'image/png', 'PNG', 1080, 1920, 'portrait', 0.5625, NULL, 0, 0)`);
      manifest.push(`(${f}, 'f${f}.png', 'sha256:${"0".repeat(64)}', 1024, 'image/png')`);
      variants.push(`(${f}, ${f}, 'original', 'f${f}.png', 'image/png', 'PNG', 1080, 1920, 1024, 'sha256:${"0".repeat(64)}', 0, 0)`);
    }
    entries.push(`(${item}, 1, ${item}, 'media_item', ${item}, NULL, NULL, NULL, NULL, NULL, 0, 0)`);
    for (let k = 0; k < 4; k++) directives.push(`(${did++}, ${item}, 'standard', ${1789000000000 + k}, ${k % 2}, NULL, 0, 0)`);
  }
  extra.push(`INSERT INTO media_file VALUES ${files.join(",")};`);
  extra.push(`INSERT INTO media_item VALUES ${items.join(",")};`);
  extra.push(`INSERT INTO media_manifest VALUES ${manifest.join(",")};`);
  extra.push(`INSERT INTO media_file_variant VALUES ${variants.join(",")};`);
  extra.push(`INSERT INTO playlist_entry VALUES ${entries.join(",")};`);
  extra.push(`INSERT INTO directive VALUES ${directives.join(",")};`);
  const bytes = variant("base", extra.join("\n"));
  const rows = 1000 + 2000 * 3 + 1000 + 4000;
  const times = [];
  for (let i = 0; i < 12; i++) {
    const began = performance.now();
    await loadCartridge(bytes);
    times.push(performance.now() - began);
  }
  times.sort((a, b) => a - b);
  console.log(`loading a cartridge of ~${rows.toLocaleString()} rows (${(bytes.length / 1024).toFixed(0)} KB) with node:sqlite`);
  console.log(`  median ${quantile(times, 0.5).toFixed(1)} ms, best ${times[0].toFixed(1)} ms (target < 500 ms in a browser; not measured here)`);
}

console.log(`node ${process.version}, ${process.arch}\n`);
await idleTicks("tick with no transition, inside the event (real venue time)", "2026-09-15T08:00:00-07:00");
console.log();
await idleTicks("tick with no transition, outside the event (synthetic Day 1)", "2026-09-08T08:00:00-07:00");
console.log();
await idleTicks("tick during a hold (nothing viable yet; re-evaluated every 2 s)", "2026-09-15T07:00:00-07:00");
console.log();
await renderNext();
console.log();
await load();
