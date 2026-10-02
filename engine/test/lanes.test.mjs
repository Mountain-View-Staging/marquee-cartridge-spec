/**
 * filesForLanes: which files a host needs for the lanes it renders (§7.7). A
 * lane is one orientation over the one schedule. Every file the manifest lists,
 * except those referenced only as an item's slot file for an orientation the
 * host does not render, or only as demo branding on a host without the
 * DemoStation mode.
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

test("over every conformance fixture: the two lanes together are the manifest — with the DemoStation mode where a fixture has demo branding — each alone a subset, ids ascending", async () => {
  const names = readdirSync(CARTRIDGES).filter((f) => f.endsWith(".db")).map((f) => f.slice(0, -3)).sort();
  assert.ok(names.length >= 12);
  for (const name of names) {
    const s = await loadCartridge(fixture(name));
    const manifest = [...s.manifest.keys()].sort((a, b) => a - b);
    const lanes = (demo) => ["portrait", "landscape"].map((lane) => ids(filesForLanes(s, { lanes: [lane], demo })));
    for (const demo of [false, true]) {
      for (const list of lanes(demo)) {
        assert.deepEqual(list, [...list].sort((a, b) => a - b), `${name}: ascending`);
        for (const id of list) assert.ok(s.manifest.has(id), `${name}: ${id} is in the manifest`);
      }
    }
    const union = (lists) => [...new Set(lists.flat())].sort((a, b) => a - b);
    assert.deepEqual(union(lanes(true)), manifest, name);
    // Without the mode, the two lanes leave out the files of demo branding and nothing else.
    const branding = new Set(s.scheduleBySlot.demo_station.flatMap((e) => [e.backgroundItemId, e.overlayItemId]).filter((id) => id !== null));
    const brandingFiles = new Set([...s.mediaItems.values()].filter((i) => branding.has(i.id)).flatMap((i) => [i.portraitFileId, i.landscapeFileId]));
    const left = manifest.filter((id) => !union(lanes(false)).includes(id));
    for (const id of left) assert.ok(brandingFiles.has(id), `${name}: ${id} is left out, and no demo branding names it`);
    if (branding.size > 0) continue;
    // No demo branding: `demo` changes nothing, and what a portrait host leaves out is exactly
    // what only landscape slots name.
    assert.deepEqual(lanes(true), lanes(false), name);
    const [portrait, landscape] = lanes(false);
    const portraitSlots = new Set([...s.mediaItems.values()].map((i) => i.portraitFileId));
    assert.deepEqual(manifest.filter((id) => !portrait.includes(id)), manifest.filter((id) => !portraitSlots.has(id) && landscape.includes(id)), name);
  }
});

/**
 * A config shaped like a real one, as a portrait device sees it: most items
 * carry a landscape file no portrait device shows, and the cartridge also
 * delivers backings and a file no item names.
 */
function portraitOnlyShow() {
  const file = (id, orientation) => `
    INSERT INTO media_file VALUES (${id}, 'image/png', 'PNG', 1080, 1920, '${orientation}', 0.5625, NULL, 0, 0);
    INSERT INTO media_manifest VALUES (${id}, 'file-${id}.png', 'sha256:${String(id).padStart(64, "0")}', 1024, 'image/png');`;
  return variant("board", `
    -- item 3 becomes landscape-only, its portrait file gone from the cartridge
    UPDATE media_item SET portrait_file_id = NULL WHERE id = 3;
    DELETE FROM media_manifest WHERE media_file_id = 103;
    DELETE FROM media_file_variant WHERE media_file_id = 103;
    DELETE FROM media_file WHERE id = 103;
    ${[150, 250, 270, 280, 999].map((id) => file(id, id < 200 ? "portrait" : "landscape")).join("")}
    INSERT INTO media_item VALUES (50, 'Project backing', 150, 250, NULL, 0, 0);
    INSERT INTO media_item VALUES (70, 'Board backing', NULL, 270, NULL, 0, 0);
    INSERT INTO media_item VALUES (80, 'Landscape art', NULL, 280, NULL, 0, 0);
    INSERT INTO media_item VALUES (81, 'The same art, placed in a portrait slot', 280, NULL, NULL, 0, 0);
    UPDATE project SET backing_item_id = 50;
    UPDATE session_set SET backing_item_id = 70 WHERE id = 1;`);
}

test("a portrait device: the landscape slot files stay behind; portrait backings and unnamed files come", async () => {
  const s = await loadCartridge(portraitOnlyShow());
  assert.deepEqual(s.warnings, []);
  assert.deepEqual([...s.manifest.keys()].sort((a, b) => a - b), [101, 150, 201, 203, 250, 270, 280, 999]);
  // 201 and 203 are the rotation's landscape files, 250 the backing's, 270 the board backing's.
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [101, 150, 280, 999]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [201, 203, 250, 270, 280, 999]);
  // No DemoStation lane: `demo` changes nothing.
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"], demo: true })), [101, 150, 280, 999]);
});

