/**
 * Which files a host needs (§7.7). A surface config has one schedule, and a
 * cartridge lists every file it can play, in both orientations. A lane is one
 * orientation over that schedule: the file of that orientation in each item. A
 * Surface may fetch only the files of the lanes it renders. This narrows the
 * manifest for one device. Nothing on screen depends on it: an entry whose file
 * the host does not hold is skipped when its turn comes (§5.13), like any
 * missing file, and plays once the file arrives.
 */
import type { Orientation, ProjectSnapshot, Snapshot } from "./model.js";
export interface LaneSelection {
    /** The orientations the host renders. A Surface passes its own. */
    readonly lanes: readonly Orientation[];
    /**
     * True on a host that runs the DemoStation mode (§5.11). While the
     * `demo_station` slot has any entry with a background, the mode's
     * picture-in-picture plays the same playlist in the opposite orientation, so
     * that orientation's lane is rendered too.
     */
    readonly demo?: boolean;
}
/**
 * §7.7 — the media file ids a host rendering `selection.lanes` needs: every
 * file the manifest lists, except those referenced only as an item's slot file
 * for an orientation the host does not render.
 *
 * - An item's portrait file serves the portrait lane and its landscape file the
 *   landscape lane, however the item is used — a playlist entry, a backing,
 *   demo branding — since each is resolved by orientation with no fallback
 *   (§5.7, §5.10, §5.11).
 * - Brand files are wanted on every lane (§9): each file of an item that is a
 *   brand member, or that the project or a session set names as its style book.
 * - A file no item references is wanted: nothing says which lane it serves.
 * - With `demo`, while the `demo_station` slot has an entry with a background,
 *   the opposite of each lane is rendered too: the picture-in-picture plays the
 *   same playlist in it. The demo branding resolves on the host's own
 *   orientation, which is rendered already.
 *
 * The ids iterate in ascending order. A project snapshot reads the same way:
 * its wallpapers are items, resolved by orientation.
 */
export declare function filesForLanes(snapshot: Snapshot | ProjectSnapshot, selection: LaneSelection): ReadonlySet<number>;
