/**
 * Which files a host needs (§7.7). A cartridge lists every file its config can
 * play, on every lane; a Surface may fetch only what the lanes it renders can
 * show. This narrows the manifest for one device. Nothing on screen depends on
 * it: an entry whose file the host does not hold is skipped when its turn comes
 * (§5.13), like any missing file, and plays once the file arrives.
 */
/**
 * §7.7 — the media file ids a host rendering `selection.lanes` needs: every
 * file the manifest lists, except those referenced only as an item's slot file
 * on a lane the host does not render.
 *
 * - An item's portrait file serves the portrait lane and its landscape file the
 *   landscape lane, however the item is used — a playlist entry, a backing,
 *   demo branding — since each is resolved by orientation with no fallback
 *   (§5.7, §5.10, §5.11).
 * - Brand files are wanted on every lane (§9): each file of an item that is a
 *   brand member, or that the project or a session set names as its style book.
 * - A file no item references is wanted: nothing says which lane it serves.
 * - With `demo`, while the demo lane has an entry with a background, the
 *   opposite of each lane is rendered too. The demo branding resolves on the
 *   host's own orientation, which is rendered already.
 *
 * The ids iterate in ascending order. A project snapshot reads the same way:
 * its wallpapers are items, resolved by orientation.
 */
export function filesForLanes(snapshot, selection) {
    const rendered = new Set(selection.lanes);
    if (selection.demo === true && snapshot.kind === "surface" && snapshot.scheduleBySlot.demo_station.some((e) => e.backgroundItemId !== null)) {
        for (const lane of selection.lanes)
            rendered.add(lane === "portrait" ? "landscape" : "portrait");
    }
    const styleBooks = new Set();
    if (snapshot.project.brandStyleItemId !== null)
        styleBooks.add(snapshot.project.brandStyleItemId);
    if (snapshot.kind === "surface") {
        for (const set of snapshot.sessionSets.values()) {
            if (set.brandStyleItemId !== null)
                styleBooks.add(set.brandStyleItemId);
        }
    }
    const referenced = new Set();
    const wanted = new Set();
    const slot = (fileId, lane, brand) => {
        if (fileId === null)
            return;
        referenced.add(fileId);
        if (brand || rendered.has(lane))
            wanted.add(fileId);
    };
    for (const item of snapshot.mediaItems.values()) {
        const brand = item.brandMember !== null || styleBooks.has(item.id);
        slot(item.portraitFileId, "portrait", brand);
        slot(item.landscapeFileId, "landscape", brand);
    }
    const out = new Set();
    for (const id of [...snapshot.manifest.keys()].sort((a, b) => a - b)) {
        if (!referenced.has(id) || wanted.has(id))
            out.add(id);
    }
    return out;
}
