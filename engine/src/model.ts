/**
 * The Snapshot: the engine's own model of a v25.0.1 cartridge.
 *
 * A Snapshot is immutable and indexed. It is built once per committed
 * cartridge — by the Loader from SQLite bytes, or by an authoring tool from
 * its live data — and never touches a database afterwards, so nothing on the
 * render path waits on I/O (specification §5.13).
 *
 * Field names are the wire columns in camelCase. Section numbers refer to the
 * specification in this repository's README.
 */

export type Orientation = "portrait" | "landscape";
/** The schedule lanes (§4.4). `demo_station` is a mode lane, never a rotation. */
export type Slot = "portrait" | "landscape" | "demo_station";
export type DirectiveType = "standard" | "takeover";
export type ResourceType = "media_item" | "session_set";
export type CartridgeKind = "project" | "surface";
export type VariantKind = "original" | "optimized" | "webOptimized" | "wifiOptimized";

/** §4.1 — exactly one row in both artifacts. */
export interface CartridgeMeta {
  readonly cartridgeKind: CartridgeKind;
  readonly formatVersion: string;
  readonly projectCode: string;
  readonly surfaceId: string | null;
  readonly publishedRevision: number;
  /** The venue timezone: the single authority for every time decision (§8). */
  readonly timezone: string;
  readonly generatedAt: number;
}

/** §4.3 */
export interface Project {
  readonly id: number;
  readonly cloudUid: string;
  readonly name: string;
  readonly projectCode: string;
  readonly timezone: string;
  readonly showWallpaperItemId: number | null;
  readonly desktopWallpaperItemId: number | null;
  /** The default backing (§5.10). */
  readonly backingItemId: number | null;
  readonly brandStyle: string | null;
  readonly brandStyleItemId: number | null;
}

/** §4.3 — a whole venue-local calendar day. */
export interface ProjectDay {
  readonly id: number;
  readonly day: string;
  readonly startTime: number;
  readonly endTime: number;
}

/** §4.4 */
export interface SurfaceConfig {
  readonly id: number;
  readonly name: string;
  readonly surfaceId: string;
  readonly publishedRevision: number;
  readonly publishedAt: number;
}

/** §4.4 — one physical installation; carries the mount orientation. */
export interface SurfaceLocation {
  readonly id: number;
  readonly configId: number;
  readonly locationId: string;
  readonly orientation: Orientation;
  readonly label: string | null;
}

/** §4.4 — a changeover on one lane's timeline. */
export interface SurfaceScheduleEntry {
  readonly id: number;
  readonly configId: number;
  readonly slot: Slot;
  readonly timestamp: number;
  /** NULL on a playlist lane is an authored blank (§5.2). */
  readonly playlistId: number | null;
  readonly backgroundItemId: number | null;
  readonly overlayItemId: number | null;
}

/** §4.5 */
export interface PlaylistEntry {
  readonly id: number;
  readonly playlistId: number;
  readonly position: number;
  readonly resourceType: ResourceType;
  readonly mediaItemId: number | null;
  readonly sessionSetId: number | null;
  readonly startTimePortrait: number | null;
  readonly endTimePortrait: number | null;
  readonly startTimeLandscape: number | null;
  readonly endTimeLandscape: number | null;
}

/** §4.5 — entries sorted by (position, id). */
export interface Playlist {
  readonly id: number;
  readonly name: string;
  readonly entries: readonly PlaylistEntry[];
}

/** §4.5, §5.4 — a state change on one entry's timeline. */
export interface Directive {
  readonly id: number;
  readonly entryId: number;
  readonly type: DirectiveType;
  readonly timestamp: number;
  readonly onScreen: boolean;
}

/** One entry's directives, per type, sorted by (timestamp, id). */
export interface EntryDirectives {
  readonly standard: readonly Directive[];
  readonly takeover: readonly Directive[];
}

/** §4.6 — the orientation-independent thing Studio schedules. */
export interface MediaItem {
  readonly id: number;
  readonly name: string;
  readonly portraitFileId: number | null;
  readonly landscapeFileId: number | null;
  readonly displayDuration: number | null;
  readonly brandMember: string | null;
}

