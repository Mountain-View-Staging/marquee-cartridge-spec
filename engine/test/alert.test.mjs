/**
 * Alert directives (§5.3 – §5.6, §5.9) where the conformance scenarios
 * (MCS-25 – MCS-27) do not reach: outside the event, a new cartridge that
 * switches one on, an alert under the standard set, inspection, and a
 * DemoStation's picture-in-picture.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCartridge } from "../dist/node.js";
import { at, brief, fixture, run, variant } from "./helpers.mjs";

const line = (e) => `${e.t.slice(11, 19)} ${e.kind} ${e.code} ${e.entry ?? ""} ${e.set ?? ""} ${e.file ?? ""}`.trim();

test("an alert at timestamp 0 plays outside the event too, where the Surface runs on Day 1", async () => {
  // alert-standing: entry 3's alert is ON from the epoch. Five days after the event, the show clock is Day 1 at 09:00.
  const { trace } = await run(fixture("alert-standing"), { start: "2026-09-20T09:00:00-07:00", seconds: 11 });
  assert.deepEqual(brief(trace), [
    { t: new Date(at("2026-09-15T09:00:00-07:00")).toISOString(), kind: "render", code: "rotation.start", entry: 3, set: "alert", file: 103 },
    { t: new Date(at("2026-09-15T09:00:10-07:00")).toISOString(), kind: "render", code: "rotation.wrap", entry: 3, set: "alert", file: 103 },
  ]);
});

test("a new cartridge that switches an alert on cuts to it at the next tick", async () => {
  // What a publisher does in an emergency: the entry is in the playlist, dormant, and a
  // republish adds its alert. The commit cuts; the alert set is the whole rotation.
  const dormant = variant("alert-landscape", "DELETE FROM directive WHERE type = 'alert'");
  const alerting = await loadCartridge(fixture("alert-landscape"));
  const { trace } = await run(dormant, {
    start: "2026-09-15T08:00:00-07:00", seconds: 23, orientation: "landscape",
    events: { 12: (engine) => engine.commit(alerting) },
  });
  assert.deepEqual(brief(trace).map(line), [
    "15:00:00 render rotation.start 1 standard 201",
    "15:00:10 render rotation.next 2 standard 202",
    "15:00:12 cut cartridge.commit 2",
    "15:00:12 render rotation.start 4 alert 204",
    "15:00:22 render rotation.wrap 4 alert 204",
  ]);
});

test("under the standard set, a future alert is an interrupt: the item ends at its activation, cut as alert.activate", async () => {
  // base, with entry 2's 11:30–12:30 takeover turned into an alert.
  const bytes = variant("base", "UPDATE directive SET type = 'alert' WHERE type = 'takeover'");
  const { trace, items } = await run(bytes, { start: "2026-09-15T11:29:36-07:00", seconds: 35 });
  assert.deepEqual(brief(trace).map(line), [
    "18:29:36 render rotation.start 1 standard 101",
    "18:29:46 render rotation.next 2 standard 102",
    "18:29:56 render rotation.next 3 standard 103",
    "18:30:00 cut alert.activate 3",
    "18:30:00 render rotation.start 2 alert 102",
    "18:30:10 render rotation.wrap 2 alert 102",
  ]);
  assert.deepEqual(items[2].hint, { kind: "time", at: at("2026-09-15T11:30:00-07:00") });
});

test("inspection: the alert set is the rotation and suppresses both other sets; under a takeover the next alert is the interrupt", async () => {
  // alert: entries 1–4 standard, entry 2 a takeover 11:30–12:30, entry 5 an alert 11:45:00–11:45:25.
  const during = await run(fixture("alert"), { start: "2026-09-15T11:45:00-07:00", seconds: 6 });
  const a = during.engine.inspect();
  assert.equal(a.workingSet, "alert");
  assert.deepEqual(a.rotation, [5]);
  assert.deepEqual(a.suppressed, [1, 2, 3, 4]);
  assert.equal(a.interruptAt, null);
  assert.deepEqual(a.cursors, { standard: null, takeover: null, alert: 5 });
  assert.deepEqual(a.entries.map((e) => `${e.entryId} ${e.standard} ${e.takeover} ${e.alert}`),
    ["1 on none none", "2 on on none", "3 on none none", "4 on none none", "5 none none on"]);

  const before = await run(fixture("alert"), { start: "2026-09-15T11:44:40-07:00", seconds: 1 });
  const b = before.engine.inspect();
  assert.equal(b.workingSet, "takeover");
  assert.deepEqual(b.rotation, [2]);
  assert.deepEqual(b.suppressed, [1, 3, 4]);
  assert.equal(b.interruptAt, at("2026-09-15T11:45:00-07:00"));
  assert.equal(b.entries[4].alertOnAt, at("2026-09-15T11:45:00-07:00"));
});

test("during a DemoStation's demo an alert plays in the picture-in-picture like any item, and keeps its cursor through the mode change", async () => {
  // demo-station: the demo is on from 08:00:25. Entry 1 gets an alert ON from the epoch.
  const bytes = variant("demo-station", "INSERT INTO directive VALUES (99, 1, 'alert', 0, 1, NULL, 0, 0)");
  const { trace, items } = await run(bytes, { start: "2026-09-15T08:00:00-07:00", seconds: 36, demoStation: true });
  assert.deepEqual(brief(trace).map(line), [
    "15:00:00 render rotation.start 1 alert 101",
    "15:00:10 render rotation.wrap 1 alert 101",
    "15:00:20 render rotation.wrap 1 alert 101",
    "15:00:25 cut mode.change 1",
    "15:00:25 render rotation.wrap 1 alert 201",
    "15:00:35 render rotation.wrap 1 alert 201",
  ]);
  assert.deepEqual(items.map((i) => i.pip), [false, false, false, true, true]);
});
