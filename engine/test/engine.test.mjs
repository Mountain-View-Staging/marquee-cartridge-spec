/**
 * Engine behaviour the conformance scenarios do not reach: orientation
 * changes, the DemoStation mode, commits, backings, skipped non-media, a
 * missing orientation, preview pauses, day-scoping ties, and venue time on
 * daylight-saving dates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Calendar,
  DirectiveSeries,
  boardPageAt,
  createEngine,
  loadCartridge,
  minimalBoardResolver,
  playbackWindow,
  previewClock,
  surfaceClock,
} from "../dist/node.js";
import { at, brief, fixture, run, variant } from "./helpers.mjs";

const t = (iso) => new Date(Date.parse(iso)).toISOString();

test("a tick that changes nothing returns the same output object and the shared empty trace", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T08:00:00-07:00");
  const first = engine.tick(start, 0);
  engine.onFirstFrame(first.renderItem.token);
  const a = engine.tick(start + 1000, 1000);
  const b = engine.tick(start + 2000, 2000);
  assert.equal(a, b);
  assert.equal(a.renderItem, null);
  assert.equal(a.trace.length, 0);
  assert.ok(Object.isFrozen(a.trace));
});

test("a rotation cuts, keeps the cursor on the one playlist, and plays the other slot's file", async () => {
  const { trace } = await run(fixture("base"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 16,
    events: { 5: (engine) => assert.deepEqual(engine.setOrientation("landscape"), []) },
  });
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
    { t: t("2026-09-15T08:00:05-07:00"), kind: "cut", code: "orientation.change", entry: 1 },
    { t: t("2026-09-15T08:00:05-07:00"), kind: "render", code: "rotation.next", entry: 2, set: "standard", file: 202 },
    { t: t("2026-09-15T08:00:15-07:00"), kind: "render", code: "rotation.next", entry: 3, set: "standard", file: 203 },
  ]);
});

test("a rotation and a schedule boundary in the same tick are two causes: one cut each, and the new playlist starts over", async () => {
  // schedule-change: playlist A until 08:00:25, then playlist B (entries 11, 12).
  const { trace, engine } = await run(fixture("schedule-change"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 26,
    events: { 25: (e) => e.setOrientation("landscape") },
  });
  assert.equal(engine.orientation, "landscape");
  assert.deepEqual(brief(trace).slice(2), [
    { t: t("2026-09-15T08:00:20-07:00"), kind: "render", code: "rotation.next", entry: 3, set: "standard", file: 103 },
    { t: t("2026-09-15T08:00:25-07:00"), kind: "cut", code: "orientation.change", entry: 3 },
    { t: t("2026-09-15T08:00:25-07:00"), kind: "cut", code: "schedule.change", entry: 3 },
    { t: t("2026-09-15T08:00:25-07:00"), kind: "render", code: "rotation.start", entry: 11, set: "standard", file: 211 },
  ]);
});

test("a rotation never changes the schedule: the same entry governs, and the rotation keeps its place", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T08:00:00-07:00");
  engine.onFirstFrame(engine.tick(start, 0).renderItem.token);
  const before = engine.inspect();
  engine.setOrientation("landscape");
  const out = engine.tick(start + 1000, 1000);
  const after = engine.inspect();
  assert.equal(after.scheduleEntry, before.scheduleEntry);
  assert.deepEqual(after.playlist, before.playlist);
  assert.equal(after.renderedOrientation, "landscape");
  assert.deepEqual(out.trace.map((e) => e.code), ["orientation.change"]);
  assert.equal(out.renderItem.entryId, 2, "the entry after the cursor, not the top");
  assert.equal(out.renderItem.media.mediaFileId, 202);
  assert.equal(out.renderItem.pip, false);
});

// ── The DemoStation mode (§5.11) ───────────────────────────────────────────────
// demo-station.db: playlist A = items 1, 2, 4 (both files) and 3 (portrait only);
// the demo is on from 08:00:25 (background item 9, overlay item 8) and off from 08:00:55.

const DEMO_ON = { scheduleEntryId: 2, background: { mediaItemId: 9, mediaFileId: 109, contentType: "image/png" }, overlay: { mediaItemId: 8, mediaFileId: 108, contentType: "image/png" } };

test("a DemoStation's demo: the output carries its branding in the device's orientation, and its items play in the picture-in-picture", async () => {
  let during;
  const { trace, items, demos, engine } = await run(fixture("demo-station"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 60,
    demoStation: true,
    events: { 30: (e) => { during = e.inspect(); } },
  });
  assert.deepEqual(demos[24], null);
  assert.deepEqual(demos[25], DEMO_ON);
  assert.equal(demos[54], demos[25], "the same object while nothing changes");
  assert.equal(demos[55], null);
  assert.deepEqual(items.map((i) => `${i.entryId} ${i.media.mediaFileId} ${i.pip ? "pip" : "full"}`), [
    "1 101 full", "2 102 full", "3 103 full", "4 204 pip", "1 201 pip", "2 202 pip", "3 103 full",
  ]);
  assert.deepEqual(brief(trace).filter((e) => e.kind === "cut").map((e) => `${e.t} ${e.code} ${e.entry}`), [
    `${t("2026-09-15T08:00:25-07:00")} mode.change 3`,
    `${t("2026-09-15T08:00:55-07:00")} mode.change 2`,
  ]);
  assert.equal(during.orientation, "portrait");
  assert.equal(during.renderedOrientation, "landscape");
  assert.deepEqual(during.demo, DEMO_ON);
  assert.deepEqual(during.entries.find((e) => e.entryId === 3).excluded, "no landscape file: the slot is empty");
  assert.equal(engine.renderedOrientation, "portrait");
  assert.equal(engine.demo, null);
});

test("a landscape DemoStation: the picture-in-picture renders portrait files, so a portrait-only item plays there", async () => {
  const { trace, demos } = await run(fixture("demo-station"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 60,
    orientation: "landscape",
    demoStation: true,
  });
  assert.deepEqual(demos[25], { scheduleEntryId: 2, background: { mediaItemId: 9, mediaFileId: 209, contentType: "image/png" }, overlay: { mediaItemId: 8, mediaFileId: 208, contentType: "image/png" } });
  assert.deepEqual(brief(trace).map((e) => `${e.t.slice(11, 19)} ${e.kind} ${e.code} ${e.entry ?? ""} ${e.file ?? ""}`.trim()), [
    "15:00:00 render rotation.start 1 201",
    "15:00:10 render rotation.next 2 202",
    "15:00:20 render rotation.next 4 204",
    "15:00:25 cut mode.change 4",
    "15:00:25 render rotation.wrap 1 101",
    "15:00:35 render rotation.next 2 102",
    "15:00:45 render rotation.next 3 103",
    "15:00:55 cut mode.change 3",
    "15:00:55 render rotation.next 4 204",
  ]);
});

test("a host without the DemoStation mode ignores the demo_station slot", async () => {
  const { trace, items, demos } = await run(fixture("demo-station"), { start: "2026-09-15T08:00:00-07:00", seconds: 60 });
  assert.deepEqual(brief(trace).map((e) => `${e.code} ${e.entry} ${e.file}`), [
    "rotation.start 1 101", "rotation.next 2 102", "rotation.next 3 103", "rotation.next 4 104", "rotation.wrap 1 101", "rotation.next 2 102",
  ]);
  assert.ok(items.every((i) => i.pip === false));
  assert.ok(demos.every((d) => d === null));
});

test("a demo boundary that keeps the demo on changes only the branding: nothing is cut", async () => {
  const bytes = variant("demo-station", `INSERT INTO surface_schedule_entry VALUES (4, 1, 'demo_station', ${at("2026-09-15T08:00:40-07:00")}, NULL, 8, NULL, 0, 0)`);
  const { trace, demos } = await run(bytes, { start: "2026-09-15T08:00:00-07:00", seconds: 60, demoStation: true });
  assert.deepEqual(demos[40], { scheduleEntryId: 4, background: { mediaItemId: 8, mediaFileId: 108, contentType: "image/png" }, overlay: null });
  const reference = await run(fixture("demo-station"), { start: "2026-09-15T08:00:00-07:00", seconds: 60, demoStation: true });
  assert.deepEqual(brief(trace), brief(reference.trace));
});

test("the demo is on whenever its entry names a background, even one with no file in the device's orientation", async () => {
  const bytes = variant("demo-station", "UPDATE media_item SET portrait_file_id = NULL WHERE id = 9");
  const { items, demos } = await run(bytes, { start: "2026-09-15T08:00:25-07:00", seconds: 1, demoStation: true });
  assert.deepEqual(demos[0], { scheduleEntryId: 2, background: null, overlay: DEMO_ON.overlay });
  assert.equal(items[0].pip, true);
});

test("a jump into a demo records the jump only, and the rotation continues in the picture-in-picture", async () => {
  const clock = previewClock();
  clock.set(at("2026-09-15T08:00:00-07:00"));
  const { trace, items } = await run(fixture("demo-station"), {
    start: "2026-09-01T12:00:00-07:00",
    seconds: 13,
    clock,
    demoStation: true,
    events: { 12: () => clock.set(at("2026-09-15T08:00:30-07:00")) },
  });
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
    { t: t("2026-09-15T08:00:10-07:00"), kind: "render", code: "rotation.next", entry: 2, set: "standard", file: 102 },
    { t: t("2026-09-15T08:00:30-07:00"), kind: "jump", code: "jump.forward" },
    { t: t("2026-09-15T08:00:30-07:00"), kind: "render", code: "rotation.next", entry: 4, set: "standard", file: 204 },
  ]);
  assert.equal(items.at(-1).pip, true);
});

test("a rotation during a demo turns the picture-in-picture with the device, and the branding too", async () => {
  const { trace, items, demos } = await run(fixture("demo-station"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 60,
    demoStation: true,
    events: { 30: (e) => e.setOrientation("landscape") },
  });
  assert.deepEqual(demos[30], { scheduleEntryId: 2, background: { mediaItemId: 9, mediaFileId: 209, contentType: "image/png" }, overlay: { mediaItemId: 8, mediaFileId: 208, contentType: "image/png" } });
  assert.deepEqual(brief(trace).slice(3).map((e) => `${e.t.slice(11, 19)} ${e.kind} ${e.code} ${e.entry ?? ""} ${e.file ?? ""}`.trim()), [
    "15:00:25 cut mode.change 3",
    "15:00:25 render rotation.next 4 204",
    "15:00:30 cut orientation.change 4",
    "15:00:30 render rotation.wrap 1 101",
    "15:00:40 render rotation.next 2 102",
    "15:00:50 render rotation.next 3 103",
    "15:00:55 cut mode.change 3",
    "15:00:55 render rotation.next 4 204",
  ]);
  assert.deepEqual(items.slice(3).map((i) => i.pip), [true, true, true, true, false]);
});

test("a takeover during a demo cuts in the picture-in-picture", async () => {
  // base: entry 2's takeover is ON 11:30–12:30. The demo is on from 11:29:42 (item 1 as its background).
  const bytes = variant("base", `INSERT INTO surface_schedule_entry VALUES (2, 1, 'demo_station', ${at("2026-09-15T11:29:42-07:00")}, NULL, 1, NULL, 0, 0)`);
  const { trace, items } = await run(bytes, { start: "2026-09-15T11:29:36-07:00", seconds: 35, demoStation: true });
  assert.deepEqual(brief(trace).map((e) => `${e.t.slice(11, 19)} ${e.kind} ${e.code} ${e.entry ?? ""} ${e.set ?? ""} ${e.file ?? ""}`.trim()), [
    "18:29:36 render rotation.start 1 standard 101",
    "18:29:42 cut mode.change 1",
    "18:29:42 render rotation.next 2 standard 202",
    "18:29:52 render rotation.next 3 standard 203",
    "18:30:00 cut takeover.activate 3",
    "18:30:00 render rotation.start 2 takeover 202",
    "18:30:10 render rotation.wrap 2 takeover 202",
  ]);
  assert.deepEqual(items.map((i) => i.pip), [false, true, true, true, true]);
});

test("a boundary that starts a demo and changes the playlist records mode.change only; the new playlist starts over", async () => {
  const bytes = variant("schedule-change", `INSERT INTO surface_schedule_entry VALUES (3, 1, 'demo_station', ${at("2026-09-15T08:00:25-07:00")}, NULL, 1, NULL, 0, 0)`);
  const { trace, items } = await run(bytes, { start: "2026-09-15T08:00:00-07:00", seconds: 26, demoStation: true });
  assert.deepEqual(brief(trace).slice(3), [
    { t: t("2026-09-15T08:00:25-07:00"), kind: "cut", code: "mode.change", entry: 3 },
    { t: t("2026-09-15T08:00:25-07:00"), kind: "render", code: "rotation.start", entry: 11, set: "standard", file: 211 },
  ]);
  assert.equal(items.at(-1).pip, true);
});

test("a new cartridge during a demo: everything restarts, and the demo is resolved again without a cut of its own", async () => {
  const again = await loadCartridge(fixture("demo-station"));
  const plain = await loadCartridge(fixture("base"));
  const republish = await run(fixture("demo-station"), { start: "2026-09-15T08:00:00-07:00", seconds: 31, demoStation: true, events: { 30: (e) => e.commit(again) } });
  assert.deepEqual(brief(republish.trace).slice(-2), [
    { t: t("2026-09-15T08:00:30-07:00"), kind: "cut", code: "cartridge.commit", entry: 4 },
    { t: t("2026-09-15T08:00:30-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 201 },
  ]);
  assert.equal(republish.items.at(-1).pip, true);
  assert.deepEqual(republish.demos[30], DEMO_ON);
  const ended = await run(fixture("demo-station"), { start: "2026-09-15T08:00:00-07:00", seconds: 31, demoStation: true, events: { 30: (e) => e.commit(plain) } });
  assert.deepEqual(brief(ended.trace).slice(-2).map((e) => `${e.code} ${e.file ?? e.entry}`), ["cartridge.commit 4", "rotation.start 101"]);
  assert.equal(ended.items.at(-1).pip, false);
  assert.equal(ended.demos[30], null);
});

test("a DemoStation with no orientation: the picture-in-picture skips the gate too, and the branding resolves in landscape", async () => {
  const { trace, items, demos, engine } = await run(fixture("demo-station"), { start: "2026-09-15T08:00:25-07:00", seconds: 1, orientation: null, demoStation: true });
  assert.deepEqual(brief(trace).map((e) => e.code), ["orientation.missing", "rotation.start"]);
  assert.equal(items[0].pip, true);
  assert.equal(items[0].media.mediaFileId, 201);
  assert.equal(engine.renderedOrientation, null);
  assert.deepEqual(demos[0].background, { mediaItemId: 9, mediaFileId: 209, contentType: "image/png" });
});

test("a committed cartridge cuts, resets every cursor, and starts over", async () => {
  const next = await loadCartridge(fixture("schedule-change"));
  const { trace } = await run(fixture("base"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 13,
    events: { 12: (engine) => engine.commit(next) },
  });
  assert.deepEqual(brief(trace).slice(1), [
    { t: t("2026-09-15T08:00:10-07:00"), kind: "render", code: "rotation.next", entry: 2, set: "standard", file: 102 },
    { t: t("2026-09-15T08:00:12-07:00"), kind: "cut", code: "cartridge.commit", entry: 2 },
    { t: t("2026-09-15T08:00:12-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
  ]);
});

test("an entry whose file is not image or video media is skipped loudly and the rotation moves on", async () => {
  const bytes = variant("base", "UPDATE media_file SET content_type = 'font/ttf' WHERE id = 103");
  const { trace } = await run(bytes, { start: "2026-09-15T08:00:00-07:00", seconds: 21 });
  assert.deepEqual(brief(trace).slice(2), [
    { t: t("2026-09-15T08:00:20-07:00"), kind: "skip", code: "media.not_playable", entry: 3 },
    { t: t("2026-09-15T08:00:20-07:00"), kind: "render", code: "rotation.next", entry: 4, set: "standard", file: 104 },
  ]);
});

test("a working set of nothing but non-media holds instead of spinning", async () => {
  const bytes = variant("base", "UPDATE media_file SET content_type = 'application/json'");
  const { trace } = await run(bytes, { start: "2026-09-15T08:00:00-07:00", seconds: 3 });
  assert.deepEqual(brief(trace).map((e) => `${e.kind} ${e.code} ${e.entry ?? ""}`.trim()), [
    "skip media.not_playable 1",
    "skip media.not_playable 2",
    "skip media.not_playable 3",
    "skip media.not_playable 4",
    "hold set.all_failed",
    "skip media.not_playable 1",
    "skip media.not_playable 2",
    "skip media.not_playable 3",
    "skip media.not_playable 4",
  ]);
});

test("a brand member that is an image plays like any other item", async () => {
  const bytes = variant("base", "UPDATE media_item SET brand_member = 'acme/acme-2026/3' WHERE id = 1");
  const { trace } = await run(bytes, { start: "2026-09-15T08:00:00-07:00", seconds: 1 });
  assert.deepEqual(brief(trace), [{ t: t("2026-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 }]);
});

test("backings: a session set's own, else the project's; resolved by orientation with no fallback", async () => {
  const cartridge = (sql = "") => variant("board", `
    INSERT INTO media_item (id, name, portrait_file_id, landscape_file_id, display_duration, brand_member, created, updated)
    VALUES (21, 'Project backing', 101, 201, NULL, NULL, 0, 0),
           (22, 'Landscape-only backing', NULL, 203, NULL, NULL, 0, 0),
           (23, 'Room backing', 103, 203, NULL, NULL, 0, 0);
    UPDATE project SET backing_item_id = 21; ${sql}`);
  // Entry 1 (a still) renders at 08:00:00, the board (entry 2) at 08:00:10.
  const items = async (bytes) => (await run(bytes, { start: "2026-09-15T08:00:00-07:00", seconds: 11 })).items;

  const [media, board] = await items(cartridge());
  assert.equal(board.kind, "sessionBoard");
  assert.deepEqual(media.backing, { mediaItemId: 21, mediaFileId: 101, contentType: "image/png" });
  assert.deepEqual(board.backing, { mediaItemId: 21, mediaFileId: 101, contentType: "image/png" });
  const own = (await items(cartridge("UPDATE session_set SET backing_item_id = 23")))[1];
  assert.deepEqual(own.backing, { mediaItemId: 23, mediaFileId: 103, contentType: "image/png" });
  const landscapeOnly = (await items(cartridge("UPDATE session_set SET backing_item_id = 22")))[1];
  assert.equal(landscapeOnly.backing, null, "an empty slot means no backing, not the project's");
});

test("a missing orientation skips the orientation gate, says so once, and plays each landscape file, else the portrait one", async () => {
  // orientation.db: item 1 is landscape-only (201), item 2 holds file 202 in both slots, item 3 is 103 / 203.
  const { trace } = await run(fixture("orientation"), { start: "2026-09-15T08:00:00-07:00", seconds: 21, orientation: null });
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T08:00:00-07:00"), kind: "warning", code: "orientation.missing" },
    { t: t("2026-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 201 },
    { t: t("2026-09-15T08:00:10-07:00"), kind: "render", code: "rotation.next", entry: 2, set: "standard", file: 202 },
    { t: t("2026-09-15T08:00:20-07:00"), kind: "render", code: "rotation.next", entry: 3, set: "standard", file: 203 },
  ]);
  // A portrait-only item plays its portrait file.
  const portraitOnly = await run(variant("orientation", "UPDATE media_item SET landscape_file_id = NULL WHERE id = 3"), { start: "2026-09-15T08:00:00-07:00", seconds: 21, orientation: null });
  assert.equal(portraitOnly.items.find((i) => i.entryId === 3).media.mediaFileId, 103);
});

test("nothing scheduled yet on the lane holds, then plays from the first changeover", async () => {
  const bytes = variant("base", `UPDATE surface_schedule_entry SET timestamp = ${at("2026-09-15T08:00:05-07:00")}`);
  const { trace } = await run(bytes, { start: "2026-09-15T08:00:00-07:00", seconds: 7 });
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T08:00:00-07:00"), kind: "hold", code: "set.empty" },
    { t: t("2026-09-15T08:00:05-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
  ]);
});

test("a paused preview clock holds for 10 s with no jump and no item ending", async () => {
  const clock = previewClock();
  clock.set(at("2026-09-15T08:00:00-07:00"));
  // Paused at 08:00:03 from second 3 to second 13: entry 1's ten seconds of
  // show time end at second 20, not second 10.
  const { trace } = await run(fixture("base"), {
    start: "2026-09-01T12:00:00-07:00",
    seconds: 21,
    clock,
    events: { 3: () => clock.pause(), 13: () => clock.play() },
  });
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
    { t: t("2026-09-15T08:00:10-07:00"), kind: "render", code: "rotation.next", entry: 2, set: "standard", file: 102 },
  ]);
});

test("setting the preview clock is a jump, and the rotation keeps its cursor", async () => {
  const clock = previewClock();
  clock.set(at("2026-09-15T08:00:00-07:00"));
  const { trace } = await run(fixture("base"), {
    start: "2026-09-01T12:00:00-07:00",
    seconds: 3,
    clock,
    events: { 2: () => clock.set(at("2026-09-15T12:45:00-07:00")) },
  });
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
    { t: t("2026-09-15T12:45:00-07:00"), kind: "jump", code: "jump.forward" },
    { t: t("2026-09-15T12:45:00-07:00"), kind: "render", code: "rotation.next", entry: 2, set: "standard", file: 102 },
  ]);
});

/** The base fixture with its day, schedule and directives moved to 1969-09-15: venue time is negative Unix ms. */
const before1970 = () => {
  const shift = at("2026-09-15T00:00:00-07:00") - at("1969-09-15T00:00:00-07:00");
  return variant("base", `
    UPDATE project_days SET day = '1969-09-15', start_time = start_time - ${shift}, end_time = end_time - ${shift};
    UPDATE surface_schedule_entry SET timestamp = timestamp - ${shift};
    UPDATE directive SET timestamp = timestamp - ${shift}`);
};

