/**
 * The Loader: cartridge bytes → an immutable, indexed Snapshot, or a named
 * failure.
 *
 * It reads through a small database adapter, so the same rules run on sql.js
 * in a browser and on node:sqlite in Node. It runs once per committed
 * cartridge, never on the render path.
 *
 * What it refuses (a CartridgeError with a stable `code`):
 *   not_sqlite          the bytes do not start with the SQLite magic (§8.5)
 *   not_v25             no cartridge_meta table: a pre-v25 artifact
 *   format_unsupported  format_version's first component is not 25 (§2.1)
 *   kind_mismatch       a project cartridge where a surface one was expected, or the reverse
 *   meta_invalid        cartridge_meta is not exactly one well-formed row
 *   table_missing       a baseline table is absent
 *   column_missing      a baseline column is absent
 *   table_unreadable    a table exists but cannot be queried
 *   row_undecodable     a row holds a value its column cannot hold; the error
 *                       names the table and the row (§10.3: never let a read
 *                       failure look like an empty table)
 *   structure_invalid   a table that must have exactly one row does not
 *
 * What it accepts with a warning (§10.4): unknown tables, unknown columns, and
 * rows carrying an unknown enumerated value, which are skipped.
 */
import type { CartridgeKind, ProjectSnapshot, Snapshot } from "./model.js";
/** The one capability the Loader needs from a SQLite binding. */
export interface DatabaseAdapter {
    /** Every row of a read-only query, each an object keyed by column name. */
    all(sql: string): readonly Record<string, unknown>[];
    /** Release the database. */
    close?(): void;
}
/** Opens cartridge bytes with some SQLite binding. */
export type Opener = (bytes: Uint8Array) => DatabaseAdapter;
export interface LoadOptions {
    /** Which artifact is expected. Defaults to `surface`. */
    readonly kind?: CartridgeKind;
    /** The SQLite binding. Required in a browser; the Node entry supplies node:sqlite. */
    readonly open?: Opener;
}
/**
 * §8.5 — a 200 is not proof: a captive portal answers one with an HTML page,
 * and a zero-byte file is a valid empty database. Check the 16-byte magic.
 */
export declare function isSqlite(bytes: Uint8Array): boolean;
/** Opens `bytes` with `open` and reads them as a cartridge of the expected kind. */
export declare function loadCartridgeWith(bytes: Uint8Array, open: Opener, kind: "surface"): Snapshot;
export declare function loadCartridgeWith(bytes: Uint8Array, open: Opener, kind: "project"): ProjectSnapshot;
export declare function loadCartridgeWith(bytes: Uint8Array, open: Opener, kind: CartridgeKind): Snapshot | ProjectSnapshot;
/** Reads an open database as a cartridge of the expected kind. */
export declare function readCartridge(db: DatabaseAdapter, kind: "surface"): Snapshot;
export declare function readCartridge(db: DatabaseAdapter, kind: "project"): ProjectSnapshot;
export declare function readCartridge(db: DatabaseAdapter, kind: CartridgeKind): Snapshot | ProjectSnapshot;
