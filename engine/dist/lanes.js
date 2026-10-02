/**
 * Which files a host needs (§7.7). A surface config has one schedule, and a
 * cartridge lists every file it can play, in both orientations. A lane is one
 * orientation over that schedule: the file of that orientation in each item. A
 * Surface may fetch only the files of the lanes it renders. This narrows the
 * manifest for one device. Nothing on screen depends on it: an entry whose file
 * the host does not hold is skipped when its turn comes (§5.13), like any
 * missing file, and plays once the file arrives.
 */
/**
 * §7.7 — the media file ids a host rendering `selection.lanes` needs: every
 * file the manifest lists, except those referenced only as an item's slot file
 * for an orientation the host does not render, or only as an item a host
 * without the DemoStation mode never draws.
 *
 * - An item's portrait file serves the portrait lane and its landscape file the
 *   landscape lane, however the item is used — a playlist entry, a backing,
 *   demo branding — since each is resolved by orientation with no fallback
 *   (§5.7, §5.10, §5.11).
 * - An item used only as demo branding — named as a `demo_station` entry's
 *   background or overlay, and by no playlist entry, backing, logo or wallpaper —
 *   is in no lane without `demo`: only the DemoStation mode draws it (§5.11). An
 *   item used any other way too keeps its lanes, and a template is wanted on
 *   every lane whatever else names it.
 * - A session board template is wanted on every lane (§5.15): the file of an
 *   item the project or a session set names as its template, whichever slot
 *   holds it — a device of either orientation renders the board with it.
 * - A file no item references is wanted: nothing says which lane it serves.
 * - With `demo`, while the `demo_station` slot has an entry with a background,
 *   the opposite of each lane is rendered too: the picture-in-picture plays the
 *   same playlist in it. The demo branding resolves on the host's own
 *   orientation, which is rendered already.
 *
 * A file is judged by every slot that names it. The ids iterate in ascending
 * order. A project snapshot reads the same way: its wallpapers are items,
 * resolved by orientation.
 */
export function filesForLanes(snapshot, selection) {
    const demo = selection.demo === true;
    const rendered = new Set(selection.lanes);
    if (demo && snapshot.kind === "surface" && snapshot.scheduleBySlot.demo_station.some((e) => e.backgroundItemId !== null)) {
        for (const lane of selection.lanes)
            rendered.add(lane === "portrait" ? "landscape" : "portrait");
    }
    // Items wanted on every lane whatever else names them: the templates.
    const templates = new Set();
    if (snapshot.project.templateItemId !== null)
        templates.add(snapshot.project.templateItemId);
    if (snapshot.kind === "surface") {
        for (const set of snapshot.sessionSets.values()) {
            if (set.templateItemId !== null)
                templates.add(set.templateItemId);
        }
    }
    const brandingOnly = demo ? NO_ITEMS : demoBrandingOnly(snapshot);
    const referenced = new Set();
    const wanted = new Set();
    const slot = (fileId, lane, everyLane, drawn) => {
        if (fileId === null)
            return;
        referenced.add(fileId);
        if (everyLane || (drawn && rendered.has(lane)))
            wanted.add(fileId);
    };
    for (const item of snapshot.mediaItems.values()) {
        const everyLane = templates.has(item.id);
        const drawn = !brandingOnly.has(item.id);
        slot(item.portraitFileId, "portrait", everyLane, drawn);
        slot(item.landscapeFileId, "landscape", everyLane, drawn);
    }
    const out = new Set();
    for (const id of [...snapshot.manifest.keys()].sort((a, b) => a - b)) {
        if (!referenced.has(id) || wanted.has(id))
            out.add(id);
    }
    return out;
}
const NO_ITEMS = new Set();
/**
 * The items a surface cartridge names only as demo branding (§5.11): a
 * `demo_station` entry's background or overlay, used no other way — not a
 * playlist entry's item, not the project's backing or a wallpaper, not a
 * session set's backing or logo. (A template is wanted on every lane before
 * this is asked.)
 */
function demoBrandingOnly(snapshot) {
    if (snapshot.kind !== "surface")
        return NO_ITEMS;
    const branding = new Set();
    for (const entry of snapshot.scheduleBySlot.demo_station) {
        if (entry.backgroundItemId !== null)
            branding.add(entry.backgroundItemId);
        if (entry.overlayItemId !== null)
            branding.add(entry.overlayItemId);
    }
    if (branding.size === 0)
        return branding;
    const usedOtherwise = (id) => {
        if (id !== null)
            branding.delete(id);
    };
    const project = snapshot.project;
    usedOtherwise(project.backingItemId);
    usedOtherwise(project.showWallpaperItemId);
    usedOtherwise(project.desktopWallpaperItemId);
    for (const set of snapshot.sessionSets.values()) {
        usedOtherwise(set.backingItemId);
        usedOtherwise(set.logoItemId);
    }
    for (const playlist of snapshot.playlists.values()) {
        for (const entry of playlist.entries)
            usedOtherwise(entry.mediaItemId);
    }
    return branding;
}