test("marker 0 forces the next loop whatever the show time: before 1970 a preview renders, skips and jumps", async () => {
  const clock = previewClock();
  clock.set(at("1969-09-15T08:00:00-07:00"));
  // Entry 2 fails to load (a skip forces the marker); at second 15 the clock is set back (a jump forces it).
  const { trace, engine } = await run(before1970(), {
    start: "2026-09-01T12:00:00-07:00",
    seconds: 26,
    clock,
    fail: [2],
    events: { 15: () => clock.set(at("1969-09-15T08:00:05-07:00")) },
  });
  assert.ok(engine.showNow < 0, "the show time is before 1970");
  assert.deepEqual(brief(trace), [
    { t: t("1969-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
    { t: t("1969-09-15T08:00:10-07:00"), kind: "skip", code: "media.load_failed", entry: 2 },
    { t: t("1969-09-15T08:00:10-07:00"), kind: "render", code: "rotation.next", entry: 3, set: "standard", file: 103 },
    { t: t("1969-09-15T08:00:05-07:00"), kind: "jump", code: "jump.backward" },
    { t: t("1969-09-15T08:00:05-07:00"), kind: "render", code: "rotation.next", entry: 4, set: "standard", file: 104 },
    { t: t("1969-09-15T08:00:15-07:00"), kind: "render", code: "rotation.wrap", entry: 1, set: "standard", file: 101 },
  ]);
});

test("a Day 1 before 1970 plays on the Surface clock, and a preview set before 1970 holds where nothing is scheduled", async () => {
  // Outside the event, the Surface clock projects onto Day 1 at the venue's time of day: here, into 1969.
  const projected = await run(before1970(), { start: "2026-09-01T08:00:00-07:00", seconds: 11 });
  assert.ok(projected.engine.showNow < 0);
  assert.deepEqual(brief(projected.trace), [
    { t: t("1969-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
    { t: t("1969-09-15T08:00:10-07:00"), kind: "render", code: "rotation.next", entry: 2, set: "standard", file: 102 },
  ]);
  // The unshifted fixture has nothing scheduled in 1969: the first tick evaluates and records the hold.
  const clock = previewClock();
  clock.set(at("1969-12-31T23:59:59Z"));
  const held = await run(fixture("base"), { start: "2026-09-01T08:00:00-07:00", seconds: 1, clock });
  assert.deepEqual(brief(held.trace), [{ t: t("1969-12-31T23:59:59Z"), kind: "hold", code: "set.empty" }]);
  assert.equal(held.engine.inspect().markerReason, "retry");
});

test("an orientation changed and changed back before a tick is no change", async () => {
  const { trace } = await run(fixture("base"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 11,
    events: { 5: (engine) => { engine.setOrientation("landscape"); engine.setOrientation("portrait"); } },
  });
  assert.deepEqual(brief(trace).map((e) => e.code), ["rotation.start", "rotation.next"]);
});

test("a failure reported twice for the item on screen skips it once", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T08:00:00-07:00");
  const item = engine.tick(start, 0).renderItem;
  engine.onFirstFrame(item.token);
  assert.equal(engine.onLoadFailed(item.token, "decoder gave up").length, 1);
  assert.equal(engine.onLoadFailed(item.token, "decoder gave up").length, 0);
  const next = engine.tick(start + 1000, 1000);
  assert.equal(next.renderItem.entryId, 2);
});

test("a late first frame does not push a known takeover back", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T11:29:50-07:00");
  const trace = [];
  let late = null; // each first frame is reported a second after its item is issued
  for (let s = 0; s < 12; s++) {
    const out = engine.tick(start + s * 1000, s * 1000);
    trace.push(...out.trace);
    if (late) trace.push(...engine.onFirstFrame(late.token));
    late = out.renderItem;
  }
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T11:29:51-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
    { t: t("2026-09-15T11:30:00-07:00"), kind: "cut", code: "takeover.activate", entry: 1 },
    { t: t("2026-09-15T11:30:01-07:00"), kind: "render", code: "rotation.start", entry: 2, set: "takeover", file: 102 },
  ]);
});

