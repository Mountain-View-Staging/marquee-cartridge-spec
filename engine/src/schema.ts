/**
 * The v25.0.1 baseline (specification §4), as the Loader checks it.
 *
 * Every baseline table and column is present in every v25 cartridge (§10), so
 * a missing one is a damaged or foreign file and the Loader refuses it. A
 * column added after the baseline would be declared here with `since` and a
 * default, and decoded as optional-with-default (§10.2). There are none yet.
 *
 * Column types:
 *   int    an INTEGER that must be a whole number
 *   real   a REAL that must be a finite number
 *   text   a TEXT
 *   bool   an INTEGER that must be 0 or 1
 *   a trailing `?` allows NULL
 *   `-`    present in the baseline but not read by the engine (checked for
 *          presence only; `created` and `updated` are authoring bookkeeping)
 */

export type ColumnType = "int" | "real" | "text" | "bool";

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
  /** False for presence-only columns. */
  readonly read: boolean;
  /** The format version that added the column; undefined for the baseline. */
  readonly since?: string;
  /** The value when a post-baseline column is absent. */
  readonly fallback?: unknown;
}

export interface TableSpec {
  readonly name: string;
  /** The column that names a row in an error, or null to use its ordinal. */
  readonly idColumn: string | null;
  /** The artifacts that carry this table (§3). */
  readonly in: readonly ("project" | "surface")[];
  readonly columns: readonly ColumnSpec[];
}

function col(name: string, type: string): ColumnSpec {
  if (type === "-") return { name, type: "int", nullable: false, read: false };
  const nullable = type.endsWith("?");
  return { name, type: (nullable ? type.slice(0, -1) : type) as ColumnType, nullable, read: true };
}

function table(
  name: string,
  idColumn: string | null,
  inArtifacts: readonly ("project" | "surface")[],
  columns: readonly [string, string][],
): TableSpec {
  return { name, idColumn, in: inArtifacts, columns: columns.map(([n, t]) => col(n, t)) };
}

const BOTH = ["project", "surface"] as const;
const SURFACE = ["surface"] as const;

export const BASELINE: readonly TableSpec[] = [
  table("cartridge_meta", null, BOTH, [
    ["cartridge_kind", "text"],
    ["format_version", "text"],
    ["project_code", "text"],
    ["surface_id", "text?"],
    ["published_revision", "int"],
    ["timezone", "text"],
    ["generated_at", "int"],
  ]),
  table("media_manifest", "media_file_id", BOTH, [
    ["media_file_id", "int"],
    ["deliverable_file_name", "text"],
    ["content_hash", "text"],
    ["file_size", "int"],
    ["content_type", "text"],
  ]),
  table("project", "id", BOTH, [
    ["id", "int"],
    ["cloud_uid", "text"],
    ["name", "text"],
    ["project_code", "text"],
    ["timezone", "text"],
    ["show_wallpaper_item_id", "int?"],
    ["desktop_wallpaper_item_id", "int?"],
    ["backing_item_id", "int?"],
    ["brand_style", "text?"],
    ["brand_style_item_id", "int?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("project_days", "id", BOTH, [
    ["id", "int"],
    ["day", "text"],
    ["start_time", "int"],
    ["end_time", "int"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("surface_config", "id", SURFACE, [
    ["id", "int"],
    ["name", "text"],
    ["surface_id", "text"],
    ["published_revision", "int"],
    ["published_at", "int"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("surface_location", "id", SURFACE, [
    ["id", "int"],
    ["config_id", "int"],
    ["location_id", "text"],
    ["orientation", "text"],
    ["label", "text?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("surface_schedule_entry", "id", SURFACE, [
    ["id", "int"],
    ["config_id", "int"],
    ["slot", "text"],
    ["timestamp", "int"],
    ["playlist_id", "int?"],
    ["background_item_id", "int?"],
    ["overlay_item_id", "int?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("playlist", "id", SURFACE, [
    ["id", "int"],
    ["name", "text"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("playlist_entry", "id", SURFACE, [
    ["id", "int"],
    ["playlist_id", "int"],
    ["position", "int"],
    ["resource_type", "text"],
    ["media_item_id", "int?"],
    ["session_set_id", "int?"],
    ["start_time_portrait", "real?"],
    ["end_time_portrait", "real?"],
    ["start_time_landscape", "real?"],
    ["end_time_landscape", "real?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("directive", "id", SURFACE, [
    ["id", "int"],
    ["entry_id", "int"],
    ["type", "text"],
    ["timestamp", "int"],
    ["on_screen", "bool"],
    ["timezone", "-"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("media_item", "id", BOTH, [
    ["id", "int"],
    ["name", "text"],
    ["portrait_file_id", "int?"],
    ["landscape_file_id", "int?"],
    ["display_duration", "real?"],
    ["brand_member", "text?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("media_file", "id", BOTH, [
    ["id", "int"],
    ["content_type", "text"],
    ["codec", "text?"],
    ["width", "int?"],
    ["height", "int?"],
    ["orientation", "text?"],
    ["aspect_ratio", "real?"],
    ["intrinsic_duration", "real?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("session", "id", SURFACE, [
    ["id", "int"],
    ["name", "text"],
    ["abstract", "text?"],
    ["presenters", "text?"],
    ["attributes", "text?"],
    ["source_id", "text?"],
    ["source_type", "text?"],
    ["source_name", "text?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("session_set", "id", SURFACE, [
    ["id", "int"],
    ["name", "text"],
    ["render_modes", "text"],
    ["duration", "real"],
    ["backing_item_id", "int?"],
    ["logo_item_id", "int?"],
    ["schedule_template", "text?"],
    ["source_id", "text?"],
    ["source_name", "text?"],
    ["brand_style", "text?"],
    ["brand_style_item_id", "int?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("session_set_entry", "id", SURFACE, [
    ["id", "int"],
    ["session_set_id", "int"],
    ["session_id", "int"],
    ["session_time_id", "text?"],
    ["start_time", "int"],
    ["end_time", "int"],
    ["source_room_id", "text?"],
    ["room_name", "text?"],
    ["created", "-"],
    ["updated", "-"],
  ]),
  table("media_file_variant", "id", BOTH, [
    ["id", "int"],
    ["media_file_id", "int"],
    ["kind", "text"],
    ["file_name", "text"],
    ["content_type", "text"],
    ["codec", "text?"],
    ["width", "int?"],
    ["height", "int?"],
    ["file_size", "int"],
    ["content_hash", "text"],
    ["created", "-"],
    ["updated", "-"],
  ]),
];

/** The major version this engine reads (§2.1). */
export const FORMAT_MAJOR = 25;

/** Known values of the enumerated columns (§10.4 says to skip anything else). */
export const KNOWN = {
  slot: new Set(["portrait", "landscape", "demo_station"]),
  orientation: new Set(["portrait", "landscape"]),
  resourceType: new Set(["media_item", "session_set"]),
  directiveType: new Set(["standard", "takeover"]),
  variantKind: new Set(["original", "optimized", "webOptimized", "wifiOptimized"]),
  cartridgeKind: new Set(["project", "surface"]),
} as const;
