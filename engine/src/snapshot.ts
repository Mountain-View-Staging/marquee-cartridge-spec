/**
 * Building the Snapshot from decoded rows: the records, and the indexes the
 * engine needs so that nothing on the render path searches a table.
 *
 * Rows arrive keyed by wire column name, with every value already checked
 * against its column's type (loader.ts). Anything an authoring tool produces
 * in the same shape can be turned into a Snapshot here too.
 *
 * Indexes (built once):
 *   days                   sorted by (startTime, id)
 *   scheduleBySlot         per lane, sorted by (timestamp, id)
 *   playlists[].entries    sorted by (position, id)
 *   directives             per entry, per type, sorted by (timestamp, id)
 *   sessionSetEntries      per set, sorted by (startTime, id)
 *
 * Ties are broken by id everywhere, so two engines reading one cartridge make
 * the same choice when two rows share a timestamp or a position.
 */

import { CartridgeError } from "./errors.js";
import type {
  CartridgeKind,
  CartridgeMeta,
  Directive,
  DirectiveType,
  EntryDirectives,
  LoadWarning,
  ManifestEntry,
  MediaFile,
  MediaFileVariant,
  MediaItem,
  Orientation,
  Playlist,
  PlaylistEntry,
  Project,
  ProjectDay,
  ProjectSnapshot,
  ResourceType,
  Session,
  SessionSet,
  SessionSetEntry,
  Slot,
  Snapshot,
  SurfaceConfig,
  SurfaceLocation,
  SurfaceScheduleEntry,
  VariantKind,
} from "./model.js";
import { KNOWN } from "./schema.js";
import { isValidTimeZone } from "./venue-time.js";

/** A row whose values have been checked against their columns' types. */
export type DecodedRow = Record<string, number | string | boolean | null>;
export type RawTables = Readonly<Record<string, readonly DecodedRow[]>>;

/** Session board page length when a set's duration is unusable (the column's default). */
const DEFAULT_PAGE_SECONDS = 8;
/** JSON columns larger than this are treated as malformed (untrusted input). */
const MAX_JSON_CHARS = 65_536;

