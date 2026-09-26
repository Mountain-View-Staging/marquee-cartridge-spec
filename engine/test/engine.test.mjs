/**
 * Engine behaviour the conformance scenarios do not reach: orientation
 * changes, commits, backings, skipped non-media, a missing orientation,
 * preview pauses, day-scoping ties, and venue time on daylight-saving dates.
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
  const engine = createEngine({ snapshot, slot: "portrait", orientation: "portrait", clock: surfaceClock() });
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

test("an orientation change cuts, keeps the cursor on the same playlist, and plays the other slot's file", async () => {
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

test("an orientation change to a lane with nothing scheduled holds the last frame", async () => {
  const { trace, engine } = await run(fixture("schedule-change"), {
    start: "2026-09-15T08:00:00-07:00",
    seconds: 8,
    events: { 3: (e) => e.setOrientation("landscape") },
  });
  assert.equal(engine.slot, "landscape");
  assert.deepEqual(brief(trace).slice(1), [
    { t: t("2026-09-15T08:00:03-07:00"), kind: "cut", code: "orientation.change", entry: 1 },
    { t: t("2026-09-15T08:00:03-07:00"), kind: "hold", code: "set.empty" },
  ]);
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

test("a missing orientation skips the orientation gate and says so once", async () => {
  const { trace } = await run(fixture("orientation"), { start: "2026-09-15T08:00:00-07:00", seconds: 21, orientation: null });
  assert.deepEqual(brief(trace), [
    { t: t("2026-09-15T08:00:00-07:00"), kind: "warning", code: "orientation.missing" },
    { t: t("2026-09-15T08:00:00-07:00"), kind: "render", code: "rotation.start", entry: 1, set: "standard", file: 201 },
    { t: t("2026-09-15T08:00:10-07:00"), kind: "render", code: "rotation.next", entry: 2, set: "standard", file: 202 },
    { t: t("2026-09-15T08:00:20-07:00"), kind: "render", code: "rotation.next", entry: 3, set: "standard", file: 103 },
  ]);
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

test("a first frame reported for a superseded item is ignored", async () => {
  const snapshot = await loadCartridge(fixture("base"));
  const engine = createEngine({ snapshot, slot: "portrait", orientation: "portrait", clock: surfaceClock() });
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
  assert.deepEqual(model.sessions.map((s) => [s.name, s.state]), [["Session 1", "past"], ["Session 2", "now"], ["Session 3", "next"]]);
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
