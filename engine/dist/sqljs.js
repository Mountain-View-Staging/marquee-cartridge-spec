/**
 * The Loader's database adapter over sql.js (SQLite compiled to WebAssembly),
 * for browsers. sql.js is the host's dependency, passed in; this package
 * imports nothing.
 *
 *   const SQL = await initSqlJs({ locateFile: (f) => `…/${f}` });
 *   const snapshot = await loadCartridge(bytes, { open: sqlJsOpener(SQL) });
 */
export function sqlJsOpener(SQL) {
    return (bytes) => {
        const db = new SQL.Database(bytes);
        return {
            all(sql) {
                const statement = db.prepare(sql);
                try {
                    const rows = [];
                    while (statement.step())
                        rows.push(statement.getAsObject());
                    return rows;
                }
                finally {
                    statement.free();
                }
            },
            close() {
                db.close();
            },
        };
    };
}