test("a takeover due while the next item is still loading cuts on time", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T11:29:46-07:00");
  const trace = [];
  for (let s = 0; s < 16; s++) {
    const out = engine.tick(start + s * 1000, s * 1000);
    trace.push(...out.trace);
    const item = out.renderItem;
    // The host never shows the standard item issued at 11:29:56.
    if (item && !(item.entryId === 2 && item.set === "standard")) trace.push(...engine.onFirstFrame(item.token));
  }
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T11:29:46-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 101 },
    { t: t("2026-09-15T11:30:00-07:00"), kind: "cut", code: "takeover.activate", entry: 1 },
    { t: t("2026-09-15T11:30:00-07:00"), kind: "render", code: "rotation.start", entry: 2, set: "takeover", file: 102 },
  ]);
});

test("items that fail right after their first frame still end in set.all_failed", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T08:00:00-07:00");
  const trace = [];
  for (let i = 0; i < 16; i++) {
    const out = engine.tick(start, 0);
    trace.push(...out.trace);
    if (!out.renderItem) break;
    trace.push(...engine.onFirstFrame(out.renderItem.token));
    trace.push(...engine.onLoadFailed(out.renderItem.token, "decoder gave up"));
  }
  assert.deepEqual(brief(trace).map((e) => `${e.kind} ${e.code} ${e.entry ?? ""}`.trim()), [
    "render rotation.start 1", "skip media.load_failed 1",
    "render rotation.next 2", "skip media.load_failed 2",
    "render rotation.next 3", "skip media.load_failed 3",
    "render rotation.next 4", "skip media.load_failed 4",
    "hold set.all_failed",
  ]);
});