/** §4.6 — the imported asset. */
export interface MediaFile {
  readonly id: number;
  readonly contentType: string;
  readonly codec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly orientation: string | null;
  readonly aspectRatio: number | null;
  readonly intrinsicDuration: number | null;
}

/** §4.2 — the default deliverable of one media file. */
export interface ManifestEntry {
  readonly mediaFileId: number;
  readonly deliverableFileName: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly contentType: string;
}

/** §4.8 — one rendition offered for a media file. */
export interface MediaFileVariant {
  readonly id: number;
  readonly mediaFileId: number;
  readonly kind: VariantKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly codec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fileSize: number;
  readonly contentHash: string;
}

/** §4.7 */
export interface Session {
  readonly id: number;
  readonly name: string;
  readonly abstract: string | null;
  readonly presenters: readonly unknown[];
  readonly attributes: readonly unknown[];
  readonly sourceId: string | null;
  readonly sourceType: string | null;
  readonly sourceName: string | null;
}

/** §4.7 — a room's sessions, shown as a session board. */
export interface SessionSet {
  readonly id: number;
  readonly name: string;
  readonly renderModes: readonly string[];
  /** Seconds per board page. */
  readonly duration: number;
  readonly backingItemId: number | null;
  readonly logoItemId: number | null;
  readonly scheduleTemplate: unknown;
  readonly sourceId: string | null;
  readonly sourceName: string | null;
  readonly brandStyle: string | null;
  readonly brandStyleItemId: number | null;
}

/** §4.7 — sorted by (startTime, id) within a set. */
export interface SessionSetEntry {
  readonly id: number;
  readonly sessionSetId: number;
  readonly sessionId: number;
  readonly sessionTimeId: string | null;
  readonly startTime: number;
  readonly endTime: number;
  readonly sourceRoomId: string | null;
  readonly roomName: string | null;
}

/**
 * Something the Loader accepted but wants an operator to know about. A load
 * with warnings is a successful load; a load that cannot be trusted throws.
 */
export interface LoadWarning {
  readonly code: LoadWarningCode;
  readonly message: string;
  readonly table?: string;
  readonly column?: string;
  readonly rowId?: number;
}

export type LoadWarningCode =
  | "table.unknown"
  | "column.unknown"
  | "value.unknown"
  | "value.malformed"
  | "reference.dangling"
  | "position.duplicate"
  | "timezone.invalid"
  | "days.empty"
  | "locations.empty";

/** The schedule, per lane, sorted by (timestamp, id). */
export interface ScheduleBySlot {
  readonly portrait: readonly SurfaceScheduleEntry[];
  readonly landscape: readonly SurfaceScheduleEntry[];
  readonly demo_station: readonly SurfaceScheduleEntry[];
}

interface SnapshotBase {
  readonly meta: CartridgeMeta;
  readonly project: Project;
  /** Sorted by (startTime, id). */
  readonly days: readonly ProjectDay[];
  readonly mediaItems: ReadonlyMap<number, MediaItem>;
  readonly mediaFiles: ReadonlyMap<number, MediaFile>;
  /** By media file id. */
  readonly manifest: ReadonlyMap<number, ManifestEntry>;
  /** By media file id, sorted by id. Unknown kinds are dropped with a warning. */
  readonly variants: ReadonlyMap<number, readonly MediaFileVariant[]>;
  readonly warnings: readonly LoadWarning[];
}

/** `project.db` (§3.1): the Show's identity, days and wallpapers. */
export interface ProjectSnapshot extends SnapshotBase {
  readonly kind: "project";
}

/** `<SURFACECODE>.db` (§3.2): everything one surface config plays. */
export interface Snapshot extends SnapshotBase {
  readonly kind: "surface";
  readonly surfaceConfig: SurfaceConfig;
  readonly locations: readonly SurfaceLocation[];
  readonly scheduleBySlot: ScheduleBySlot;
  readonly playlists: ReadonlyMap<number, Playlist>;
  /** By playlist entry id. */
  readonly directives: ReadonlyMap<number, EntryDirectives>;
  readonly sessionSets: ReadonlyMap<number, SessionSet>;
  /** By session set id. */
  readonly sessionSetEntries: ReadonlyMap<number, readonly SessionSetEntry[]>;
  readonly sessions: ReadonlyMap<number, Session>;
}
