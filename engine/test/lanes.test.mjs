/**
 * filesForLanes: which files a host needs for the lanes it renders (§7.7).
 * Every file the manifest lists, except those referenced only as an item's
 * slot file on a lane the host does not render.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import { filesForLanes, loadCartridge } from "../dist/node.js";
import { CARTRIDGES, fixture, variant } from "./helpers.mjs";

const ids = (set) => [...set];

test("the base show: a portrait host wants the portrait files, a landscape host the landscape ones", async () => {
  const s = await loadCartridge(fixture("base"));
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [101, 102, 103, 104]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [201, 202, 203, 204]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape", "portrait"] })), [101, 102, 103, 104, 201, 202, 203, 204]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: [] })), []);
});

test("a file is judged by every slot that names it: a landscape file in a portrait slot serves a portrait host", async () => {
  // orientation.db: item 1 is landscape-only (201), item 2 holds file 202 in BOTH slots,
  // item 3 is 103 / 203.
  const s = await loadCartridge(fixture("orientation"));
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [103, 202]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [201, 202, 203]);
});

test("over every conformance fixture: the two lanes together are the manifest, each alone a subset, ids ascending", async () => {
  const names = readdirSync(CARTRIDGES).filter((f) => f.endsWith(".db")).map((f) => f.slice(0, -3)).sort();
  assert.ok(names.length >= 12);
  for (const name of names) {
    const s = await loadCartridge(fixture(name));
    const manifest = [...s.manifest.keys()].sort((a, b) => a - b);
    const portrait = ids(filesForLanes(s, { lanes: ["portrait"] }));
    const landscape = ids(filesForLanes(s, { lanes: ["landscape"] }));
    for (const list of [portrait, landscape]) {
      assert.deepEqual(list, [...list].sort((a, b) => a - b), `${name}: ascending`);
      for (const id of list) assert.ok(s.manifest.has(id), `${name}: ${id} is in the manifest`);
    }
    assert.deepEqual([...new Set([...portrait, ...landscape])].sort((a, b) => a - b), manifest, name);
    // What a portrait host leaves out is exactly what only landscape slots name.
    const portraitSlots = new Set([...s.mediaItems.values()].map((i) => i.portraitFileId));
    assert.deepEqual(manifest.filter((id) => !portrait.includes(id)), manifest.filter((id) => !portraitSlots.has(id) && landscape.includes(id)), name);
  }
});

/**
 * A portrait-only config shaped like a real one: the landscape lane is not
 * scheduled, most items carry a landscape file no portrait device can show, and
 * the cartridge also delivers backings, brand files and a file no item names.
 */
function portraitOnlyShow() {
  const file = (id, orientation) => `
    INSERT INTO media_file VALUES (${id}, 'image/png', 'PNG', 1080, 1920, '${orientation}', 0.5625, NULL, 0, 0);
    INSERT INTO media_manifest VALUES (${id}, 'file-${id}.png', 'sha256:${String(id).padStart(64, "0")}', 1024, 'image/png');`;
  return variant("board", `
    DELETE FROM surface_schedule_entry WHERE slot = 'landscape';
    -- item 3 becomes landscape-only, its portrait file gone from the cartridge
    UPDATE media_item SET portrait_file_id = NULL WHERE id = 3;
    DELETE FROM media_manifest WHERE media_file_id = 103;
    DELETE FROM media_file_variant WHERE media_file_id = 103;
    DELETE FROM media_file WHERE id = 103;
    ${[150, 250, 260, 261, 262, 270, 280, 999].map((id) => file(id, id < 200 ? "portrait" : "landscape")).join("")}
    INSERT INTO media_item VALUES (50, 'Project backing', 150, 250, NULL, NULL, 0, 0);
    INSERT INTO media_item VALUES (60, 'A typeface', NULL, 260, NULL, 'acme/acme-2026/1', 0, 0);
    INSERT INTO media_item VALUES (61, 'Style book (project)', NULL, 261, NULL, NULL, 0, 0);
    INSERT INTO media_item VALUES (62, 'Style book (board)', NULL, 262, NULL, NULL, 0, 0);
    INSERT INTO media_item VALUES (70, 'Board backing', NULL, 270, NULL, NULL, 0, 0);
    INSERT INTO media_item VALUES (80, 'Landscape art', NULL, 280, NULL, NULL, 0, 0);
    INSERT INTO media_item VALUES (81, 'The same art, placed in a portrait slot', 280, NULL, NULL, NULL, 0, 0);
    UPDATE project SET backing_item_id = 50, brand_style_item_id = 61;
    UPDATE session_set SET backing_item_id = 70, brand_style_item_id = 62 WHERE id = 1;`);
}