test("a repeated failure report cannot cut short the all-failed hold", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T08:00:00-07:00");
  const first = engine.tick(start, 0).renderItem;
  engine.onFirstFrame(first.token);
  engine.onLoadFailed(first.token, "decoder gave up");
  for (let i = 0; i < 8; i++) {
    const item = engine.tick(start, 0).renderItem;
    if (!item) break;
    engine.onLoadFailed(item.token, "not held");
  }
  assert.equal(engine.inspect().markerReason, "retry");
  assert.deepEqual(engine.onLoadFailed(first.token, "decoder gave up again"), []);
  const later = engine.tick(start + 200, 200);
  assert.equal(later.renderItem, null);
  assert.equal(later.trace.length, 0);
});

test("a failure reported for an item that was cut does not move the new playlist's cursor", async () => {
  const snapshot = await loadCartridge(fixture("schedule-change"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T08:00:20-07:00");
  const third = engine.tick(start, 0).renderItem;
  engine.onFirstFrame(third.token);
  const cut = engine.tick(start + 5000, 5000); // 08:00:25: playlist 2 takes over the lane
  assert.equal(cut.trace[0].code, "schedule.change");
  assert.deepEqual(engine.onLoadFailed(third.token, "decoder gave up"), []);
  assert.equal(engine.onFirstFrame(cut.renderItem.token)[0].code, "rotation.start");
  assert.equal(engine.inspect().cursors.standard, 1);
});

test("through a missing orientation and out of it, the rotation keeps its cursors", async () => {
  const { engine, trace } = await run(fixture("base"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 3,
    events: { 1: (e) => e.setOrientation(null), 2: (e) => e.setOrientation("landscape") },
  });
  assert.equal(engine.orientation, "landscape");
  assert.equal(engine.renderedOrientation, "landscape");
  assert.deepEqual(brief(trace).map((e) => `${e.kind} ${e.code} ${e.file ?? e.entry ?? ""}`.trim()), [
    "render rotation.start 101",
    "cut orientation.change 1",
    "warning orientation.missing",
    "render rotation.next 202",
    "cut orientation.change 2",
    "render rotation.next 203",
  ]);
});

test("a first frame reported for a superseded item is ignored", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, orientation: "portrait", clock: surfaceClock() });
  const start = at("2026-09-15T08:00:00-07:00");
  const stale = engine.tick(start, 0).renderItem;
  // A wall-clock correction before the first frame: the pending item is abandoned.
  const fresh = engine.tick(start + 3_600_000, 1000);
  assert.equal(fresh.trace[0].code, "jump.forward");
  assert.notEqual(fresh.renderItem.token, stale.token);
  assert.deepEqual(engine.onFirstFrame(stale.token), []);
  assert.equal(engine.onFirstFrame(fresh.renderItem.token)[0].code, "rotation.start");
});

