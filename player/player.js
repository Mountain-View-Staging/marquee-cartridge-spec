/**
 * marquee-player — the resolution core, in plain JavaScript.
 *
 * No framework, no build step, no dependencies. Nothing in this file touches
 * the DOM: it takes an open cartridge and a moment in time and returns what
 * should be on screen. `index.html` is the part that knows about pixels.
 *
 * That split is deliberate. This file is the part worth porting — every
 * function below is one section of the specification, and the whole thing is
 * ordinary synchronous code with no reactivity library, so it translates
 * directly into Kotlin, Swift, C++ or anything else.
 *
 * The only thing you need to bring is a SQLite binding.
 */

export const DEFAULT_IMAGE_SECONDS = 8;

// ── SQLite helpers ───────────────────────────────────────────────────────────

export const rows = (db, sql, params = []) => {
  const out = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
};

export const one = (db, sql, params = []) => rows(db, sql, params)[0] ?? null;

/**
 * §9.2 — read the columns that are ACTUALLY there.
 *
 * A cartridge published before a column existed simply lacks it. Code that
 * assumes otherwise throws on the whole table, the caller sees an empty list,
 * and the screen goes black with nothing in any log naming the cause.
 */
export const columnsOf = (db, table) =>
  new Set(rows(db, `PRAGMA table_info(${table})`).map((r) => r.name));

/**
 * §8.4 — a 200 is not proof. A captive portal answers one with an HTML login
 * page, and a zero-byte file is a *valid empty database*, so "it opened" proves
 * nothing either. Check the 16-byte magic before replacing good content.
 */
export function assertSqlite(bytes, label) {
  const MAGIC = "SQLite format 3\0";
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error(`${label} is not a SQLite database`);
  }
}

// ── §8.2 — synthetic time ────────────────────────────────────────────────────

/**
 * Outside the show window, project the viewer's wall-clock H:M:S onto Day 1 in
 * the venue's timezone, so a screen powered up early shows its opening state
 * instead of nothing. Clamp to the show's start if the projection still misses.
 *
 * This is a CLIENT behaviour, not a data rule — showing a "not started" screen
 * instead is equally valid. Doing neither leaves a blank display during setup,
 * which reads as a broken device.
 */
export function syntheticNow(real, days, timezone) {
  if (!days.length || !timezone) return { at: real, projected: false };
  const start = days[0].start_time;
  const end = days[days.length - 1].end_time;
  if (real >= start && real <= end) return { at: real, projected: false };

  const dayOne = new Date(start);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(dayOne);
  const clock = new Date(real);
  const hms = [clock.getHours(), clock.getMinutes(), clock.getSeconds()]
    .map((n) => String(n).padStart(2, "0")).join(":");
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, timeZoneName: "longOffset",
  }).formatToParts(dayOne).find((p) => p.type === "timeZoneName")
    ?.value.replace("GMT", "") || "+00:00";

  const projected = Date.parse(`${ymd}T${hms}${offset}`);
  const usable = Number.isFinite(projected) && projected >= start && projected <= end;
  return { at: usable ? projected : start, projected: true };
}

// ── §6 — provisioning ────────────────────────────────────────────────────────

/**
 * Pick this install's location and adopt its orientation.
 *
 * A real player persists the chosen `location_id` and prefers it on later runs
 * — but only while the cartridge still lists it, or a location deleted in
 * Studio pins the device to an orientation forever. It also forgets it whenever
 * the configured project or screen code changes.
 *
 * When there are NO locations, the cartridge cannot tell you which way the
 * screen is mounted. Falling back to a device default is correct, but say so:
 * a portrait default against a landscape-only schedule matches no slot and
 * renders nothing, while sync reports complete success (§6.1).
 */
export function provision(db, storedLocationId = null) {
  const locations = rows(db, "SELECT * FROM screen_location ORDER BY id");
  if (!locations.length) return { locationId: null, orientation: null, locations };
  const chosen = locations.find((l) => l.location_id === storedLocationId) ?? locations[0];
  return {
    locationId: chosen.location_id,
    orientation: chosen.orientation === "portrait" ? "portrait" : "landscape",
    locations,
  };
}

// ── §5 — resolution ──────────────────────────────────────────────────────────