export function buildSnapshot(kind: "surface", raw: RawTables, warnings: LoadWarning[]): Snapshot;
export function buildSnapshot(kind: "project", raw: RawTables, warnings: LoadWarning[]): ProjectSnapshot;
export function buildSnapshot(kind: CartridgeKind, raw: RawTables, warnings: LoadWarning[]): Snapshot | ProjectSnapshot;
export function buildSnapshot(kind: CartridgeKind, raw: RawTables, warnings: LoadWarning[]): Snapshot | ProjectSnapshot {
  const warn = (w: LoadWarning): void => {
    warnings.push(Object.freeze(w));
  };
  const rows = (table: string): readonly DecodedRow[] => raw[table] ?? [];

  // ── shared by both artifacts ──────────────────────────────────────────────
  const metaRow = rows("cartridge_meta")[0];
  if (!metaRow) throw new CartridgeError("meta_invalid", "cartridge_meta has no row", { table: "cartridge_meta" });
  const meta: CartridgeMeta = Object.freeze({
    cartridgeKind: str(metaRow, "cartridge_kind") as CartridgeKind,
    formatVersion: str(metaRow, "format_version"),
    projectCode: str(metaRow, "project_code"),
    surfaceId: strOrNull(metaRow, "surface_id"),
    publishedRevision: num(metaRow, "published_revision"),
    timezone: str(metaRow, "timezone"),
    generatedAt: num(metaRow, "generated_at"),
  });
  if (!isValidTimeZone(meta.timezone)) {
    warn({
      code: "timezone.invalid",
      table: "cartridge_meta",
      column: "timezone",
      message: `timezone '${meta.timezone}' is not an IANA zone this runtime knows; the show clock runs on real time`,
    });
  }

  const projectRows = rows("project");
  if (projectRows.length !== 1) {
    throw new CartridgeError("structure_invalid", `the project table has ${projectRows.length} rows; a cartridge has exactly one`, { table: "project" });
  }
  const p = projectRows[0]!;
  const project: Project = Object.freeze({
    id: num(p, "id"),
    cloudUid: str(p, "cloud_uid"),
    name: str(p, "name"),
    projectCode: str(p, "project_code"),
    timezone: str(p, "timezone"),
    showWallpaperItemId: numOrNull(p, "show_wallpaper_item_id"),
    desktopWallpaperItemId: numOrNull(p, "desktop_wallpaper_item_id"),
    backingItemId: numOrNull(p, "backing_item_id"),
    brandStyle: strOrNull(p, "brand_style"),
    brandStyleItemId: numOrNull(p, "brand_style_item_id"),
  });

  const days: ProjectDay[] = rows("project_days").map((r) =>
    Object.freeze({ id: num(r, "id"), day: str(r, "day"), startTime: num(r, "start_time"), endTime: num(r, "end_time") }),
  );
  days.sort((a, b) => a.startTime - b.startTime || a.id - b.id);
  if (days.length === 0) {
    warn({ code: "days.empty", table: "project_days", message: "the cartridge has no show days; the show clock runs on real time" });
  }

  const mediaFiles = new Map<number, MediaFile>();
  for (const r of rows("media_file")) {
    mediaFiles.set(num(r, "id"), Object.freeze({
      id: num(r, "id"),
      contentType: str(r, "content_type"),
      codec: strOrNull(r, "codec"),
      width: numOrNull(r, "width"),
      height: numOrNull(r, "height"),
      orientation: strOrNull(r, "orientation"),
      aspectRatio: numOrNull(r, "aspect_ratio"),
      intrinsicDuration: numOrNull(r, "intrinsic_duration"),
    }));
  }

  const mediaItems = new Map<number, MediaItem>();
  for (const r of rows("media_item")) {
    const item: MediaItem = Object.freeze({
      id: num(r, "id"),
      name: str(r, "name"),
      portraitFileId: numOrNull(r, "portrait_file_id"),
      landscapeFileId: numOrNull(r, "landscape_file_id"),
      displayDuration: numOrNull(r, "display_duration"),
      brandMember: strOrNull(r, "brand_member"),
    });
    for (const [column, fileId] of [["portrait_file_id", item.portraitFileId], ["landscape_file_id", item.landscapeFileId]] as const) {
      if (fileId !== null && !mediaFiles.has(fileId)) {
        warn({ code: "reference.dangling", table: "media_item", column, rowId: item.id, message: `media_item ${item.id} names media_file ${fileId}, which the cartridge does not carry` });
      }
    }
    mediaItems.set(item.id, item);
  }

  const manifest = new Map<number, ManifestEntry>();
  for (const r of rows("media_manifest")) {
    const m: ManifestEntry = Object.freeze({
      mediaFileId: num(r, "media_file_id"),
      deliverableFileName: str(r, "deliverable_file_name"),
      contentHash: str(r, "content_hash"),
      fileSize: num(r, "file_size"),
      contentType: str(r, "content_type"),
    });
    if (!mediaFiles.has(m.mediaFileId)) {
      warn({ code: "reference.dangling", table: "media_manifest", rowId: m.mediaFileId, message: `media_manifest lists media_file ${m.mediaFileId}, which the cartridge does not carry` });
    }
    manifest.set(m.mediaFileId, m);
  }

  const variantLists = new Map<number, MediaFileVariant[]>();
  for (const r of rows("media_file_variant")) {
    const kindValue = str(r, "kind");
    if (!KNOWN.variantKind.has(kindValue)) {
      warn({ code: "value.unknown", table: "media_file_variant", column: "kind", rowId: num(r, "id"), message: `rendition ${num(r, "id")} has kind '${kindValue}', which this engine does not know; ignored` });
      continue;
    }
    const v: MediaFileVariant = Object.freeze({
      id: num(r, "id"),
      mediaFileId: num(r, "media_file_id"),
      kind: kindValue as VariantKind,
      fileName: str(r, "file_name"),
      contentType: str(r, "content_type"),
      codec: strOrNull(r, "codec"),
      width: numOrNull(r, "width"),
      height: numOrNull(r, "height"),
      fileSize: num(r, "file_size"),
      contentHash: str(r, "content_hash"),
    });
    const list = variantLists.get(v.mediaFileId);
    if (list) list.push(v);
    else variantLists.set(v.mediaFileId, [v]);
  }
  const variants = new Map<number, readonly MediaFileVariant[]>();
  for (const [fileId, list] of variantLists) variants.set(fileId, Object.freeze(list.sort((a, b) => a.id - b.id)));

  const base = {
    meta,
    project,
    days: Object.freeze(days),
    mediaItems: mediaItems as ReadonlyMap<number, MediaItem>,
    mediaFiles: mediaFiles as ReadonlyMap<number, MediaFile>,
    manifest: manifest as ReadonlyMap<number, ManifestEntry>,
    variants: variants as ReadonlyMap<number, readonly MediaFileVariant[]>,
  };

  if (kind === "project") {
    return Object.freeze({ kind: "project", ...base, warnings: Object.freeze(warnings) }) as ProjectSnapshot;
  }

  // ── the surface cartridge ─────────────────────────────────────────────────
  const configRows = rows("surface_config");
  if (configRows.length !== 1) {
    throw new CartridgeError("structure_invalid", `the surface_config table has ${configRows.length} rows; a surface cartridge has exactly one`, { table: "surface_config" });
  }
  const c = configRows[0]!;
  const surfaceConfig: SurfaceConfig = Object.freeze({
    id: num(c, "id"),
    name: str(c, "name"),
    surfaceId: str(c, "surface_id"),
    publishedRevision: num(c, "published_revision"),
    publishedAt: num(c, "published_at"),
  });

  const locations: SurfaceLocation[] = [];
  for (const r of rows("surface_location")) {
    const id = num(r, "id");
    const orientation = str(r, "orientation");
    if (!KNOWN.orientation.has(orientation)) {
      warn({ code: "value.unknown", table: "surface_location", column: "orientation", rowId: id, message: `location ${id} has orientation '${orientation}'; ignored` });
      continue;
    }
    locations.push(Object.freeze({
      id,
      configId: num(r, "config_id"),
      locationId: str(r, "location_id"),
      orientation: orientation as Orientation,
      label: strOrNull(r, "label"),
    }));
  }
  locations.sort((a, b) => a.id - b.id);
  if (locations.length === 0) {
    warn({ code: "locations.empty", table: "surface_location", message: "the cartridge lists no installation; a host must supply the orientation itself" });
  }

  const playlistRows = rows("playlist");
  const lanes: Record<Slot, SurfaceScheduleEntry[]> = { portrait: [], landscape: [], demo_station: [] };
  for (const r of rows("surface_schedule_entry")) {
    const id = num(r, "id");
    const slot = str(r, "slot");
    if (!KNOWN.slot.has(slot)) {
      warn({ code: "value.unknown", table: "surface_schedule_entry", column: "slot", rowId: id, message: `schedule entry ${id} is on slot '${slot}', which this engine does not know; ignored` });
      continue;
    }
    const entry: SurfaceScheduleEntry = Object.freeze({
      id,
      configId: num(r, "config_id"),
      slot: slot as Slot,
      timestamp: num(r, "timestamp"),
      playlistId: numOrNull(r, "playlist_id"),
      backgroundItemId: numOrNull(r, "background_item_id"),
      overlayItemId: numOrNull(r, "overlay_item_id"),
    });
    if (entry.configId !== surfaceConfig.id) {
      warn({ code: "reference.dangling", table: "surface_schedule_entry", rowId: id, message: `schedule entry ${id} belongs to surface_config ${entry.configId}, not this cartridge's ${surfaceConfig.id}; ignored` });
      continue;
    }
    lanes[entry.slot].push(entry);
  }
  for (const lane of Object.values(lanes)) lane.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);

  const sessions = new Map<number, Session>();
  for (const r of rows("session")) {
    const id = num(r, "id");
    sessions.set(id, Object.freeze({
      id,
      name: str(r, "name"),
      abstract: strOrNull(r, "abstract"),
      presenters: jsonArray(r, "session", "presenters", id, warn),
      attributes: jsonArray(r, "session", "attributes", id, warn),
      sourceId: strOrNull(r, "source_id"),
      sourceType: strOrNull(r, "source_type"),
      sourceName: strOrNull(r, "source_name"),
    }));
  }

  const sessionSets = new Map<number, SessionSet>();
  for (const r of rows("session_set")) {
    const id = num(r, "id");
    let duration = num(r, "duration");
    if (!(duration > 0)) {
      warn({ code: "value.malformed", table: "session_set", column: "duration", rowId: id, message: `session set ${id} has a page duration of ${duration} s; using ${DEFAULT_PAGE_SECONDS} s` });
      duration = DEFAULT_PAGE_SECONDS;
    }
    sessionSets.set(id, Object.freeze({
      id,
      name: str(r, "name"),
      renderModes: renderModes(r, id, warn),
      duration,
      backingItemId: numOrNull(r, "backing_item_id"),
      logoItemId: numOrNull(r, "logo_item_id"),
      scheduleTemplate: jsonValue(r, "session_set", "schedule_template", id, warn),
      sourceId: strOrNull(r, "source_id"),
      sourceName: strOrNull(r, "source_name"),
      brandStyle: strOrNull(r, "brand_style"),
      brandStyleItemId: numOrNull(r, "brand_style_item_id"),
    }));
  }

  const setEntryLists = new Map<number, SessionSetEntry[]>();
  for (const r of rows("session_set_entry")) {
    const e: SessionSetEntry = Object.freeze({
      id: num(r, "id"),
      sessionSetId: num(r, "session_set_id"),
      sessionId: num(r, "session_id"),
      sessionTimeId: strOrNull(r, "session_time_id"),
      startTime: num(r, "start_time"),
      endTime: num(r, "end_time"),
      sourceRoomId: strOrNull(r, "source_room_id"),
      roomName: strOrNull(r, "room_name"),
    });
    if (!sessionSets.has(e.sessionSetId)) {
      warn({ code: "reference.dangling", table: "session_set_entry", rowId: e.id, message: `session_set_entry ${e.id} names session set ${e.sessionSetId}, which the cartridge does not carry; ignored` });
      continue;
    }
    if (!sessions.has(e.sessionId)) {
      warn({ code: "reference.dangling", table: "session_set_entry", rowId: e.id, message: `session_set_entry ${e.id} names session ${e.sessionId}, which the cartridge does not carry` });
    }
    const list = setEntryLists.get(e.sessionSetId);
    if (list) list.push(e);
    else setEntryLists.set(e.sessionSetId, [e]);
  }
  const sessionSetEntries = new Map<number, readonly SessionSetEntry[]>();
  for (const [setId, list] of setEntryLists) {
    sessionSetEntries.set(setId, Object.freeze(list.sort((a, b) => a.startTime - b.startTime || a.id - b.id)));
  }

  const playlistNames = new Map<number, string>();
  for (const r of playlistRows) playlistNames.set(num(r, "id"), str(r, "name"));
  const entryLists = new Map<number, PlaylistEntry[]>();
  for (const id of playlistNames.keys()) entryLists.set(id, []);
  const entryIds = new Set<number>();
  for (const r of rows("playlist_entry")) {
    const id = num(r, "id");
    const resourceType = str(r, "resource_type");
    if (!KNOWN.resourceType.has(resourceType)) {
      warn({ code: "value.unknown", table: "playlist_entry", column: "resource_type", rowId: id, message: `entry ${id} has resource_type '${resourceType}', which this engine does not know; it never plays` });
      continue;
    }
    const entry: PlaylistEntry = Object.freeze({
      id,
      playlistId: num(r, "playlist_id"),
      position: num(r, "position"),
      resourceType: resourceType as ResourceType,
      mediaItemId: numOrNull(r, "media_item_id"),
      sessionSetId: numOrNull(r, "session_set_id"),
      startTimePortrait: numOrNull(r, "start_time_portrait"),
      endTimePortrait: numOrNull(r, "end_time_portrait"),
      startTimeLandscape: numOrNull(r, "start_time_landscape"),
      endTimeLandscape: numOrNull(r, "end_time_landscape"),
    });
    const list = entryLists.get(entry.playlistId);
    if (!list) {
      warn({ code: "reference.dangling", table: "playlist_entry", rowId: id, message: `entry ${id} names playlist ${entry.playlistId}, which the cartridge does not carry; ignored` });
      continue;
    }
    if (entry.resourceType === "media_item" && (entry.mediaItemId === null || !mediaItems.has(entry.mediaItemId))) {
      warn({ code: "reference.dangling", table: "playlist_entry", column: "media_item_id", rowId: id, message: `entry ${id} names media item ${entry.mediaItemId}, which the cartridge does not carry; it never plays` });
    }
    if (entry.resourceType === "session_set" && (entry.sessionSetId === null || !sessionSets.has(entry.sessionSetId))) {
      warn({ code: "reference.dangling", table: "playlist_entry", column: "session_set_id", rowId: id, message: `entry ${id} names session set ${entry.sessionSetId}, which the cartridge does not carry; it never plays` });
    }
    list.push(entry);
    entryIds.add(id);
  }
  const playlists = new Map<number, Playlist>();
  for (const [id, list] of entryLists) {
    list.sort((a, b) => a.position - b.position || a.id - b.id);
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.position === list[i - 1]!.position) {
        warn({ code: "position.duplicate", table: "playlist_entry", column: "position", rowId: list[i]!.id, message: `playlist ${id} has two entries at position ${list[i]!.position} (${list[i - 1]!.id} and ${list[i]!.id}); they rotate in id order` });
      }
    }
    playlists.set(id, Object.freeze({ id, name: playlistNames.get(id)!, entries: Object.freeze(list) }));
  }

  for (const lane of Object.values(lanes)) {
    for (const s of lane) {
      if (s.playlistId !== null && !playlists.has(s.playlistId)) {
        warn({ code: "reference.dangling", table: "surface_schedule_entry", column: "playlist_id", rowId: s.id, message: `schedule entry ${s.id} names playlist ${s.playlistId}, which the cartridge does not carry` });
      }
    }
  }

  const directiveLists = new Map<number, { standard: Directive[]; takeover: Directive[] }>();
  for (const r of rows("directive")) {
    const id = num(r, "id");
    const type = str(r, "type");
    if (!KNOWN.directiveType.has(type)) {
      warn({ code: "value.unknown", table: "directive", column: "type", rowId: id, message: `directive ${id} has type '${type}', which this engine does not know; ignored` });
      continue;
    }
    const d: Directive = Object.freeze({
      id,
      entryId: num(r, "entry_id"),
      type: type as DirectiveType,
      timestamp: num(r, "timestamp"),
      onScreen: bool(r, "on_screen"),
    });
    if (!entryIds.has(d.entryId)) {
      warn({ code: "reference.dangling", table: "directive", rowId: id, message: `directive ${id} names entry ${d.entryId}, which the cartridge does not carry; ignored` });
      continue;
    }
    let lists = directiveLists.get(d.entryId);
    if (!lists) directiveLists.set(d.entryId, (lists = { standard: [], takeover: [] }));
    lists[d.type].push(d);
  }
  const directives = new Map<number, EntryDirectives>();
  const byTime = (a: Directive, b: Directive): number => a.timestamp - b.timestamp || a.id - b.id;
  for (const [entryId, lists] of directiveLists) {
    directives.set(entryId, Object.freeze({
      standard: Object.freeze(lists.standard.sort(byTime)),
      takeover: Object.freeze(lists.takeover.sort(byTime)),
    }));
  }

  const backing = project.backingItemId;
  if (backing !== null && !mediaItems.has(backing)) {
    warn({ code: "reference.dangling", table: "project", column: "backing_item_id", rowId: project.id, message: `the project's backing names media item ${backing}, which the cartridge does not carry; no backing` });
  }

  const snapshot: Snapshot = {
    kind: "surface",
    ...base,
    surfaceConfig,
    locations: Object.freeze(locations),
    scheduleBySlot: Object.freeze({
      portrait: Object.freeze(lanes.portrait),
      landscape: Object.freeze(lanes.landscape),
      demo_station: Object.freeze(lanes.demo_station),
    }),
    playlists,
    directives,
    sessionSets,
    sessionSetEntries,
    sessions,
    warnings: Object.freeze(warnings),
  };
  return Object.freeze(snapshot);
}