test("directives sharing a timestamp are decided by id, the highest governing", () => {
  const series = new DirectiveSeries([
    { id: 1, entryId: 1, type: "takeover", timestamp: 100, onScreen: true },
    { id: 2, entryId: 1, type: "takeover", timestamp: 100, onScreen: false },
    { id: 3, entryId: 1, type: "takeover", timestamp: 200, onScreen: false },
    { id: 4, entryId: 1, type: "takeover", timestamp: 200, onScreen: true },
  ]);
  assert.equal(series.isOn(150, -Infinity), false);
  assert.equal(series.isOn(250, -Infinity), true);
  assert.equal(series.nextOn(50), 200);
  assert.equal(series.isOn(250, 220), false, "day scoping drops directives before the day");
});

test("the playback window follows §5.8", () => {
  const entry = { startTimePortrait: 2, endTimePortrait: 7, startTimeLandscape: null, endTimeLandscape: null };
  const still = { contentType: "image/png", intrinsicDuration: null };
  const clip = { contentType: "video/mp4", intrinsicDuration: 12 };
  const item = { displayDuration: null };
  assert.deepEqual(playbackWindow(entry, item, still, "portrait"), { start: 2, duration: 5, source: "window" });
  assert.deepEqual(playbackWindow(entry, item, still, "landscape"), { start: 0, duration: 8, source: "default" });
  assert.deepEqual(playbackWindow(entry, { displayDuration: 6 }, still, "landscape"), { start: 0, duration: 6, source: "display_duration" });
  assert.deepEqual(playbackWindow({ ...entry, endTimePortrait: 1 }, item, clip, "portrait"), { start: 2, duration: 10, source: "clip" });
  assert.deepEqual(playbackWindow(entry, item, { contentType: "video/mp4", intrinsicDuration: null }, "landscape"), { start: 0, duration: null, source: "clip" });
});

