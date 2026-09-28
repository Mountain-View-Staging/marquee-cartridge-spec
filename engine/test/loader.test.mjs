/**
 * The Loader: what it accepts, what it refuses, and how it says so.
 * Each refusal is a CartridgeError with a stable code; each tolerated oddity
 * is a load warning (specification §2.1, §10).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CartridgeError, buildSnapshot, loadCartridge, nodeSqliteOpener, readCartridge } from "../dist/node.js";
import { fixture, variant } from "./helpers.mjs";

async function refusal(bytes, options) {
  try {
    await loadCartridge(bytes, options);
  } catch (error) {
    assert.ok(error instanceof CartridgeError, `expected a CartridgeError, got ${error}`);
    return error;
  }
  assert.fail("the Loader accepted a cartridge it should refuse");
}

test("loads a v25.0.1 surface cartridge into an indexed snapshot", async () => {
  const s = await loadCartridge(fixture("base"));
  assert.equal(s.kind, "surface");
  assert.equal(s.meta.formatVersion, "25.0.1");
  assert.equal(s.meta.surfaceId, "LOBBY3");
  assert.equal(s.days.length, 1);
  assert.equal(s.surfaceConfig.surfaceId, "LOBBY3");
  assert.deepEqual(s.locations.map((l) => [l.locationId, l.label]), [["LOBBY3-A", "Lobby 3 — north wall"]]);
  assert.equal("orientation" in s.locations[0], false, "a location carries no orientation (§6)");
  assert.deepEqual(s.playlists.get(1).entries.map((e) => e.position), [1, 2, 3, 4]);
  assert.deepEqual(s.directives.get(2).takeover.map((d) => d.onScreen), [true, false]);
  assert.deepEqual(Object.keys(s.scheduleBySlot), ["playlist", "demo_station"]);
  assert.deepEqual(s.scheduleBySlot.playlist.map((e) => [e.id, e.slot, e.playlistId]), [[1, "playlist", 1]]);
  assert.deepEqual(s.scheduleBySlot.demo_station, []);
  assert.deepEqual(s.warnings, []);
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.days) && Object.isFrozen(s.playlists.get(1).entries));
});

test("refuses bytes that are not SQLite, before opening them", async () => {
  const html = new TextEncoder().encode("<!doctype html><title>Sign in to the Wi-Fi</title>");
  assert.equal((await refusal(html)).code, "not_sqlite");
  assert.equal((await refusal(new Uint8Array(0))).code, "not_sqlite");
});

test("refuses a different format_version first component, and says which", async () => {
  const error = await refusal(variant("base", "UPDATE cartridge_meta SET format_version = '24.9.0'"));
  assert.equal(error.code, "format_unsupported");
  assert.equal(error.message, "format 24 is not supported (this engine reads 25)");
  assert.equal((await refusal(variant("base", "UPDATE cartridge_meta SET format_version = '26.0.0'"))).code, "format_unsupported");
  assert.equal((await refusal(variant("base", "UPDATE cartridge_meta SET format_version = 'next'"))).code, "format_unsupported");
});

test("accepts a newer version with the same first component", async () => {
  const s = await loadCartridge(variant("base", "UPDATE cartridge_meta SET format_version = '25.3.0'"));
  assert.equal(s.meta.formatVersion, "25.3.0");
});

test("refuses a pre-v25 artifact, which has no cartridge_meta", async () => {
  const error = await refusal(variant("base", "DROP TABLE cartridge_meta"));
  assert.equal(error.code, "not_v25");
});

test("refuses the wrong kind of artifact", async () => {
  const project = variant("base", "UPDATE cartridge_meta SET cartridge_kind = 'project', surface_id = NULL");
  assert.equal((await refusal(project)).code, "kind_mismatch");
  assert.equal((await refusal(fixture("base"), { kind: "project" })).code, "kind_mismatch");
});

test("an undecodable directive row fails the load, naming the table and the row", async () => {
  const error = await refusal(variant("base", `
    INSERT INTO directive (id, entry_id, type, timestamp, on_screen, timezone, created, updated)
    VALUES (99, 1, 'standard', 'nine o''clock', 1, NULL, 0, 0)`));
  assert.equal(error.code, "row_undecodable");
  assert.equal(error.table, "directive");
  assert.equal(error.row, "id=99");
  assert.match(error.message, /directive/);
  assert.match(error.message, /id=99/);
  assert.match(error.message, /timestamp/);
});

test("a boolean outside 0 and 1 is undecodable too", async () => {
  const error = await refusal(variant("base", "UPDATE directive SET on_screen = 2 WHERE id = 3"));
  assert.equal(error.code, "row_undecodable");
  assert.equal(error.row, "id=3");
});

test("an unknown table is a warning that names it, and the cartridge loads", async () => {
  const s = await loadCartridge(variant("base", "CREATE TABLE surface_mood (id INTEGER PRIMARY KEY, mood TEXT)"));
  const warning = s.warnings.find((w) => w.code === "table.unknown");
  assert.ok(warning, "expected a table.unknown warning");
  assert.equal(warning.table, "surface_mood");
  assert.match(warning.message, /surface_mood/);
  assert.equal(s.playlists.get(1).entries.length, 4);
});

test("an unknown column is a warning, and the rest of the table still decodes", async () => {
  const s = await loadCartridge(variant("base", "ALTER TABLE playlist ADD COLUMN mood TEXT"));
  assert.deepEqual(s.warnings.map((w) => [w.code, w.table, w.column]), [["column.unknown", "playlist", "mood"]]);
  assert.equal(s.playlists.get(1).name, "Playlist A");
});

test("a retired column — an earlier draft's surface_location.orientation — loads with no warning and is never read", async () => {
  // As an earlier draft of v25.0.1 wrote it: the mount, NOT NULL.
  const earlier = variant("base", "ALTER TABLE surface_location ADD COLUMN orientation TEXT NOT NULL DEFAULT 'portrait'");
  const s = await loadCartridge(earlier);
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(s.locations.map((l) => Object.keys(l).sort()), [["configId", "id", "label", "locationId"]]);
  // Never read, so nothing it holds is judged: an unknown value, a NUL byte, a number.
  for (const value of ["'sideways'", "'portrait' || char(0)", "7"]) {
    const odd = await loadCartridge(variant("base", `ALTER TABLE surface_location ADD COLUMN orientation TEXT; UPDATE surface_location SET orientation = ${value}`));
    assert.deepEqual(odd.warnings, [], value);
    assert.equal(odd.locations.length, 1, value);
  }
  // The retired name is retired in its own table only.
  const elsewhere = await loadCartridge(variant("base", "ALTER TABLE playlist ADD COLUMN orientation TEXT"));
  assert.deepEqual(elsewhere.warnings.map((w) => [w.code, w.table, w.column]), [["column.unknown", "playlist", "orientation"]]);
});

test("buildSnapshot ignores a retired column a tool still supplies", async () => {
  const s = await loadCartridge(fixture("base"));
  const rows = {
    cartridge_meta: [{ cartridge_kind: "surface", format_version: "25.0.1", project_code: "SHOW26", surface_id: "LOBBY3", published_revision: 1, timezone: "America/Los_Angeles", generated_at: 0 }],
    project: [{ id: 1, cloud_uid: "u", name: "Show 26", project_code: "SHOW26", timezone: "America/Los_Angeles", show_wallpaper_item_id: null, desktop_wallpaper_item_id: null, backing_item_id: null, brand_style: null, brand_style_item_id: null }],
    project_days: s.days.map((d) => ({ id: d.id, day: d.day, start_time: d.startTime, end_time: d.endTime })),
    surface_config: [{ id: 1, name: "Lobby 3", surface_id: "LOBBY3", published_revision: 1, published_at: 0 }],
    surface_location: [{ id: 1, config_id: 1, location_id: "LOBBY3-A", orientation: "landscape", label: null }],
  };
  const built = buildSnapshot("surface", rows, []);
  assert.deepEqual(built.warnings, []);
  assert.deepEqual(built.locations, [{ id: 1, configId: 1, locationId: "LOBBY3-A", label: null }]);
});

test("rows with unknown enumerated values are skipped with a warning, not fatal", async () => {
  const s = await loadCartridge(variant("base", `
    PRAGMA ignore_check_constraints = ON;
    INSERT INTO directive (id, entry_id, type, timestamp, on_screen, timezone, created, updated)
    VALUES (98, 1, 'priority', 1789000000000, 1, NULL, 0, 0);
    INSERT INTO surface_schedule_entry (id, config_id, slot, timestamp, playlist_id, background_item_id, overlay_item_id, created, updated)
    VALUES (9, 1, 'ceiling', 1789000000000, 1, NULL, NULL, 0, 0)`));
  assert.deepEqual(s.warnings.map((w) => [w.code, w.table, w.rowId]), [
    ["value.unknown", "surface_schedule_entry", 9],
    ["value.unknown", "directive", 98],
  ]);
  assert.equal(s.directives.get(1).standard.length, 1);
});

test("a schedule row on a retired slot — an earlier draft's 'portrait' or 'landscape' — is malformed: skipped with a warning naming the column", async () => {
  // As an earlier draft wrote them: a playlist lane per orientation. There is no dual reading.
  const s = await loadCartridge(variant("base", `
    PRAGMA ignore_check_constraints = ON;
    INSERT INTO surface_schedule_entry VALUES (7, 1, 'portrait', 1789000000000, 1, NULL, NULL, 0, 0);
    INSERT INTO surface_schedule_entry VALUES (8, 1, 'landscape', 1789000000000, NULL, NULL, NULL, 0, 0);
    INSERT INTO surface_schedule_entry VALUES (9, 1, 'ceiling', 1789000000000, 1, NULL, NULL, 0, 0)`));
  assert.deepEqual(s.warnings.map((w) => [w.code, w.table, w.column, w.rowId]), [
    ["value.malformed", "surface_schedule_entry", "slot", 7],
    ["value.malformed", "surface_schedule_entry", "slot", 8],
    ["value.unknown", "surface_schedule_entry", "slot", 9],
  ]);
  assert.match(s.warnings[0].message, /retired/);
  assert.deepEqual(s.scheduleBySlot.playlist.map((e) => e.id), [1]);
  // A cartridge from the earlier draft, with no playlist row at all, schedules nothing.
  const draft = await loadCartridge(variant("base", `
    PRAGMA ignore_check_constraints = ON;
    UPDATE surface_schedule_entry SET slot = 'portrait';
    INSERT INTO surface_schedule_entry VALUES (2, 1, 'landscape', 1789000000000, 1, NULL, NULL, 0, 0)`));
  assert.deepEqual(draft.scheduleBySlot.playlist, []);
  assert.deepEqual(draft.warnings.map((w) => [w.code, w.rowId]), [["value.malformed", 1], ["value.malformed", 2]]);
});

test("demo_station rows load into their own slot, and a tool's rows build the same way", async () => {
  const s = await loadCartridge(fixture("demo-station"));
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(s.scheduleBySlot.playlist.map((e) => e.id), [1]);
  assert.deepEqual(s.scheduleBySlot.demo_station.map((e) => [e.id, e.playlistId, e.backgroundItemId, e.overlayItemId]), [[2, null, 9, 8], [3, null, null, null]]);
  // buildSnapshot, as an authoring tool calls it: a retired slot is malformed there too.
  const rows = {
    cartridge_meta: [{ cartridge_kind: "surface", format_version: "25.0.1", project_code: "SHOW26", surface_id: "LOBBY3", published_revision: 1, timezone: "America/Los_Angeles", generated_at: 0 }],
    project: [{ id: 1, cloud_uid: "u", name: "Show 26", project_code: "SHOW26", timezone: "America/Los_Angeles", show_wallpaper_item_id: null, desktop_wallpaper_item_id: null, backing_item_id: null, brand_style: null, brand_style_item_id: null }],
    surface_config: [{ id: 1, name: "Lobby 3", surface_id: "LOBBY3", published_revision: 1, published_at: 0 }],
    surface_location: [{ id: 1, config_id: 1, location_id: "LOBBY3-A", label: null }],
    surface_schedule_entry: [
      { id: 1, config_id: 1, slot: "playlist", timestamp: 0, playlist_id: null, background_item_id: null, overlay_item_id: null },
      { id: 2, config_id: 1, slot: "landscape", timestamp: 0, playlist_id: null, background_item_id: null, overlay_item_id: null },
    ],
  };
  const built = buildSnapshot("surface", rows, []);
  assert.deepEqual(built.scheduleBySlot.playlist.map((e) => e.id), [1]);
  assert.deepEqual(built.warnings.filter((w) => w.table === "surface_schedule_entry").map((w) => [w.code, w.rowId]), [["value.malformed", 2]]);
});

test("a damaged file that still starts with the SQLite magic is refused as damaged", async () => {
  const bytes = fixture("base");
  const truncated = bytes.slice(0, 4096);
  const garbage = bytes.slice();
  for (let i = 4096; i < garbage.length; i++) garbage[i] = (i * 131) & 0xff;
  const header = bytes.slice();
  for (let i = 16; i < 100; i++) header[i] = 0xa5;
  for (const damaged of [truncated, garbage, header]) {
    const error = await refusal(damaged);
    assert.ok(["damaged", "table_unreadable"].includes(error.code), `${error.code}: ${error.message}`);
  }
  assert.equal((await refusal(header)).code, "damaged");
});

test("a missing baseline table or column is refused", async () => {
  const table = await refusal(variant("base", "DROP TABLE session_set_entry"));
  assert.equal(table.code, "table_missing");
  assert.equal(table.table, "session_set_entry");
  const column = await refusal(variant("base", "ALTER TABLE media_item DROP COLUMN brand_member"));
  assert.equal(column.code, "column_missing");
  assert.match(column.message, /brand_member/);
});

test("a surface cartridge has exactly one surface_config", async () => {
  const error = await refusal(variant("base", "INSERT INTO surface_config VALUES (2, 'Other', 'OTHER1', 1, 0, 0, 0)"));
  assert.equal(error.code, "structure_invalid");
});

test("a project cartridge loads as a project snapshot", async () => {
  const bytes = variant("base", `
    UPDATE cartridge_meta SET cartridge_kind = 'project', surface_id = NULL;
    DROP TABLE surface_schedule_entry; DROP TABLE surface_location; DROP TABLE surface_config;
    DROP TABLE directive; DROP TABLE playlist_entry; DROP TABLE playlist;
    DROP TABLE session_set_entry; DROP TABLE session_set; DROP TABLE session`);
  const s = await loadCartridge(bytes, { kind: "project" });
  assert.equal(s.kind, "project");
  assert.equal(s.meta.surfaceId, null);
  assert.equal(s.days.length, 1);
  assert.deepEqual(s.warnings, []);
});

test("a NUL byte in a text column is a malformed row: skipped with a warning naming the column", async () => {
  const s = await loadCartridge(variant("base", `
    PRAGMA ignore_check_constraints = ON;
    UPDATE media_item SET name = 'Item' || char(0) || '1' WHERE id = 1;
    UPDATE directive SET type = char(0) || 'takeover' WHERE id = 5`));
  // The Loader drops the rows before the enumerated values are read, so directive 5 is
  // malformed, not unknown; entry 1's item is then a dangling reference.
  assert.deepEqual(s.warnings.map((w) => [w.code, w.table, w.column, w.rowId]), [
    ["value.malformed", "directive", "type", 5],
    ["value.malformed", "media_item", "name", 1],
    ["reference.dangling", "playlist_entry", "media_item_id", 1],
  ]);
  assert.equal(s.warnings[1].message, "table media_item, row id=1: name holds a NUL byte (U+0000); the row is malformed and ignored");
  assert.equal(s.mediaItems.has(1), false);
  assert.deepEqual(s.directives.get(2).takeover.map((d) => d.onScreen), [false]);
  assert.equal(s.playlists.get(1).entries.length, 4);
});

test("a NUL byte in cartridge_meta, project or surface_config refuses the cartridge with that table's code", async () => {
  const meta = await refusal(variant("base", "UPDATE cartridge_meta SET timezone = 'America/Los_Angeles' || char(0)"));
  assert.equal(meta.code, "meta_invalid");
  assert.equal(meta.table, "cartridge_meta");
  assert.equal(meta.row, "#1");
  assert.equal(meta.message, "table cartridge_meta, row #1: timezone holds a NUL byte (U+0000); the row is malformed, and a cartridge has exactly one");
  const project = await refusal(variant("base", "UPDATE project SET name = char(0) || 'Show 26'"));
  assert.equal(project.code, "structure_invalid");
  assert.equal(project.table, "project");
  assert.equal(project.row, "id=1");
  assert.equal(project.message, "table project, row id=1: name holds a NUL byte (U+0000); the row is malformed, and a cartridge has exactly one");
  const config = await refusal(variant("base", "UPDATE surface_config SET name = 'Lobby 3' || char(0) || 'x'"));
  assert.equal(config.code, "structure_invalid");
  assert.equal(config.table, "surface_config");
  assert.equal(config.row, "id=1");
});

test("the identity row's own columns are checked for a NUL byte before they are read", async () => {
  for (const sql of [
    "UPDATE cartridge_meta SET cartridge_kind = 'surface' || char(0) || 'x'",
    "UPDATE cartridge_meta SET format_version = '25.0.1' || char(0)",
    "UPDATE cartridge_meta SET surface_id = char(0)",
  ]) {
    const error = await refusal(variant("base", sql));
    assert.equal(error.code, "meta_invalid", sql);
    assert.match(error.message, /^table cartridge_meta, row #1: \w+ holds a NUL byte \(U\+0000\)/, sql);
  }
});

test("the NUL byte is found in SQL, so a binding that ends the string at it says the same", async () => {
  // sql.js, and node:sqlite before Node 24, return 'Item' for 'Item\0 1'. Play that binding.
  const inner = nodeSqliteOpener(variant("base", "UPDATE media_item SET name = 'Item' || char(0) || ' 1' WHERE id = 1"));
  const cut = (v) => (typeof v === "string" ? v.split("\u0000")[0] : v);
  const truncating = {
    all: (sql) => inner.all(sql).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cut(v)]))),
    close: () => inner.close(),
  };
  try {
    const s = readCartridge(truncating, "surface");
    assert.deepEqual(s.warnings.map((w) => [w.code, w.table, w.column, w.rowId]), [
      ["value.malformed", "media_item", "name", 1],
      ["reference.dangling", "playlist_entry", "media_item_id", 1],
    ]);
  } finally {
    truncating.close();
  }
});

test("an invalid venue timezone loads with a warning (the clock degrades to real time)", async () => {
  const s = await loadCartridge(variant("base", "UPDATE cartridge_meta SET timezone = 'Mars/Olympus_Mons'"));
  assert.ok(s.warnings.some((w) => w.code === "timezone.invalid"));
});
