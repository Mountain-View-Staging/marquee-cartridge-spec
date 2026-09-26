/**
 * The Marquee Surface engine — v25.0.1.
 *
 * The Loader turns a delivered cartridge into an immutable, indexed Snapshot;
 * the engine turns a Snapshot and the passage of time into what is on
 * screen, when it changes, and why. No runtime dependencies. This entry runs
 * in any modern JavaScript environment; `node.js` beside it adds a
 * node:sqlite binding for Node.
 *
 *   import { loadCartridge, sqlJsOpener, createEngine, surfaceClock } from "./dist/index.js";
 *
 *   const snapshot = await loadCartridge(bytes, { open: sqlJsOpener(SQL) });
 *   const engine = createEngine({ snapshot, slot: "portrait", orientation: "portrait", clock: surfaceClock() });
 *   // every frame:
 *   const { renderItem, trace } = engine.tick(Date.now(), performance.now());
 */
import { type LoadOptions } from "./loader.js";
import type { ProjectSnapshot, Snapshot } from "./model.js";
export type * from "./model.js";
export type { Backing, BlankRenderItem, BoardContent, BoardRenderItem, Hint, MediaContent, MediaRenderItem, PlayableRenderItem, RenderItem } from "./render.js";
export type * from "./trace.js";
export { CartridgeError, type CartridgeErrorCode } from "./errors.js";
export { isSqlite, loadCartridgeWith, readCartridge, type DatabaseAdapter, type LoadOptions, type Opener } from "./loader.js";
export { buildSnapshot, type DecodedRow, type RawTables } from "./snapshot.js";
export { BASELINE, FORMAT_MAJOR, type ColumnSpec, type ColumnType, type MalformedRowPolicy, type TableSpec } from "./schema.js";
export { sqlJsOpener, type SqlJsModule } from "./sqljs.js";
export { createEngine, SurfaceEngine, EMPTY_RETRY_MS, FIRST_FRAME_TIMEOUT_MS, JUMP_TOLERANCE_MS, type EngineOptions, type EntryInspection, type Inspection, type MarkerReason, type TickOutput, type WorkingSetKind, } from "./engine.js";
export { previewClock, surfaceClock, type PreviewClock, type ShowClock } from "./clock.js";
export { Calendar, DayOne, VenueZone, isValidTimeZone } from "./venue-time.js";
export { boardPageAt, minimalBoardResolver, type BoardContext, type BoardResolution, type BoardResolver, type MinimalBoardModel, type MinimalBoardSession, type SessionState, } from "./board.js";
export { DEFAULT_STILL_SECONDS, DirectiveSeries, WATCHDOG_GRACE_SECONDS, WATCHDOG_UNKNOWN_SECONDS, fileIdFor, isImageType, isPlayableType, isVideoType, playbackWindow, watchdogSeconds, type DirectiveState, type DurationSource, type PlaybackWindow, } from "./rules.js";
/**
 * The Loader (§8.5): verifies the SQLite magic, the artifact's kind and
 * format version, then decodes it into a Snapshot. Needs a SQLite binding:
 * pass `{ open: sqlJsOpener(SQL) }`, or use the Node entry, which brings
 * node:sqlite.
 */
export declare function loadCartridge(bytes: Uint8Array, options?: LoadOptions & {
    readonly kind?: "surface";
}): Promise<Snapshot>;
export declare function loadCartridge(bytes: Uint8Array, options: LoadOptions & {
    readonly kind: "project";
}): Promise<ProjectSnapshot>;