test("board pages turn every page duration from the anchor, wrapping", () => {
  const board = { pageCount: 3, anchorPage: 1, pageDuration: 8 };
  assert.deepEqual([0, 7_999, 8_000, 16_000, 24_000].map((ms) => boardPageAt(board, 1000, 1000 + ms)), [1, 1, 2, 0, 1]);
});

test("the minimal board resolver marks past, now, next and later", async () => {
  const snapshot = await loadCartridge(fixture("board"));
  const set = snapshot.sessionSets.get(1);
  const { model, pageCount } = minimalBoardResolver(set, {
    showNow: at("2026-09-15T10:10:00-07:00"),
    timezone: "America/Los_Angeles",
    entries: snapshot.sessionSetEntries.get(1),
    sessions: snapshot.sessions,
    snapshot,
  });
  assert.equal(pageCount, 1);
  // The fixture's thirteen Day 1 sessions run hourly from 09:00: at 10:10 one is past, one on, one next, ten later.
  assert.deepEqual(model.sessions.map((s) => [s.name, s.state]), [
    ["Session 1", "past"], ["Session 2", "now"], ["Session 3", "next"],
    ...Array.from({ length: 10 }, (_, i) => [`Session ${i + 4}`, "later"]),
  ]);
});

test("venue time on a Day 1 that springs forward: the skipped hour resolves to the next valid instant", () => {
  const start = at("2027-03-14T00:00:00-08:00");
  const calendar = new Calendar([{ id: 1, day: "2027-03-14", startTime: start, endTime: at("2027-03-14T23:59:59.999-07:00") }], "America/Los_Angeles");
  // A week earlier, off-DST, at 02:30 and 01:30 venue time.
  assert.equal(calendar.surfaceNow(at("2027-03-07T02:30:00-08:00")), at("2027-03-14T03:00:00-07:00"));
  assert.equal(calendar.surfaceNow(at("2027-03-07T01:30:00-08:00")), at("2027-03-14T01:30:00-08:00"));
  assert.equal(calendar.surfaceNow(at("2027-03-07T09:00:00-08:00")), at("2027-03-14T09:00:00-07:00"));
});

