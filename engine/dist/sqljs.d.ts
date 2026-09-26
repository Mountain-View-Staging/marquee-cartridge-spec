/**
 * The Loader's database adapter over sql.js (SQLite compiled to WebAssembly),
 * for browsers. sql.js is the host's dependency, passed in; this package
 * imports nothing.
 *
 *   const SQL = await initSqlJs({ locateFile: (f) => `…/${f}` });
 *   const snapshot = await loadCartridge(bytes, { open: sqlJsOpener(SQL) });
 */
import type { Opener } from "./loader.js";
/** The part of the sql.js module this adapter uses. */
export interface SqlJsModule {
    readonly Database: new (data?: Uint8Array) => SqlJsDatabase;
}
export interface SqlJsDatabase {
    prepare(sql: string): SqlJsStatement;
    close(): void;
}
export interface SqlJsStatement {
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): unknown;
}
export declare function sqlJsOpener(SQL: SqlJsModule): Opener;
