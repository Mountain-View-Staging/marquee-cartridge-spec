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
 */
import { CartridgeError } from "./errors.js";
import { BASELINE, FORMAT_MAJOR, KNOWN } from "./schema.js";
import { buildSnapshot } from "./snapshot.js";
const MAGIC = "SQLite format 3\u0000";
/**
 * §8.5 — a 200 is not proof: a captive portal answers one with an HTML page,
 * and a zero-byte file is a valid empty database. Check the 16-byte magic.
 */
export function isSqlite(bytes) {
    if (bytes.length < MAGIC.length)
        return false;
    for (let i = 0; i < MAGIC.length; i++)
        if (bytes[i] !== MAGIC.charCodeAt(i))
            return false;
    return true;
}
export function loadCartridgeWith(bytes, open, kind) {
    if (!(bytes instanceof Uint8Array))
        throw new CartridgeError("not_sqlite", "a cartridge is bytes (a Uint8Array)");
    if (!isSqlite(bytes))
        throw new CartridgeError("not_sqlite", "not a SQLite database: the first 16 bytes are not the SQLite magic");
    let db = null;
    try {
        db = open(bytes);
        return readCartridge(db, kind);
    }
    catch (error) {
        throw asCartridgeError(error);
    }
    finally {
        try {
            db?.close?.();
        }
        catch {
            // a damaged database may not close cleanly; the error that matters is already thrown
        }
    }
}
/** Anything SQLite throws while reading is a damaged file, never an empty one (§10.3). */
function asCartridgeError(error) {
    if (error instanceof CartridgeError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    return new CartridgeError("damaged", `the file starts like a SQLite database but cannot be read (${message}): a truncated or corrupted copy`);
}
export function readCartridge(db, kind) {
    try {
        return read(db, kind);
    }
    catch (error) {
        throw asCartridgeError(error);
    }
}
function read(db, kind) {
    const warnings = [];
    const tables = new Set();
    for (const row of db.all("SELECT name FROM sqlite_master WHERE type = 'table'"))
        tables.add(String(row["name"]));
    // Identity first: a foreign format should be named as one, not reported as
    // a pile of missing tables.
    if (!tables.has("cartridge_meta")) {
        throw new CartridgeError("not_v25", "not a v25 cartridge: it has no cartridge_meta table", { table: "cartridge_meta" });
    }
    checkIdentity(db, kind);
    const raw = {};
    const expected = new Set();
    for (const spec of BASELINE) {
        if (!spec.in.includes(kind))
            continue;
        expected.add(spec.name);
        if (!tables.has(spec.name)) {
            throw new CartridgeError("table_missing", `table ${spec.name} is missing; every v25 ${kind} cartridge carries it`, { table: spec.name });
        }
        raw[spec.name] = decodeTable(db, spec, warnings);
    }
    for (const name of [...tables].sort()) {
        if (name.startsWith("sqlite_") || expected.has(name))
            continue;
        warnings.push({ code: "table.unknown", table: name, message: `table ${name} is not part of a v25.0.1 ${kind} cartridge; ignored` });
    }
    return buildSnapshot(kind, raw, warnings);
}
// ── identity ────────────────────────────────────────────────────────────────────
function checkIdentity(db, kind) {
    const table = "cartridge_meta";
    const columns = columnNames(db, table);
    for (const need of ["cartridge_kind", "format_version"]) {
        if (!columns.has(need))
            throw new CartridgeError("column_missing", `${table} has no ${need} column`, { table });
    }
    const surfaceId = columns.has("surface_id") ? `"surface_id"` : "NULL AS surface_id";
    const rows = db.all(`SELECT "cartridge_kind", "format_version", ${surfaceId} FROM "${table}"`);
    if (rows.length !== 1) {
        throw new CartridgeError("meta_invalid", `${table} has ${rows.length} rows; a cartridge has exactly one`, { table });
    }
    const meta = rows[0];
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
const quote = (name) => `"${name.replace(/"/g, '""')}"`;
function columnNames(db, table) {
    const names = new Set();
    for (const row of db.all(`PRAGMA table_info(${quote(table)})`))
        names.add(String(row["name"]));
    return names;
}
/**
 * §10.2 — probe the columns that are actually there, once per table, and
 * build the row mapper from them.
 */
function decodeTable(db, spec, warnings) {
    const present = columnNames(db, spec.name);
    const known = new Set();
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
    let rows;
    try {
        rows = db.all(`SELECT ${readable.map((c) => quote(c.name)).join(", ")} FROM ${quote(spec.name)}`);
    }
    catch (error) {
        throw new CartridgeError("table_unreadable", `table ${spec.name} could not be read: ${error.message}`, { table: spec.name });
    }
    const out = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const decoded = {};
        for (const column of readable)
            decoded[column.name] = decodeValue(spec, column, row[column.name], row, i);
        for (const column of absent)
            decoded[column.name] = (column.fallback ?? null);
        out[i] = decoded;
    }
    return out;
}
function decodeValue(spec, column, value, row, index) {
    const fail = (problem) => {
        const label = rowLabel(spec, row, index);
        throw new CartridgeError("row_undecodable", `table ${spec.name}, row ${label}: ${column.name} ${problem}`, { table: spec.name, row: label });
    };
    if (value === null || value === undefined) {
        if (column.nullable)
            return null;
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
function toNumber(value) {
    if (typeof value === "number")
        return value;
    if (typeof value === "bigint") {
        const n = Number(value);
        return Number.isSafeInteger(n) ? n : null;
    }
    return null;
}
function rowLabel(spec, row, index) {
    if (spec.idColumn !== null) {
        const id = toNumber(row[spec.idColumn]);
        if (id !== null)
            return `${spec.idColumn}=${id}`;
    }
    return `#${index + 1}`;
}
function describe(value) {
    if (value === null || value === undefined)
        return "NULL";
    if (typeof value === "string")
        return `text '${value.length > 40 ? `${value.slice(0, 40)}…` : value}'`;
    if (typeof value === "number" || typeof value === "bigint")
        return String(value);
    if (value instanceof Uint8Array)
        return `a ${value.length}-byte blob`;
    return typeof value;
}