test("venue time on a Day 1 that falls back: the repeated hour resolves to the earlier instant", () => {
  const start = at("2026-11-01T00:00:00-07:00");
  const calendar = new Calendar([{ id: 1, day: "2026-11-01", startTime: start, endTime: at("2026-11-01T23:59:59.999-08:00") }], "America/Los_Angeles");
  assert.equal(calendar.surfaceNow(at("2026-10-25T01:30:00-07:00")), at("2026-11-01T01:30:00-07:00"));
  assert.equal(calendar.surfaceNow(at("2026-10-25T14:00:00-07:00")), at("2026-11-01T14:00:00-08:00"));
});

test("the device timezone never decides the show clock", () => {
  const calendar = new Calendar([{ id: 1, day: "2026-09-15", startTime: at("2026-09-15T00:00:00-07:00"), endTime: at("2026-09-15T23:59:59.999-07:00") }], "America/Los_Angeles");
  const real = at("2026-09-08T12:00:00-04:00");
  const before = process.env.TZ;
  const answers = [];
  for (const tz of ["America/New_York", "Asia/Tokyo", "UTC"]) {
    process.env.TZ = tz;
    answers.push(calendar.surfaceNow(real));
  }
  process.env.TZ = before;
  assert.deepEqual(answers, Array(3).fill(at("2026-09-15T09:00:00-07:00")));
});
