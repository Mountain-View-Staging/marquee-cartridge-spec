/**
 * The v25.0.1 baseline (specification §4), as the Loader checks it.
 *
 * Every baseline table and column is present in every v25 cartridge (§10), so
 * a missing one is a damaged or foreign file and the Loader refuses it. A
 * column added after the baseline would be declared here with `since` and a
 * default, and decoded as optional-with-default (§10.2). There are none yet.
 *
 * A column an earlier draft of v25.0.1 carried and the format has since
 * dropped is listed in its table's `retired`: a cartridge that still carries
 * it loads, and the column is ignored without a warning (§10.4). There is one,
 * `surface_location.orientation` — a device's orientation is its own (§6).
 *
 * A value an earlier draft wrote and the format has retired is listed in
 * `RETIRED` below. Unlike a retired column it cannot be ignored — the row means
 * something the format no longer says — so the row is malformed: skipped with a
 * `value.malformed` warning naming the column (§4.4). There is no dual reading.
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
/**
 * What the Loader does with a malformed row — one holding a NUL byte (U+0000) in a
 * text column (§4): `skip` drops it with a `value.malformed` warning naming the
 * column, as a row with an unknown enumerated value is dropped (§10.4); a table that
 * must hold exactly one row refuses the cartridge with that table's own code.
 */
export type MalformedRowPolicy = "skip" | "meta_invalid" | "structure_invalid";
export interface TableSpec {
    readonly name: string;
    /** The column that names a row in an error, or null to use its ordinal. */
    readonly idColumn: string | null;
    /** The artifacts that carry this table (§3). */
    readonly in: readonly ("project" | "surface")[];
    readonly columns: readonly ColumnSpec[];
    readonly malformedRow: MalformedRowPolicy;
    /** Columns retired from the format: never read, never warned about when present. */
    readonly retired: readonly string[];
}
export declare const BASELINE: readonly TableSpec[];
/** The major version this engine reads (§2.1). */
export declare const FORMAT_MAJOR = 25;
/** Known values of the enumerated columns (§10.4 says to skip anything else). */
export declare const KNOWN: {
    readonly slot: Set<string>;
    readonly resourceType: Set<string>;
    readonly directiveType: Set<string>;
    readonly variantKind: Set<string>;
    readonly cartridgeKind: Set<string>;
};
/**
 * Values an earlier draft of v25.0.1 wrote and the format has retired (§4.4).
 * A row carrying one is malformed, not unknown: skipped with a `value.malformed`
 * warning naming the column.
 *
 *   slot  'portrait', 'landscape' — the draft scheduled playlists per
 *         orientation; a surface now has one playlist schedule (§5.1).
 */
export declare const RETIRED: {
    readonly slot: Set<string>;
};