/** §5.2 — within MY slot, the most recent entry whose timestamp <= now. */
export function scheduleEntryFor(db, configId, slot, at) {
  return one(db,
    `SELECT * FROM screen_schedule_entry
      WHERE config_id = ? AND slot = ? AND timestamp <= ?
      ORDER BY timestamp DESC LIMIT 1`, [configId, slot, at]);
}

/** The next boundary to wake for, across this slot AND the demo slot. */
export function nextBoundary(db, configId, slot, at) {
  return one(db,
    `SELECT MIN(timestamp) AS t FROM screen_schedule_entry
      WHERE config_id = ? AND slot IN (?, 'demo_station') AND timestamp > ?`,
    [configId, slot, at])?.t ?? null;
}

/**
 * §5.4 — the governing directive for one entry and one type.
 *
 * A directive is a STATE CHANGE, not a window: the latest one at or before now
 * wins. Scoping to the containing day is what stops yesterday's takeover
 * leaking into today, while letting any number of them within today form a
 * fluid priority set. Outside every day, the whole timeline participates.
 */
export function governingDirective(db, entryId, type, at, days) {
  const window = days.find((d) => at >= d.start_time && at <= d.end_time);
  const scoped = window
    ? `AND timestamp BETWEEN ${window.start_time} AND ${window.end_time}` : "";
  return one(db,
    `SELECT * FROM directive
      WHERE entry_id = ? AND type = ? AND timestamp <= ? ${scoped}
      ORDER BY timestamp DESC LIMIT 1`, [entryId, type, at]);
}

/** §5.6 — this orientation's file, falling back to the other. Never render nothing. */
export function resolveFile(db, item, slot) {
  const id = slot === "portrait"
    ? (item.portrait_file_id ?? item.landscape_file_id)
    : (item.landscape_file_id ?? item.portrait_file_id);
  return id ? one(db, "SELECT * FROM media_file WHERE id = ?", [id]) : null;
}

export const isVideo = (contentType) => /^video\//.test(contentType ?? "");
export const isImage = (contentType) => /^image\//.test(contentType ?? "");

/**
 * §5.3–5.5 — the working list.
 *
 * Returns both rotations, because which one is in force is worth reporting and
 * not only acting on. The rule: **a non-empty takeover set IS the rotation.**
 * Standard is suppressed wholesale — not appended, not interleaved. That is how
 * an operator cuts to emergency or sponsor content without editing a playlist.
 */
export function resolveRotation(db, playlistId, at, slot, days) {
  if (!playlistId) return { list: [], source: "none", suppressed: 0, skipped: [] };

  const columns = columnsOf(db, "playlist_entry");
  const entries = rows(db,
    "SELECT * FROM playlist_entry WHERE playlist_id = ? ORDER BY position", [playlistId]);

  const takeovers = [], standard = [], skipped = [];
  for (const entry of entries) {
    // v4-only column. Absent means the default, never an error.
    if (columns.has("disabled") && entry.disabled) { skipped.push([entry.id, "disabled"]); continue; }
    if (entry.resource_type !== "media_item") { skipped.push([entry.id, entry.resource_type]); continue; }

    const item = one(db, "SELECT * FROM media_item WHERE id = ?", [entry.media_item_id]);
    if (!item) { skipped.push([entry.id, "item missing"]); continue; }

    const file = resolveFile(db, item, slot);
    if (!file) { skipped.push([entry.id, "no file for either orientation"]); continue; }

    // This player handles images and video. Anything else is SKIPPED LOUDLY —
    // a silently dropped asset is an empty slot every rotation with nothing in
    // any log, which is the most expensive failure mode in the whole system.
    if (!isImage(file.content_type) && !isVideo(file.content_type)) {
      skipped.push([entry.id, `unplayable ${file.content_type}`]);
      continue;
    }

    const resolved = { entry, item, file };
    if (governingDirective(db, entry.id, "takeover", at, days)?.on_screen) takeovers.push(resolved);
    if (governingDirective(db, entry.id, "standard", at, days)?.on_screen) standard.push(resolved);
  }

  return takeovers.length
    ? { list: takeovers, source: "takeover", suppressed: standard.length, skipped }
    : { list: standard, source: "standard", suppressed: 0, skipped };
}

