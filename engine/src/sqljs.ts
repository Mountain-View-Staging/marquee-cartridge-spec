/**
 * The Loader's database adapter over sql.js (SQLite compiled to WebAssembly),
 * for browsers. sql.js is the host's dependency, passed in; this package
 * imports nothing.
 *
 *   const SQL = await initSqlJs({ locateFile: (f) => `…/${f}` });
 *   const snapshot = await loadCartridge(bytes, { open: sqlJsOpener(SQL) });
 */

import type { DatabaseAdapter, Opener } from "./loader.js";

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

export function sqlJsOpener(SQL: SqlJsModule): Opener {
  return (bytes: Uint8Array): DatabaseAdapter => {
    const db = new SQL.Database(bytes);
    return {
      all(sql: string): Record<string, unknown>[] {
        const statement = db.prepare(sql);
        try {
          const rows: Record<string, unknown>[] = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally {
          statement.free();
        }
      },
      close(): void {
        db.close();
      },
    };
  };
}
