/**
 * The Node entry: everything in index.js, with `loadCartridge` reading
 * through node:sqlite (Node 22.13 or later), so no SQLite package is needed.
 *
 *   node conformance/run.mjs --engine engine/dist/node.js
 */
import { type LoadOptions, type Opener } from "./loader.js";
import type { ProjectSnapshot, Snapshot } from "./model.js";
export * from "./index.js";
/**
 * Opens cartridge bytes with node:sqlite: in memory where the runtime can
 * deserialize, otherwise from a private temporary file, read-only.
 */
export declare const nodeSqliteOpener: Opener;
/** The Loader, reading through node:sqlite unless another binding is given. */
export declare function loadCartridge(bytes: Uint8Array, options?: LoadOptions & {
    readonly kind?: "surface";
}): Promise<Snapshot>;
export declare function loadCartridge(bytes: Uint8Array, options: LoadOptions & {
    readonly kind: "project";
}): Promise<ProjectSnapshot>;
