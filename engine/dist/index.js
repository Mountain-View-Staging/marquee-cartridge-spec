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
import { CartridgeError } from "./errors.js";
import { loadCartridgeWith } from "./loader.js";
export { CartridgeError } from "./errors.js";
export { isSqlite, loadCartridgeWith, readCartridge } from "./loader.js";
export { buildSnapshot } from "./snapshot.js";
export { BASELINE, FORMAT_MAJOR } from "./schema.js";
export { sqlJsOpener } from "./sqljs.js";
export { createEngine, SurfaceEngine, EMPTY_RETRY_MS, FIRST_FRAME_TIMEOUT_MS, JUMP_TOLERANCE_MS, } from "./engine.js";
export { previewClock, surfaceClock } from "./clock.js";
export { Calendar, DayOne, VenueZone, isValidTimeZone } from "./venue-time.js";
export { boardPageAt, minimalBoardResolver, } from "./board.js";
export { DEFAULT_STILL_SECONDS, DirectiveSeries, WATCHDOG_GRACE_SECONDS, WATCHDOG_UNKNOWN_SECONDS, fileIdFor, isImageType, isPlayableType, isVideoType, playbackWindow, watchdogSeconds, } from "./rules.js";
export async function loadCartridge(bytes, options = {}) {
    if (!options.open) {
        throw new CartridgeError("no_sqlite_binding", "loadCartridge needs a SQLite binding: pass { open: sqlJsOpener(SQL) }, or import the Node entry (dist/node.js)");
    }
    return loadCartridgeWith(bytes, options.open, options.kind ?? "surface");
}
