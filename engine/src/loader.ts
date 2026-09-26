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
 *   damaged             SQLite cannot read the file although it starts with
 *                       the magic: a truncated or corrupted copy
 *
 * What it accepts with a warning (§10.4): unknown tables, unknown columns, and
 * rows carrying an unknown enumerated value, which are skipped.
 *
 * A row holding a NUL byte (U+0000) in a text column is malformed (§4). Where a
 * row with an unknown enumerated value is skipped, it is skipped with a warning
 * naming the column; in the tables that hold exactly one row it is refused with
 * that table's code (meta_invalid, structure_invalid). The byte is found in SQL,
 * not in the string the binding returns: sql.js, and node:sqlite before Node 24,
 * end the string at the first NUL, and the Loader must say the same on every
 * binding.
 */

import { CartridgeError } from "./errors.js";
import type { CartridgeKind, LoadWarning, ProjectSnapshot, Snapshot } from "./model.js";
import { BASELINE, FORMAT_MAJOR, KNOWN, type ColumnSpec, type TableSpec } from "./schema.js";
import { buildSnapshot, type DecodedRow, type RawTables } from "./snapshot.js";

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

const MAGIC = "SQLite format 3\u0000";

/**
 * §8.5 — a 200 is not proof: a captive portal answers one with an HTML page,
 * and a zero-byte file is a valid empty database. Check the 16-byte magic.
 */
export function isSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

/** Opens `bytes` with `open` and reads them as a cartridge of the expected kind. */
export function loadCartridgeWith(bytes: Uint8Array, open: Opener, kind: "surface"): Snapshot;
export function loadCartridgeWith(bytes: Uint8Array, open: Opener, kind: "project"): ProjectSnapshot;
export function loadCartridgeWith(bytes: Uint8Array, open: Opener, kind: CartridgeKind): Snapshot | ProjectSnapshot;
export function loadCartridgeWith(bytes: Uint8Array, open: Opener, kind: CartridgeKind): Snapshot | ProjectSnapshot {
  if (!(bytes instanceof Uint8Array)) throw new CartridgeError("not_sqlite", "a cartridge is bytes (a Uint8Array)");
  if (!isSqlite(bytes)) throw new CartridgeError("not_sqlite", "not a SQLite database: the first 16 bytes are not the SQLite magic");
  let db: DatabaseAdapter | null = null;
  try {
    db = open(bytes);
    return readCartridge(db, kind);
  } catch (error) {
    throw asCartridgeError(error);
  } finally {
    try {
      db?.close?.();
    } catch {
      // a damaged database may not close cleanly; the error that matters is already thrown
    }
  }
}

