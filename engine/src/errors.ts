/**
 * A cartridge the Loader will not turn into a Snapshot, with a stable `code`
 * for hosts and a message for people. See loader.ts for the codes.
 */

export type CartridgeErrorCode =
  | "not_sqlite"
  | "not_v25"
  | "format_unsupported"
  | "kind_mismatch"
  | "meta_invalid"
  | "table_missing"
  | "column_missing"
  | "table_unreadable"
  | "row_undecodable"
  | "structure_invalid"
  | "damaged"
  | "no_sqlite_binding";

export class CartridgeError extends Error {
  readonly code: CartridgeErrorCode;
  /** The table concerned, when there is one. */
  readonly table: string | undefined;
  /** The row concerned, e.g. `id=7`, when there is one. */
  readonly row: string | undefined;

  constructor(code: CartridgeErrorCode, message: string, detail: { table?: string; row?: string } = {}) {
    super(message);
    this.name = "CartridgeError";
    this.code = code;
    this.table = detail.table;
    this.row = detail.row;
  }
}
