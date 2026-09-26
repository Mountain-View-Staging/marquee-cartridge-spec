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
import type { CartridgeKind, LoadWarning, ProjectSnapshot, Snapshot } from "./model.js";
/** A row whose values have been checked against their columns' types. */
export type DecodedRow = Record<string, number | string | boolean | null>;
export type RawTables = Readonly<Record<string, readonly DecodedRow[]>>;
export declare function buildSnapshot(kind: "surface", raw: RawTables, warnings: LoadWarning[]): Snapshot;
export declare function buildSnapshot(kind: "project", raw: RawTables, warnings: LoadWarning[]): ProjectSnapshot;
export declare function buildSnapshot(kind: CartridgeKind, raw: RawTables, warnings: LoadWarning[]): Snapshot | ProjectSnapshot;