/** Anything SQLite throws while reading is a damaged file, never an empty one (§10.3). */
function asCartridgeError(error: unknown): CartridgeError {
  if (error instanceof CartridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CartridgeError("damaged", `the file starts like a SQLite database but cannot be read (${message}): a truncated or corrupted copy`);
}

/** Reads an open database as a cartridge of the expected kind. */
export function readCartridge(db: DatabaseAdapter, kind: "surface"): Snapshot;
export function readCartridge(db: DatabaseAdapter, kind: "project"): ProjectSnapshot;
export function readCartridge(db: DatabaseAdapter, kind: CartridgeKind): Snapshot | ProjectSnapshot;
export function readCartridge(db: DatabaseAdapter, kind: CartridgeKind): Snapshot | ProjectSnapshot {
  try {
    return read(db, kind);
  } catch (error) {
    throw asCartridgeError(error);
  }
}

function read(db: DatabaseAdapter, kind: CartridgeKind): Snapshot | ProjectSnapshot {
  const warnings: LoadWarning[] = [];
  const tables = new Set<string>();
  for (const row of db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) tables.add(String(row["name"]));

  // Identity first: a foreign format should be named as one, not reported as
  // a pile of missing tables.
  if (!tables.has("cartridge_meta")) {
    throw new CartridgeError("not_v25", "not a v25 cartridge: it has no cartridge_meta table", { table: "cartridge_meta" });
  }
  checkIdentity(db, kind);

  const raw: Record<string, DecodedRow[]> = {};
  const expected = new Set<string>();
  for (const spec of BASELINE) {
    if (!spec.in.includes(kind)) continue;
    expected.add(spec.name);
    if (!tables.has(spec.name)) {
      throw new CartridgeError("table_missing", `table ${spec.name} is missing; every v25 ${kind} cartridge carries it`, { table: spec.name });
    }
    raw[spec.name] = decodeTable(db, spec, warnings);
  }
  for (const name of [...tables].sort()) {
    if (name.startsWith("sqlite_") || expected.has(name)) continue;
    warnings.push({ code: "table.unknown", table: name, message: `table ${name} is not part of a v25.0.1 ${kind} cartridge; ignored` });
  }
  return buildSnapshot(kind, raw as RawTables, warnings);
}

// ── identity ────────────────────────────────────────────────────────────────────

function checkIdentity(db: DatabaseAdapter, kind: CartridgeKind): void {
  const table = "cartridge_meta";
  const columns = columnNames(db, table);
  for (const need of ["cartridge_kind", "format_version"]) {
    if (!columns.has(need)) throw new CartridgeError("column_missing", `${table} has no ${need} column`, { table });
  }
  const surfaceId = columns.has("surface_id") ? `"surface_id"` : "NULL AS surface_id";
  const flags = [nulFlag("cartridge_kind"), nulFlag("format_version"), columns.has("surface_id") ? nulFlag("surface_id") : `0 AS ${quote(nulAlias("surface_id"))}`];
  const rows = db.all(`SELECT "cartridge_kind", "format_version", ${surfaceId}, ${flags.join(", ")} FROM "${table}"`);
  if (rows.length !== 1) {
    throw new CartridgeError("meta_invalid", `${table} has ${rows.length} rows; a cartridge has exactly one`, { table });
  }
  const meta = rows[0]!;
  const spec = BASELINE.find((t) => t.name === table)!;
  for (const name of ["cartridge_kind", "format_version", "surface_id"]) {
    if (holdsNul(meta, name)) malformedRow(spec, name, meta, 0); // refuses: cartridge_meta's policy
  }

  const version = meta["format_version"];
  const match = typeof version === "string" ? /^\s*(\d+)(?:\.|\s*$)/.exec(version) : null;
  if (!match) {
    throw new CartridgeError("format_unsupported", `format_version ${describe(version)} is not a version (this engine reads ${FORMAT_MAJOR})`, { table });
  }
  const major = Number(match[1]);
  if (major !== FORMAT_MAJOR) {
    throw new CartridgeError("format_unsupported", `format ${major} is not supported (this engine reads ${FORMAT_MAJOR})`, { table });
  }

  const found = meta["cartridge_kind"];
  if (typeof found !== "string" || !KNOWN.cartridgeKind.has(found)) {
    throw new CartridgeError("meta_invalid", `cartridge_kind ${describe(found)} is neither 'project' nor 'surface'`, { table });
  }
  if (found !== kind) {
    throw new CartridgeError("kind_mismatch", `this is a ${found} cartridge; a ${kind} cartridge was expected`, { table });
  }
  const sid = meta["surface_id"];
  if (kind === "surface" && (typeof sid !== "string" || sid === "")) {
    throw new CartridgeError("meta_invalid", "a surface cartridge names its surface code in cartridge_meta.surface_id", { table });
  }
  if (kind === "project" && sid !== null && sid !== undefined) {
    throw new CartridgeError("meta_invalid", "a project cartridge has cartridge_meta.surface_id NULL", { table });
  }
}

// ── decoding ────────────────────────────────────────────────────────────────────

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function columnNames(db: DatabaseAdapter, table: string): Set<string> {
  const names = new Set<string>();
  for (const row of db.all(`PRAGMA table_info(${quote(table)})`)) names.add(String(row["name"]));
  return names;
}

/**
 * §10.2 — probe the columns that are actually there, once per table, and
 * build the row mapper from them.
 */
function decodeTable(db: DatabaseAdapter, spec: TableSpec, warnings: LoadWarning[]): DecodedRow[] {
  const present = columnNames(db, spec.name);
  const known = new Set<string>();
  for (const column of spec.columns) {
    known.add(column.name);
    if (!present.has(column.name) && column.since === undefined) {
      throw new CartridgeError("column_missing", `table ${spec.name} has no ${column.name} column; every v25 cartridge carries it`, { table: spec.name });
    }
  }
  for (const name of present) {
    if (!known.has(name)) {
      warnings.push({ code: "column.unknown", table: spec.name, column: name, message: `${spec.name}.${name} is not a v25.0.1 column; ignored` });
    }
  }

  const readable = spec.columns.filter((c) => c.read && present.has(c.name));
  const absent = spec.columns.filter((c) => c.read && !present.has(c.name));
  // Each text column is read with a flag saying whether it holds a NUL byte (§4).
  const select = [...readable.map((c) => quote(c.name)), ...readable.filter((c) => c.type === "text").map((c) => nulFlag(c.name))];
  let rows: readonly Record<string, unknown>[];
  try {
    rows = db.all(`SELECT ${select.join(", ")} FROM ${quote(spec.name)}`);
  } catch (error) {
    throw new CartridgeError("table_unreadable", `table ${spec.name} could not be read: ${(error as Error).message}`, { table: spec.name });
  }

  const out: DecodedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const decoded: DecodedRow = {};
    let malformed: string | null = null;
    // Columns in the baseline's order; the first problem decides, so a malformed row
    // is not read further.
    for (const column of readable) {
      decoded[column.name] = decodeValue(spec, column, row[column.name], row, i);
      if (column.type === "text" && holdsNul(row, column.name)) {
        malformed = column.name;
        break;
      }
    }
    if (malformed !== null) {
      warnings.push(malformedRow(spec, malformed, row, i));
      continue;
    }
    for (const column of absent) decoded[column.name] = (column.fallback ?? null) as DecodedRow[string];
    out.push(decoded);
  }
  return out;
}

