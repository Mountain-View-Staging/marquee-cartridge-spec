/**
 * The Snapshot: the engine's own model of a v25.0.1 cartridge.
 *
 * A Snapshot is immutable and indexed. It is built once per committed
 * cartridge — by the Loader from SQLite bytes, or by an authoring tool from
 * its live data — and never touches a database afterwards, so nothing on the
 * render path waits on I/O (specification §5.13).
 *
 * Field names are the wire columns in camelCase. Section numbers refer to the
 * specification in this repository's README.
 */
export {};
