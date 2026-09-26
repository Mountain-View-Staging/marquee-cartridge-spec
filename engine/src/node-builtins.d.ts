/**
 * The few Node built-ins the Node entry uses, declared here so the package
 * needs no type packages. Only what node.ts calls.
 */

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, options?: { readonly readOnly?: boolean });
    prepare(sql: string): { all(): Record<string, unknown>[] };
    close(): void;
    /** Node 24 and later. */
    deserialize?(data: Uint8Array): void;
  }
}

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