/**
 * §5.5 — advance by locating the last-rendered entry IN THE CURRENT LIST.
 *
 * Not by a stored index: the list is recomputed every tick and its composition
 * changes as directives turn on and off, so an index silently skips items.
 */
export function advance(list, cursorId) {
  if (!list.length) return null;
  const previous = list.findIndex((x) => x.entry.id === cursorId);
  return list[previous === -1 ? 0 : (previous + 1) % list.length];
}

// ── playback facts ───────────────────────────────────────────────────────────

/**
 * §4.6 — the deliverable is what the MANIFEST names.
 *
 * `media_file` also carries the pieces to derive it (`optimized_file_name ??
 * source_file_name`), but the publisher has already folded that in. Deriving it
 * again is a second implementation of one rule, and the two drift.
 */
export function deliverableName(db, file) {
  const manifest = one(db, "SELECT * FROM media_manifest WHERE media_file_id = ?", [file.id]);
  return manifest?.deliverable_file_name ?? file.source_file_name;
}

/**
 * §5.7 — WHERE an entry starts and HOW LONG it runs: the rule Studio's editor
 * resolves every entry with, so the player shows what the operator saw there
 * (each row's Start and running time).
 *
 *   start    — the entry's window start for this orientation, else 0
 *   duration — `end − start` when the window has an end (a still too: the end
 *              is its dwell override);
 *              a video with no end → 0, meaning "to the end of the clip";
 *              a still with no end → `media_item.display_duration`, else 8 s
 *
 * Both are seconds. `source` says which number was used, for the overlay.
 * A window counts only when it is positive (end > start): Studio refuses any
 * other, and a zero-length hold on a still would spin the rotation. A video
 * then plays to its end, which is what Studio's zero duration means there.
 * The Apple client follows the same rule from its 2026-09-23 build (macOS now,
 * iOS from its next release); older builds hold every still 8 s and play every
 * clip in full. The overlay names the number this player used.
 */
export function playbackWindow(entry, item, file, slot) {
  const num = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
  const portrait = slot === "portrait";
  const start = Math.max(0, num(portrait ? entry.start_time_portrait : entry.start_time_landscape) ?? 0);
  const end = num(portrait ? entry.end_time_portrait : entry.end_time_landscape);
  if (end !== null && end > start) return { start, duration: end - start, source: "window" };
  if (isVideo(file.content_type)) return { start, duration: 0, source: "clip" };
  const authored = num(item.display_duration);
  return authored !== null && authored > 0
    ? { start, duration: authored, source: "display_duration" }
    : { start, duration: DEFAULT_IMAGE_SECONDS, source: "default" };
}

// ── the whole chain, in one call ─────────────────────────────────────────────

/**
 * Resolve everything for a moment in time. One pure function: same cartridge,
 * same inputs, same answer — which is what makes it testable without a screen.
 */
export function resolve(db, { at, slot, cursorId = null }) {
  const config = one(db, "SELECT * FROM screen_config LIMIT 1");
  const days = rows(db, "SELECT * FROM project_days ORDER BY start_time");
  const scheduled = config ? scheduleEntryFor(db, config.id, slot, at) : null;
  const playlistId = scheduled?.playlist_id ?? null;
  const rotation = resolveRotation(db, playlistId, at, slot, days);
  const current = rotation.list.find((x) => x.entry.id === cursorId) ?? rotation.list[0] ?? null;

  return {
    at, slot, config, days, scheduled, playlistId, rotation, current,
    playlist: playlistId ? one(db, "SELECT * FROM playlist WHERE id = ?", [playlistId]) : null,
    nextBoundary: config ? nextBoundary(db, config.id, slot, at) : null,
  };
}

/**
 * A cheap identity for a resolved state, so a caller can tell "nothing changed"
 * from "repaint". The clock moves every second; almost none of those ticks
 * change what is on screen, and repainting anyway restarts video.
 */
export function signatureOf(state) {
  return [
    state.slot,
    state.playlistId ?? "none",
    state.rotation.source,
    state.current?.entry.id ?? "none",
    state.rotation.list.map((x) => x.entry.id).join(","),
  ].join("|");
}