test("a portrait-only show: the landscape slot files stay behind; brand files, portrait backings and unnamed files come", async () => {
  const s = await loadCartridge(portraitOnlyShow());
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(s.scheduleBySlot.landscape, []);
  assert.deepEqual([...s.manifest.keys()].sort((a, b) => a - b), [101, 150, 201, 203, 250, 260, 261, 262, 270, 280, 999]);
  // 201 and 203 are the rotation's landscape files, 250 the backing's, 270 the board backing's.
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [101, 150, 260, 261, 262, 280, 999]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [201, 203, 250, 260, 261, 262, 270, 280, 999]);
  // No DemoStation lane: `demo` changes nothing.
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"], demo: true })), [101, 150, 260, 261, 262, 280, 999]);
});

test("demo: while the demo lane has an entry with a background, the opposite lane comes too", async () => {
  const on = await loadCartridge(variant("base", `
    INSERT INTO surface_schedule_entry VALUES (10, 1, 'demo_station', 1789488000000, NULL, 1, NULL, 0, 0);
    INSERT INTO surface_schedule_entry VALUES (11, 1, 'demo_station', 1789491600000, NULL, NULL, NULL, 0, 0)`));
  assert.deepEqual(ids(filesForLanes(on, { lanes: ["portrait"], demo: true })), [101, 102, 103, 104, 201, 202, 203, 204]);
  assert.deepEqual(ids(filesForLanes(on, { lanes: ["landscape"], demo: true })), [101, 102, 103, 104, 201, 202, 203, 204]);
  // A host without the mode ignores the lane.
  assert.deepEqual(ids(filesForLanes(on, { lanes: ["portrait"] })), [101, 102, 103, 104]);
  assert.deepEqual(ids(filesForLanes(on, { lanes: ["portrait"], demo: false })), [101, 102, 103, 104]);
  // Only "demo off" entries (no background): no picture-in-picture, no opposite lane.
  const off = await loadCartridge(variant("base", "INSERT INTO surface_schedule_entry VALUES (11, 1, 'demo_station', 1789491600000, NULL, NULL, NULL, 0, 0)"));
  assert.deepEqual(ids(filesForLanes(off, { lanes: ["portrait"], demo: true })), [101, 102, 103, 104]);
});

test("a project snapshot reads the same way", async () => {
  const project = await loadCartridge(variant("base", `
    UPDATE cartridge_meta SET cartridge_kind = 'project', surface_id = NULL;
    DROP TABLE surface_schedule_entry; DROP TABLE surface_location; DROP TABLE surface_config;
    DROP TABLE directive; DROP TABLE playlist_entry; DROP TABLE playlist;
    DROP TABLE session_set_entry; DROP TABLE session_set; DROP TABLE session;
    UPDATE project SET show_wallpaper_item_id = 1`), { kind: "project" });
  assert.equal(project.kind, "project");
  assert.deepEqual(ids(filesForLanes(project, { lanes: ["portrait"], demo: true })), [101, 102, 103, 104]);
  assert.deepEqual(ids(filesForLanes(project, { lanes: ["landscape"] })), [201, 202, 203, 204]);
});
