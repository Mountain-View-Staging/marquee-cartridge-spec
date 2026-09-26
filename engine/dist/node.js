/**
 * The Node entry: everything in index.js, with `loadCartridge` reading
 * through node:sqlite (Node 22.13 or later), so no SQLite package is needed.
 *
 *   node conformance/run.mjs --engine engine/dist/node.js
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCartridgeWith } from "./loader.js";
export * from "./index.js";
/**
 * Opens cartridge bytes with node:sqlite: in memory where the runtime can
 * deserialize, otherwise from a private temporary file, read-only.
 */
export const nodeSqliteOpener = (bytes) => {
    const memory = new DatabaseSync(":memory:");
    if (typeof memory.deserialize === "function") {
        memory.deserialize(bytes);
        return { all: (sql) => memory.prepare(sql).all(), close: () => memory.close() };
    }
    memory.close();
    const dir = mkdtempSync(join(tmpdir(), "marquee-cartridge-"));
    const path = join(dir, "cartridge.db");
    writeFileSync(path, bytes);
    const db = new DatabaseSync(path, { readOnly: true });
    return {
        all: (sql) => db.prepare(sql).all(),
        close: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
};
export async function loadCartridge(bytes, options = {}) {
    return loadCartridgeWith(bytes, options.open ?? nodeSqliteOpener, options.kind ?? "surface");
}