// ── typed access to decoded rows ────────────────────────────────────────────────

function num(r: DecodedRow, column: string): number {
  return r[column] as number;
}
function numOrNull(r: DecodedRow, column: string): number | null {
  return (r[column] ?? null) as number | null;
}
function str(r: DecodedRow, column: string): string {
  return r[column] as string;
}
function strOrNull(r: DecodedRow, column: string): string | null {
  return (r[column] ?? null) as string | null;
}
function bool(r: DecodedRow, column: string): boolean {
  return r[column] === true;
}

// ── defensive JSON (§ security: cartridges are untrusted input) ─────────────────

type Warn = (w: LoadWarning) => void;

function parseJson(text: string, table: string, column: string, rowId: number, warn: Warn): { ok: boolean; value: unknown } {
  if (text.length > MAX_JSON_CHARS) {
    warn({ code: "value.malformed", table, column, rowId, message: `${table} ${rowId}: ${column} is ${text.length} characters, over the ${MAX_JSON_CHARS} limit; ignored` });
    return { ok: false, value: null };
  }
  try {
    return { ok: true, value: deepFreeze(JSON.parse(text)) };
  } catch {
    warn({ code: "value.malformed", table, column, rowId, message: `${table} ${rowId}: ${column} is not valid JSON; ignored` });
    return { ok: false, value: null };
  }
}

