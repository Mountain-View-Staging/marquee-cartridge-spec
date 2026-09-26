/**
 * A cartridge the Loader will not turn into a Snapshot, with a stable `code`
 * for hosts and a message for people. See loader.ts for the codes.
 */
export class CartridgeError extends Error {
    code;
    /** The table concerned, when there is one. */
    table;
    /** The row concerned, e.g. `id=7`, when there is one. */
    row;
    constructor(code, message, detail = {}) {
        super(message);
        this.name = "CartridgeError";
        this.code = code;
        this.table = detail.table;
        this.row = detail.row;
    }
}
