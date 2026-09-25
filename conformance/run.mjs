#!/usr/bin/env node
/**
 * Marquee Conformance Suite — runner.
 *
 *   node conformance/run.mjs                      validate the suite itself
 *   node conformance/run.mjs --engine <module>    run every scenario against an engine
 *   node conformance/run.mjs --engine <module> MCS-02 MCS-10
 *
 * No dependencies. Node ≥ 22.13 (built-in `node:sqlite`).
 *
 * The runner is the simulated HOST described in README.md: it drives the
 * engine's clock, answers each render item the way `scenario.host` says a real
 * host would, and compares the engine's trace with `expected.json`.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODES = {
  render: ["rotation.start", "rotation.next", "rotation.wrap"],
  cut: ["takeover.activate", "schedule.change", "orientation.change", "cartridge.commit"],
  jump: ["jump.backward", "jump.forward"],
  hold: ["set.empty", "set.all_failed"],
  blank: ["schedule.blank"],
  skip: ["media.load_failed", "media.no_first_frame", "media.watchdog", "media.not_playable"],
  warning: ["orientation.missing"],
};
const MAX_RETICKS = 64;

const args = process.argv.slice(2);
const engineAt = args.includes("--engine") ? args[args.indexOf("--engine") + 1] : null;
const only = args.filter((a, i) => a.startsWith("MCS-") && args[i - 1] !== "--engine");

const scenarioDirs = readdirSync(join(HERE, "scenarios")).filter((d) => !only.length || only.includes(d)).sort();
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const ms = (iso) => Date.parse(iso);

// ── validation: is the suite itself well-formed? ────────────────────────────────

function validate(dir) {
  const problems = [];
  const s = read(join(HERE, "scenarios", dir, "scenario.json"));
  const e = read(join(HERE, "scenarios", dir, "expected.json"));
  if (s.id !== dir || e.id !== dir) problems.push("id does not match its folder");
  const cart = join(HERE, "cartridges", `${s.cartridge}.db`);
  if (!existsSync(cart)) return [...problems, `missing cartridge ${s.cartridge}.db (run build.py)`];
  const db = new DatabaseSync(cart, { readOnly: true });
  const meta = db.prepare("SELECT * FROM cartridge_meta").all();
  if (meta.length !== 1 || meta[0].format_version !== "25.0.1" || meta[0].cartridge_kind !== "surface")
    problems.push("cartridge_meta is not a single v25.0.1 surface row");
  db.exec("PRAGMA foreign_keys = ON");
  if (db.prepare("PRAGMA foreign_key_check").all().length) problems.push("foreign_key_check fails");
  const entries = new Set(db.prepare("SELECT id FROM playlist_entry").all().map((r) => r.id));
  db.close();
  let last = -Infinity;
  for (const [i, ev] of e.trace.entries()) {
    if (!CODES[ev.kind]?.includes(ev.code)) problems.push(`event ${i}: unknown ${ev.kind}/${ev.code}`);
    if (ev.entry !== undefined && !entries.has(ev.entry)) problems.push(`event ${i}: entry ${ev.entry} not in cartridge`);
    const t = ms(ev.t);
    if (Number.isNaN(t)) problems.push(`event ${i}: bad time ${ev.t}`);
    if (t < last && ev.kind !== "jump" && e.trace[i - 1]?.kind !== "jump") problems.push(`event ${i}: out of order`);
    last = t;
  }
  return problems;
}

// ── running: the simulated host ─────────────────────────────────────────────────

function normalize(ev) {
  const out = { t: ev.showTime, kind: ev.kind, code: ev.code };
  if (ev.entryId != null) out.entry = ev.entryId;
  if (ev.set != null) out.set = ev.set;
  if (ev.mediaFileId != null) out.file = ev.mediaFileId;
  if (ev.sessionSetId != null) out.board = ev.sessionSetId;
  return out;
}

async function run(engineMod, dir) {
  const s = read(join(HERE, "scenarios", dir, "scenario.json"));
  const expected = read(join(HERE, "scenarios", dir, "expected.json")).trace.map((ev) => ({ ...ev, t: ms(ev.t) }));
  const bytes = readFileSync(join(HERE, "cartridges", `${s.cartridge}.db`));
  const snapshot = await engineMod.loadCartridge(new Uint8Array(bytes));
  const clock = s.clock.source === "preview" ? engineMod.previewClock() : engineMod.surfaceClock();
  const pages = s.host.boardPages ?? {};
  const engine = engineMod.createEngine({
    snapshot, slot: s.engine.slot, orientation: s.engine.orientation, clock,
    boardResolver: (set) => ({ model: null, pageCount: pages[String(set.id)] ?? 1, anchorPage: 0 }),
  });

  const trace = [];
  const take = (evs) => { for (const ev of evs ?? []) trace.push(normalize(ev)); };
  const due = [];               // scheduled host reports: { mono, token }
  let wallOffset = 0;

  for (let sec = 0; sec < s.clock.seconds; sec++) {
    const mono = sec * s.clock.tickMs;
    for (const ev of s.events.filter((x) => x.atSecond === sec))
      if (ev.type === "wallJump") wallOffset += ev.deltaMs;
      else if (ev.type === "setOrientation") take(engine.setOrientation(ev.orientation));
    for (const c of (s.clock.commands ?? []).filter((x) => x.atSecond === sec)) {
      if (c.set) clock.set(ms(c.set));
      if (c.action === "play") clock.play();
      if (c.action === "pause") clock.pause();
    }
    const wall = ms(s.clock.start) + mono + wallOffset;
    for (const d of due.filter((x) => x.mono <= mono)) { take(engine.onMediaCompleted(d.token)); due.splice(due.indexOf(d), 1); }

    for (let i = 0; i < MAX_RETICKS; i++) {
      const out = engine.tick(wall, mono);
      take(out.trace);
      const item = out.renderItem;
      if (!item || item.kind === "blank") break;
      const entry = item.entryId;
      if (s.host.failEntries.includes(entry)) { take(engine.onLoadFailed(item.token, "fixture: load fails")); continue; }
      if (s.host.noFirstFrameEntries.includes(entry)) break;
      take(engine.onFirstFrame(item.token));
      if (item.kind === "media" && /^video\//.test(item.media.contentType) && !s.host.stuckEntries.includes(entry))
        due.push({ mono: mono + item.media.duration * 1000, token: item.token });
      break;
    }
  }

  const diffs = [];
  const n = Math.max(trace.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = JSON.stringify(trace[i] ?? null), b = JSON.stringify(expected[i] ?? null);
    if (a !== b) diffs.push(`#${i}\n    expected ${b}\n    actual   ${a}`);
  }
  return diffs;
}

// ── main ────────────────────────────────────────────────────────────────────────

let failed = 0;
if (!engineAt) {
  for (const dir of scenarioDirs) {
    const problems = validate(dir);
    console.log(`${problems.length ? "✗" : "✓"} ${dir}`);
    for (const p of problems) console.log(`    ${p}`);
    failed += problems.length ? 1 : 0;
  }
  console.log(`\n${scenarioDirs.length - failed}/${scenarioDirs.length} scenarios well-formed`);
} else {
  const engineMod = await import(pathToFileURL(resolve(engineAt)).href);
  for (const dir of scenarioDirs) {
    const s = read(join(HERE, "scenarios", dir, "scenario.json"));
    if (s.clock.deviceTimeZone) process.env.TZ = s.clock.deviceTimeZone;
    const diffs = await run(engineMod, dir);
    console.log(`${diffs.length ? "✗" : "✓"} ${dir}  ${s.title}`);
    for (const d of diffs.slice(0, 5)) console.log(`    ${d}`);
    failed += diffs.length ? 1 : 0;
  }
  console.log(`\n${scenarioDirs.length - failed}/${scenarioDirs.length} scenarios pass`);
}
process.exit(failed ? 1 : 0);