function jsonArray(r: DecodedRow, table: string, column: string, rowId: number, warn: Warn): readonly unknown[] {
  const text = strOrNull(r, column);
  if (text === null) return EMPTY;
  const parsed = parseJson(text, table, column, rowId, warn);
  if (!parsed.ok) return EMPTY;
  if (Array.isArray(parsed.value)) return parsed.value;
  warn({ code: "value.malformed", table, column, rowId, message: `${table} ${rowId}: ${column} is not a JSON array; ignored` });
  return EMPTY;
}

function jsonValue(r: DecodedRow, table: string, column: string, rowId: number, warn: Warn): unknown {
  const text = strOrNull(r, column);
  if (text === null) return null;
  return parseJson(text, table, column, rowId, warn).value;
}

function renderModes(r: DecodedRow, rowId: number, warn: Warn): readonly string[] {
  const parsed = parseJson(str(r, "render_modes"), "session_set", "render_modes", rowId, warn);
  if (parsed.ok && Array.isArray(parsed.value) && parsed.value.every((m) => typeof m === "string")) {
    return parsed.value as readonly string[];
  }
  if (parsed.ok) {
    warn({ code: "value.malformed", table: "session_set", column: "render_modes", rowId, message: `session set ${rowId}: render_modes is not a JSON array of names; using ["simple"]` });
  }
  return DEFAULT_RENDER_MODES;
}

const EMPTY: readonly unknown[] = Object.freeze([]);
const DEFAULT_RENDER_MODES: readonly string[] = Object.freeze(["simple"]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