// ── malformed rows: a NUL byte in a text column (§4) ────────────────────────────

const nulAlias = (name: string): string => `nul:${name}`;

/**
 * 1 when the column holds a TEXT value with a NUL byte in it. Evaluated by SQLite
 * on the whole value, whatever the binding then makes of the string; a BLOB or a
 * number in the column is left to the type check.
 */
function nulFlag(name: string): string {
  return `(CASE WHEN typeof(${quote(name)}) = 'text' THEN instr(${quote(name)}, char(0)) > 0 ELSE 0 END) AS ${quote(nulAlias(name))}`;
}

function holdsNul(row: Record<string, unknown>, name: string): boolean {
  return toNumber(row[nulAlias(name)]) === 1;
}

/**
 * The row is malformed: the warning that skips it, or, for a table that must
 * hold exactly one row, the refusal (thrown here).
 */
function malformedRow(spec: TableSpec, column: string, row: Record<string, unknown>, index: number): LoadWarning {
  const label = rowLabel(spec, row, index);
  const problem = `table ${spec.name}, row ${label}: ${column} holds a NUL byte (U+0000)`;
  if (spec.malformedRow !== "skip") {
    throw new CartridgeError(spec.malformedRow, `${problem}; the row is malformed, and a cartridge has exactly one`, { table: spec.name, row: label });
  }
  const id = spec.idColumn === null ? null : toNumber(row[spec.idColumn]);
  return id === null
    ? { code: "value.malformed", table: spec.name, column, message: `${problem}; the row is malformed and ignored` }
    : { code: "value.malformed", table: spec.name, column, rowId: id, message: `${problem}; the row is malformed and ignored` };
}

function decodeValue(spec: TableSpec, column: ColumnSpec, value: unknown, row: Record<string, unknown>, index: number): DecodedRow[string] {
  const fail = (problem: string): never => {
    const label = rowLabel(spec, row, index);
    throw new CartridgeError("row_undecodable", `table ${spec.name}, row ${label}: ${column.name} ${problem}`, { table: spec.name, row: label });
  };
  if (value === null || value === undefined) {
    if (column.nullable) return null;
    return fail("is NULL, and the column is NOT NULL");
  }
  switch (column.type) {
    case "int": {
      const n = toNumber(value);
      return n !== null && Number.isSafeInteger(n) ? n : fail(`must be a whole number, got ${describe(value)}`);
    }
    case "real": {
      const n = toNumber(value);
      return n !== null && Number.isFinite(n) ? n : fail(`must be a number, got ${describe(value)}`);
    }
    case "text":
      return typeof value === "string" ? value : fail(`must be text, got ${describe(value)}`);
    case "bool": {
      const n = toNumber(value);
      return n === 0 || n === 1 ? n === 1 : fail(`must be 0 or 1, got ${describe(value)}`);
    }
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function rowLabel(spec: TableSpec, row: Record<string, unknown>, index: number): string {
  if (spec.idColumn !== null) {
    const id = toNumber(row[spec.idColumn]);
    if (id !== null) return `${spec.idColumn}=${id}`;
  }
  return `#${index + 1}`;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return `text '${value.length > 40 ? `${value.slice(0, 40)}…` : value}'`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `a ${value.length}-byte blob`;
  return typeof value;
}