test("demo: while the demo_station slot has an entry with a background, the opposite lane comes too — the picture-in-picture plays the same playlist in it", async () => {
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

test("the demo-station fixture: a DemoStation fetches both lanes and the branding; a Surface without the mode neither the opposite lane nor the branding", async () => {
  // Items 1, 2, 4 have both files; 3 is portrait-only; 8 and 9 are the demo's overlay and
  // background, in no playlist.
  const s = await loadCartridge(fixture("demo-station"));
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"], demo: true })), [101, 102, 103, 104, 108, 109, 201, 202, 204, 208, 209]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"], demo: true })), [101, 102, 103, 104, 108, 109, 201, 202, 204, 208, 209]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [101, 102, 103, 104]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"], demo: false })), [101, 102, 103, 104]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [201, 202, 204]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape", "portrait"] })), [101, 102, 103, 104, 201, 202, 204]);
});

test("an item used as demo branding and any other way too keeps its lanes on a Surface without the mode", async () => {
  // Item 9, the demo's background (109 / 209), put to one more use each time; item 8, the
  // overlay (108 / 208), stays branding only.
  const room = (backing, logo, template = "NULL") => `INSERT INTO session_set VALUES (1, 'Room', 8, ${backing}, ${logo}, NULL, NULL, ${template}, NULL, 0, 0)`;
  const uses = {
    "a playlist entry's item": "INSERT INTO playlist_entry VALUES (5, 1, 5, 'media_item', 9, NULL, NULL, NULL, NULL, NULL, 0, 0)",
    "the project's backing": "UPDATE project SET backing_item_id = 9",
    "the show wallpaper": "UPDATE project SET show_wallpaper_item_id = 9",
    "the desktop wallpaper": "UPDATE project SET desktop_wallpaper_item_id = 9",
    "a session set's backing": room(9, "NULL"),
    "a session set's logo": room("NULL", 9),
  };
  for (const [use, sql] of Object.entries(uses)) {
    const s = await loadCartridge(variant("demo-station", sql));
    assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [101, 102, 103, 104, 109], use);
    assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [201, 202, 204, 209], use);
    assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"], demo: true })), [101, 102, 103, 104, 108, 109, 201, 202, 204, 208, 209], use);
  }
  // A template is wanted on every lane (§5.15), whatever else names it.
  const template = {
    "the project's template": "UPDATE project SET template_item_id = 9",
    "a session set's template": room("NULL", "NULL", 9),
  };
  for (const [use, sql] of Object.entries(template)) {
    const s = await loadCartridge(variant("demo-station", sql));
    assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [101, 102, 103, 104, 109, 209], use);
    assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [109, 201, 202, 204, 209], use);
  }
});

test("a file of demo branding that another item names is judged by that item's slot", async () => {
  // The overlay (item 8) now holds 201 in its portrait slot — item 1's landscape file — and
  // 102 in its landscape slot — item 2's portrait file.
  const s = await loadCartridge(variant("demo-station", `
    UPDATE media_item SET portrait_file_id = 201, landscape_file_id = 102 WHERE id = 8;
    DELETE FROM media_manifest WHERE media_file_id IN (108, 208);
    DELETE FROM media_file_variant WHERE media_file_id IN (108, 208);
    DELETE FROM media_file WHERE id IN (108, 208)`));
  assert.deepEqual(s.warnings, []);
  // Without the mode the overlay's slots count for nothing: 201 serves the landscape lane
  // through item 1, 102 the portrait lane through item 2.
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [101, 102, 103, 104]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [201, 202, 204]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"], demo: true })), [101, 102, 103, 104, 109, 201, 202, 204, 209]);
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

test("a session board template is wanted on every lane (§5.15): the project's and a set's, whichever slot holds the package", async () => {
  // template.db: items 50 (the Show's template) and 51 (set 1's) hold a package in the portrait
  // slot only — files 150 and 151 — and are in no playlist. The board show otherwise: items 1, 3.
  const s = await loadCartridge(fixture("template"));
  assert.equal(s.project.templateItemId, 50);
  assert.equal(s.sessionSets.get(1).templateItemId, 51);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["portrait"] })), [101, 103, 150, 151]);
  assert.deepEqual(ids(filesForLanes(s, { lanes: ["landscape"] })), [150, 151, 201, 203], "a landscape device gets the packages too");
  assert.deepEqual(ids(filesForLanes(s, { lanes: [] })), [150, 151], "whatever the lanes");
  // A package is never playable, so it never widens a lane as content would.
  assert.equal(s.mediaFiles.get(150).contentType, "application/zip");
});
