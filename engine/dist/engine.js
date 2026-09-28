/**
 * The Surface engine: given a committed Snapshot and the passage of time, it
 * decides what is on screen, when it changes, and why (specification §5, §8).
 * Hosts draw pixels; the engine never does.
 *
 * The host calls `tick(wallMs, monoMs)` from its display loop and answers
 * each RenderItem it receives with `onFirstFrame`, `onMediaCompleted` or
 * `onLoadFailed`, carrying the item's token. Every call returns the trace
 * events it caused.
 *
 *   tick(wall, mono):
 *     showNow = clock(wall, mono)                 one instant for the whole tick
 *     a jump?  → marker = 0                       §8.3
 *     showNow ≥ next schedule boundary → resolve  §5.2; a new playlist cuts, and
 *                                                 on a DemoStation, a demo starting or ending (§5.11)
 *     waiting for a first frame?  10 s of monotonic time → skip; else return
 *     marker forced, or showNow ≥ marker → renderNext   §5.9: the only place content changes
 *
 *   renderNext:
 *     viability pass → working set (alert, else takeover, else standard) →
 *     next entry after the cursor → RenderItem with a hint; an empty set holds
 *     (the last frame stays) and retries in 2 s
 *
 * There is one schedule, whatever the orientation (§5.1). The orientation
 * rendered — the device's, or the opposite one in a DemoStation's
 * picture-in-picture — decides only which entries pass the orientation gate and
 * which file of each plays. When it changes, the playlist is the same, so the
 * rotation keeps its cursors and continues in the new orientation.
 *
 * Nothing on the tick path allocates when nothing changes, and nothing
 * touches a database: the Snapshot is indexed once, when committed.
 */
import { minimalBoardResolver } from "./board.js";
import { DirectiveSeries, NO_DIRECTIVES, isPlayableType, isVideoType, playbackWindow, watchdogSeconds, } from "./rules.js";
import { Calendar } from "./venue-time.js";
/** A host that never reports a first frame for this long (monotonic) has failed to load the item. */
export const FIRST_FRAME_TIMEOUT_MS = 10_000;
/** §5.5 — an empty working set is evaluated again after this much show time. */
export const EMPTY_RETRY_MS = 2_000;
/** §8.3 — forward show-clock movement beyond real elapsed time plus this is a jump. */
export const JUMP_TOLERANCE_MS = 250;
/**
 * §5.14 — with no orientation from the host, the gate is skipped, and each entry
 * plays this orientation's file, else the other one; backings and demo branding
 * resolve in it. Landscape, as §6's Automatic reads a display that is not taller
 * than it is wide.
 */
export const ORIENTATION_WHEN_MISSING = "landscape";
// Working-set kinds, marker reasons and schedule states, as small integers.
const NONE = 0, STANDARD = 1, TAKEOVER = 2, EMPTY = 3, ALERT = 4;
const FORCED = 0, NATURAL = 1, WATCHDOG = 2, INTERRUPT = 3, RETRY = 4, COMPLETED = 5, SKIPPED = 6;
const UNRESOLVED = 0, NOTHING = 1, BLANK = 2, PLAYLIST = 3;
const MARKER_REASONS = ["forced", "natural", "watchdog", "interrupt", "retry", "completed", "skipped"];
const NO_EVENTS = Object.freeze([]);
const NO_SET_ENTRIES = Object.freeze([]);
const NO_SCHEDULE = Object.freeze([]);
/** §5.6 — a rotation cursor: the authored position of the last entry shown (id breaks ties). */
class Cursor {
    has = false;
    position = 0;
    entryId = 0;
    clear() {
        this.has = false;
    }
    set(position, entryId) {
        this.has = true;
        this.position = position;
        this.entryId = entryId;
    }
    isBefore(plan) {
        return plan.position > this.position || (plan.position === this.position && plan.id > this.entryId);
    }
}
let engines = 0;
/** Creates an engine for one committed Snapshot and one device. */
export function createEngine(options) {
    return new SurfaceEngine(options);
}
export class SurfaceEngine {
    snap;
    calendar;
    plans;
    /** The `playlist` slot: the one schedule (§5.2). */
    lane;
    /** The `demo_station` slot on a DemoStation host (§5.11); empty otherwise. */
    demoLane;
    demoStation;
    clock;
    boardResolver;
    firstFrameTimeoutMs;
    emptyRetryMs;
    /** The device's orientation (§6). */
    orientationValue;
    /** The orientation whose files play (§5.1): the device's, or the opposite during a demo (§5.11). */
    rendered;
    tokenPrefix;
    tokenCount = 0;
    // The show clock at this tick and the previous one (§8.3).
    show = Number.NaN;
    lastShow = Number.NaN;
    lastMono = Number.NaN;
    // The schedule (§5.2).
    activeEntry = null;
    activeState = UNRESOLVED;
    activePlaylistId = null;
    activeFrom = Number.NEGATIVE_INFINITY;
    nextBoundary = Number.POSITIVE_INFINITY;
    mustResolve = true;
    resolveCause = "boot";
    // The DemoStation mode (§5.11): the active `demo_station` entry, whether it
    // turns the demo on, and its branding while it does.
    demoEntry = null;
    demoOn = false;
    demoValue = null;
    // Rotation (§5.5, §5.6).
    standardCursor = new Cursor();
    takeoverCursor = new Cursor();
    alertCursor = new Cursor();
    lastSet = NONE;
    /** Entries that failed since an item last finished its time: when it covers the working set, hold. */
    failed = new Set();
    // The one render marker (§5.9). "Marker 0" — the next tick evaluates — is a state
    // of its own, not a timestamp: a comparison with the show time would wait while
    // the show time is before 1970 (negative milliseconds, reachable from a preview
    // clock). It is never disarmed: every path out of an evaluation either forces it
    // or arms it at an instant.
    marker = 0;
    markerForced = true;
    markerReason = FORCED;
    currentItem = null;
    since = Number.NaN;
    /** Whether the current item's reports still count: from its first frame until its time is over or it is cut. */
    currentLive = false;
    pendingItem = null;
    pendingMono = Number.NaN;
    /** The activation known to cut the pending item when it was chosen: a takeover's or an alert's (§5.9). */
    pendingInterruptAt = Number.POSITIVE_INFINITY;
    /** Which of the two that activation is, for the trace's words. */
    pendingInterruptByAlert = false;
    issued = null;
    events = null;
    lastStateKind = null;
    lastStateCode = null;
    orientationWarned = false;
    // Host events applied at the next tick, so they share its showNow.
    orientationChanged = false;
    previousOrientation = null;
    incoming = null;
    committing = false;
    // Buffers of the viability pass, reused.
    standardList = [];
    takeoverList = [];
    alertList = [];
    /** The earliest future activations among the viable entries (§5.9), from the last pass. */
    nextTakeoverOn = Number.POSITIVE_INFINITY;
    nextAlertOn = Number.POSITIVE_INFINITY;
    chosenCode = "rotation.start";
    out = {
        showNow: 0,
        projected: false,
        renderItem: null,
        trace: NO_EVENTS,
        demo: null,
    };
    constructor(options) {
        const { snapshot, clock } = options;
        if (!snapshot || snapshot.kind !== "surface")
            throw new TypeError("createEngine needs a surface Snapshot (loadCartridge)");
        if (!clock || typeof clock.now !== "function")
            throw new TypeError("createEngine needs a show clock (surfaceClock() or previewClock())");
        this.snap = snapshot;
        this.calendar = new Calendar(snapshot.days, snapshot.meta.timezone);
        this.plans = compilePlans(snapshot);
        this.demoStation = options.demoStation === true;
        this.lane = snapshot.scheduleBySlot.playlist;
        this.demoLane = this.demoStation ? snapshot.scheduleBySlot.demo_station : NO_SCHEDULE;
        this.orientationValue = asOrientation(options.orientation);
        this.rendered = this.orientationValue;
        this.clock = clock;
        this.boardResolver = options.boardResolver ?? minimalBoardResolver;
        this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
        this.emptyRetryMs = options.emptyRetryMs ?? EMPTY_RETRY_MS;
        this.tokenPrefix = `e${++engines}.`;
    }
    get snapshot() {
        return this.incoming ?? this.snap;
    }
    /** The device's orientation (§6). */
    get orientation() {
        return this.orientationValue;
    }
    /** The orientation whose files play (§5.1): the device's, or the opposite in a DemoStation's picture-in-picture. */
    get renderedOrientation() {
        return this.rendered;
    }
    /** A DemoStation's demo, while it is on (§5.11). */
    get demo() {
        return this.demoValue;
    }
    /** The show clock at the last tick. */
    get showNow() {
        return this.show;
    }
    /** What is on screen: the last item that reported its first frame, or the blank. */
    get current() {
        return this.currentItem;
    }
    /** The show time of the current item's first frame (board pages are timed from it). */
    get currentSince() {
        return this.since;
    }
    /** The item issued and awaiting its first frame. */
    get pending() {
        return this.pendingItem;
    }
    get venueCalendar() {
        return this.calendar;
    }
    // ── host → engine ──────────────────────────────────────────────────────────
    tick(wallMs, monoMs) {
        this.events = null;
        this.issued = null;
        if (this.incoming !== null)
            this.install();
        const show = this.clock.now(wallMs, monoMs, this.calendar);
        this.show = show;
        if (this.committing)
            this.afterCommit(show);
        if (this.orientationChanged)
            this.afterOrientationChange(show);
        // §8.3 — a move the monotonic clock cannot explain is a jump.
        if (this.lastShow === this.lastShow) {
            const moved = show - this.lastShow;
            if (moved < 0)
                this.jump("jump.backward", show);
            else if (moved - (monoMs - this.lastMono) > JUMP_TOLERANCE_MS)
                this.jump("jump.forward", show);
        }
        this.lastShow = show;
        this.lastMono = monoMs;
        if (this.mustResolve || show >= this.nextBoundary || show < this.activeFrom)
            this.resolveSchedule(show);
        if (this.pendingItem !== null) {
            if (show >= this.pendingInterruptAt) {
                // A takeover or an alert is due while the next item is still loading: that
                // item never showed, and the activation cuts what is on screen now (§5.9).
                this.pendingItem = null;
                this.forceMarker(INTERRUPT);
            }
            else if (monoMs - this.pendingMono < this.firstFrameTimeoutMs) {
                return this.output(show, wallMs);
            }
            else {
                const late = this.pendingItem;
                this.pendingItem = null;
                this.skip(late, "media.no_first_frame", show, `no first frame within ${this.firstFrameTimeoutMs / 1000} s`);
            }
        }
        if (this.markerForced || show >= this.marker)
            this.evaluate(show, monoMs);
        return this.output(show, wallMs);
    }
    /** The item's first frame is on screen: arm the marker from its hint. */
    onFirstFrame(token) {
        this.events = null;
        const item = this.pendingItem;
        if (item === null || item.token !== token)
            return NO_EVENTS;
        this.pendingItem = null;
        const show = this.show;
        this.currentItem = item;
        this.currentLive = true;
        this.since = show;
        if (item.hint.kind === "time") {
            this.armMarker(item.hint.at, INTERRUPT);
        }
        else {
            const end = show + Math.round(item.hint.seconds * 1000);
            if (this.pendingInterruptAt < end) {
                // The first frame came late enough that a known takeover or alert now
                // falls before the item's end: it still cuts at its time.
                this.armMarker(this.pendingInterruptAt, INTERRUPT);
            }
            else {
                this.armMarker(end, item.kind === "media" && item.media.isVideo ? WATCHDOG : NATURAL);
            }
        }
        this.cursorOf(item.set).set(item.position, item.entryId);
        const dwell = item.hint.kind === "duration" ? item.hint.seconds : 0;
        const hint = this.markerReason === INTERRUPT
            ? `until ${this.calendar.format(this.marker)}, when ${this.pendingInterruptByAlert ? "an alert" : "a takeover"} starts`
            : item.kind === "media" && item.media.isVideo
                ? item.media.duration === null
                    ? "to the end of the clip"
                    : `for ${seconds(item.media.duration)} (${item.media.durationSource})`
                : item.kind === "media"
                    ? `for ${seconds(dwell)} (${item.media.durationSource})`
                    : `for ${seconds(dwell)} (${item.board.pageCount} × ${seconds(item.board.pageDuration)})`;
        const what = item.kind === "media" ? `file ${item.media.mediaFileId}` : `the session board of set ${item.board.sessionSetId}`;
        this.emit(item.kind === "media"
            ? { showTime: show, kind: "render", code: item.code, entryId: item.entryId, set: item.set, mediaFileId: item.media.mediaFileId, message: `entry ${item.entryId} "${item.name}": ${what}, ${item.set} rotation, ${hint}` }
            : { showTime: show, kind: "render", code: item.code, entryId: item.entryId, set: item.set, sessionSetId: item.board.sessionSetId, message: `entry ${item.entryId} "${item.name}": ${what}, ${item.set} rotation, ${hint}` });
        return this.events ?? NO_EVENTS;
    }
    /** The media reached the end of its window: evaluate the next content at the next tick. */
    onMediaCompleted(token) {
        this.events = null;
        const item = this.currentItem;
        if (item !== null && item.kind !== "blank" && item.token === token && this.currentLive) {
            this.forceMarker(COMPLETED);
        }
        return NO_EVENTS;
    }
    /** The host could not show the item: skip it and move on. */
    onLoadFailed(token, reason) {
        this.events = null;
        const why = reason ? `load failed: ${reason}` : "load failed";
        if (this.pendingItem !== null && this.pendingItem.token === token) {
            const item = this.pendingItem;
            this.pendingItem = null;
            this.skip(item, "media.load_failed", this.show, why);
        }
        else if (this.currentItem !== null && this.currentItem.kind !== "blank" && this.currentItem.token === token && this.currentLive) {
            this.currentLive = false;
            this.skip(this.currentItem, "media.load_failed", this.show, why);
        }
        return this.events ?? NO_EVENTS;
    }
    /**
     * The device's orientation changed (§5.1, §6): the operator set it, or the
     * driven display turned. At the next tick the engine cuts, keeps both
     * cursors — the playlist is the same — and continues with the new
     * orientation's files. During a demo the picture-in-picture turns with it.
     */
    setOrientation(orientation) {
        this.events = null;
        const next = asOrientation(orientation);
        if (next === this.orientationValue)
            return NO_EVENTS;
        if (!this.orientationChanged)
            this.previousOrientation = this.orientationValue;
        this.orientationValue = next;
        this.orientationChanged = true;
        return NO_EVENTS;
    }
    /** A new cartridge is committed: reset all state and cut at the next tick (§5.9). */
    commit(snapshot) {
        this.events = null;
        if (!snapshot || snapshot.kind !== "surface")
            throw new TypeError("commit needs a surface Snapshot");
        this.incoming = snapshot;
        return NO_EVENTS;
    }
    // ── the tick's parts ───────────────────────────────────────────────────────
    output(show, wall) {
        const out = this.out;
        out.showNow = show;
        out.projected = this.clock.kind === "preview" || show !== wall;
        out.renderItem = this.issued;
        out.trace = this.events ?? NO_EVENTS;
        out.demo = this.demoValue;
        return out;
    }
    emit(event) {
        (this.events ??= []).push(event);
        if (event.kind === "render" || event.kind === "hold" || event.kind === "blank") {
            this.lastStateKind = event.kind;
            this.lastStateCode = event.code;
        }
    }
    install() {
        const snapshot = this.incoming;
        this.incoming = null;
        this.snap = snapshot;
        this.calendar = new Calendar(snapshot.days, snapshot.meta.timezone);
        this.plans = compilePlans(snapshot);
        this.lane = snapshot.scheduleBySlot.playlist;
        this.demoLane = this.demoStation ? snapshot.scheduleBySlot.demo_station : NO_SCHEDULE;
        this.committing = true;
        // A new calendar is not a clock movement.
        this.lastShow = Number.NaN;
        this.lastMono = Number.NaN;
    }
    afterCommit(show) {
        this.committing = false;
        const on = this.currentItem;
        if (on !== null && on.kind !== "blank") {
            this.emit({ showTime: show, kind: "cut", code: "cartridge.commit", entryId: on.entryId, message: `revision ${this.snap.meta.publishedRevision} of the cartridge is committed; everything restarts` });
        }
        this.currentItem = null;
        this.currentLive = false;
        this.since = Number.NaN;
        this.pendingItem = null;
        this.standardCursor.clear();
        this.takeoverCursor.clear();
        this.alertCursor.clear();
        this.lastSet = NONE;
        this.clearFailures();
        this.activeEntry = null;
        this.activeState = UNRESOLVED;
        this.activePlaylistId = null;
        this.activeFrom = Number.NEGATIVE_INFINITY;
        this.nextBoundary = Number.POSITIVE_INFINITY;
        this.demoEntry = null;
        this.demoOn = false;
        this.demoValue = null;
        this.updateRendered();
        this.mustResolve = true;
        this.resolveCause = "commit";
        this.forceMarker(FORCED);
        this.lastStateKind = null;
        this.lastStateCode = null;
    }
    /**
     * §5.1 — a rotation. The schedule does not depend on the orientation, so the
     * playlist is the same and both cursors are kept; the entry on screen is cut,
     * and the next pass runs in the new orientation. A schedule boundary reached
     * in the same tick is a cause of its own, recorded by the resolution.
     */
    afterOrientationChange(show) {
        this.orientationChanged = false;
        if (this.orientationValue === this.previousOrientation)
            return; // changed and changed back before a tick
        this.updateRendered();
        this.updateDemo(this.demoEntry); // the branding resolves in the device's orientation
        const on = this.currentItem;
        if (on !== null && on.kind !== "blank") {
            this.emit({
                showTime: show,
                kind: "cut",
                code: "orientation.change",
                entryId: on.entryId,
                message: `the device's orientation ${this.previousOrientation ?? "missing"} → ${this.orientationValue ?? "missing"}${this.demoOn ? ", and the picture-in-picture's with it" : ""}; entry ${on.entryId} ends now, and the rotation continues after its cursors with ${this.rendered ?? "either slot's"} files`,
            });
        }
        this.currentLive = false;
        this.pendingItem = null;
        this.clearFailures();
        this.forceMarker(FORCED);
        if (this.orientationValue !== null)
            this.orientationWarned = false;
    }
    jump(code, show) {
        const from = this.calendar.format(this.lastShow);
        const to = this.calendar.format(show);
        this.emit({
            showTime: show,
            kind: "jump",
            code,
            message: code === "jump.backward"
                ? `the show clock moved back from ${from} to ${to}; everything is evaluated again`
                : `the show clock moved from ${from} to ${to}, further than real time did; everything is evaluated again`,
        });
        this.forceMarker(FORCED);
        this.currentLive = false;
        this.pendingItem = null;
        this.mustResolve = true;
        if (this.resolveCause === "boundary")
            this.resolveCause = "jump";
    }
    /**
     * §5.2 — the latest `playlist` entry whose timestamp ≤ showNow, and on a
     * DemoStation host the latest `demo_station` entry (§5.11). A boundary that
     * keeps the playlist and the mode does nothing but update the demo branding.
     * One that changes the playlist resets both cursors; one that starts or ends a
     * demo moves the rotation between the full screen and the picture-in-picture
     * and keeps them. Either cuts and forces the next content.
     */
    resolveSchedule(show) {
        const cause = this.resolveCause;
        this.mustResolve = false;
        this.resolveCause = "boundary";
        const lane = this.lane;
        const i = latestAt(lane, show);
        const entry = i >= 0 ? lane[i] : null;
        let from = entry !== null ? entry.timestamp : Number.NEGATIVE_INFINITY;
        let next = i + 1 < lane.length ? lane[i + 1].timestamp : Number.POSITIVE_INFINITY;
        const demoLane = this.demoLane;
        const j = latestAt(demoLane, show);
        const demoEntry = j >= 0 ? demoLane[j] : null;
        if (demoEntry !== null && demoEntry.timestamp > from)
            from = demoEntry.timestamp;
        if (j + 1 < demoLane.length && demoLane[j + 1].timestamp < next)
            next = demoLane[j + 1].timestamp;
        this.activeEntry = entry;
        this.activeFrom = from;
        this.nextBoundary = next;
        if (demoEntry !== this.demoEntry)
            this.updateDemo(demoEntry);
        const state = entry === null ? NOTHING : entry.playlistId === null ? BLANK : PLAYLIST;
        const playlistId = entry !== null ? entry.playlistId : null;
        const playlistChanged = state !== this.activeState || playlistId !== this.activePlaylistId;
        const demoOn = demoEntry !== null && demoEntry.backgroundItemId !== null;
        const modeChanged = demoOn !== this.demoOn;
        if (!playlistChanged && !modeChanged)
            return;
        const recorded = cause === "boundary" && this.activeState !== UNRESOLVED;
        const on = this.currentItem;
        const previousPlaylist = this.activePlaylistId;
        if (playlistChanged) {
            this.activeState = state;
            this.activePlaylistId = playlistId;
            this.standardCursor.clear();
            this.takeoverCursor.clear();
            this.alertCursor.clear();
            this.lastSet = NONE;
        }
        if (modeChanged) {
            this.demoOn = demoOn;
            this.updateRendered();
        }
        // One event per cause: a demo starting or ending names the move; a playlist
        // change the same boundary makes resets the cursors silently.
        if (recorded && on !== null && on.kind !== "blank") {
            this.emit(modeChanged
                ? {
                    showTime: show,
                    kind: "cut",
                    code: "mode.change",
                    entryId: on.entryId,
                    message: demoOn
                        ? `a demo starts at ${this.calendar.format(show)} (schedule entry ${demoEntry.id}): entry ${on.entryId} ends now, and the rotation continues in the picture-in-picture with ${this.rendered ?? "either slot's"} files`
                        : `the demo ends at ${this.calendar.format(show)}: entry ${on.entryId} ends now, and the rotation continues on the full screen with ${this.rendered ?? "either slot's"} files`,
                }
                : {
                    showTime: show,
                    kind: "cut",
                    code: "schedule.change",
                    entryId: on.entryId,
                    message: `schedule entry ${entry?.id} at ${this.calendar.format(show)}: ${describePlaylist(previousPlaylist)} → ${describePlaylist(playlistId)}`,
                });
        }
        this.clearFailures();
        this.currentLive = false;
        this.pendingItem = null;
        this.forceMarker(FORCED);
    }
    // ── the DemoStation mode (§5.11) ─────────────────────────────────────────────
    //
    // The picture-in-picture is this engine's own rotation, moved: the same
    // playlist, in the orientation opposite the device's. That is the whole rule,
    // and it is here:
    //   updateRendered  the orientation whose files play while a demo is on;
    //   updateDemo      the demo's branding, in the device's own orientation.
    // resolveSchedule starts and ends a demo — a cut that keeps both cursors, as a
    // rotation does, since the playlist is the same — and the items built while it
    // is on carry `pip`.
    /** §5.1, §5.11 — the orientation whose files play: the device's, or its opposite while a demo is on. */
    updateRendered() {
        const o = this.orientationValue;
        this.rendered = o === null || !this.demoOn ? o : o === "portrait" ? "landscape" : "portrait";
    }
    /** §5.11 — the active `demo_station` entry, and its branding in the device's own orientation while it turns the demo on. */
    updateDemo(entry) {
        this.demoEntry = entry;
        if (entry === null || entry.backgroundItemId === null) {
            this.demoValue = null;
            return;
        }
        const orientation = this.orientationValue ?? ORIENTATION_WHEN_MISSING;
        this.demoValue = Object.freeze({
            scheduleEntryId: entry.id,
            background: this.layer(entry.backgroundItemId, orientation),
            overlay: this.layer(entry.overlayItemId, orientation),
        });
    }
    // ── the next content (§5.3 – §5.9) ───────────────────────────────────────────
    /** The marker is reached: the current content ends, and the next is chosen. */
    evaluate(show, mono) {
        const reason = this.markerReason;
        const on = this.currentItem;
        if (reason === WATCHDOG && on !== null && on.kind === "media" && this.currentLive) {
            this.emit({ showTime: show, kind: "skip", code: "media.watchdog", entryId: on.entryId, message: `entry ${on.entryId}: the video did not report its end within ${seconds(on.hint.kind === "duration" ? on.hint.seconds : 0)}` });
        }
        this.currentLive = false;
        // An item that finished its time, or was cut by a takeover or an alert, ends a streak of failures.
        if (reason === NATURAL || reason === WATCHDOG || reason === INTERRUPT || reason === COMPLETED)
            this.clearFailures();
        this.renderNext(show, mono, reason);
    }
    renderNext(show, mono, reason) {
        if (this.orientationValue === null && !this.orientationWarned) {
            this.orientationWarned = true;
            this.emit({ showTime: show, kind: "warning", code: "orientation.missing", message: "the host supplied no orientation; the orientation gate is skipped" });
        }
        if (this.activeState === BLANK) {
            this.blank(show);
            return;
        }
        const plans = this.activeState === PLAYLIST ? this.plans.get(this.activePlaylistId) : undefined;
        if (plans === undefined) {
            this.lastSet = EMPTY;
            if (this.holding("set.empty"))
                this.rearm(show);
            else
                this.hold("set.empty", show, this.activeState === PLAYLIST
                    ? `playlist ${this.activePlaylistId} is not in the cartridge; the last frame stays`
                    : `no playlist is scheduled yet at ${this.calendar.format(show)}; the last frame stays`);
            return;
        }
        this.pass(show, plans);
        const kind = this.alertList.length > 0
            ? ALERT
            : this.takeoverList.length > 0 ? TAKEOVER : this.standardList.length > 0 ? STANDARD : EMPTY;
        if (kind === ALERT && this.lastSet !== ALERT)
            this.alertCursor.clear(); // an alert period begins
        if (kind === TAKEOVER && this.lastSet !== TAKEOVER)
            this.takeoverCursor.clear(); // a takeover period begins
        const on = this.currentItem;
        if (reason === INTERRUPT && (kind === ALERT || kind === TAKEOVER) && on !== null && on.kind !== "blank") {
            this.emit(kind === ALERT
                ? { showTime: show, kind: "cut", code: "alert.activate", entryId: on.entryId, message: `an alert starts at ${this.calendar.format(show)}; entry ${on.entryId} ends now` }
                : { showTime: show, kind: "cut", code: "takeover.activate", entryId: on.entryId, message: `a takeover starts at ${this.calendar.format(show)}; entry ${on.entryId} ends now` });
        }
        this.lastSet = kind;
        if (kind === EMPTY) {
            this.clearFailures();
            if (this.holding("set.empty"))
                this.rearm(show);
            else
                this.hold("set.empty", show, `no entry of playlist ${this.activePlaylistId} is viable at ${this.calendar.format(show)}; the last frame stays`);
            return;
        }
        const list = kind === ALERT ? this.alertList : kind === TAKEOVER ? this.takeoverList : this.standardList;
        const cursor = kind === ALERT ? this.alertCursor : kind === TAKEOVER ? this.takeoverCursor : this.standardCursor;
        for (;;) {
            if (this.allFailed(list)) {
                this.clearFailures();
                if (this.holding("set.all_failed"))
                    this.rearm(show);
                else
                    this.hold("set.all_failed", show, `every entry of the ${setName(kind)} set failed in a row; trying again in ${seconds(this.emptyRetryMs / 1000)}`);
                return;
            }
            const plan = list[this.choose(list, cursor)];
            const item = this.build(plan, kind, cursor, show);
            if (item === null)
                continue; // skipped; the skip moved the cursor
            this.pendingItem = item;
            this.pendingMono = mono;
            this.pendingInterruptAt = this.interruptFor(kind);
            this.pendingInterruptByAlert = this.pendingInterruptAt === this.nextAlertOn;
            this.issued = item;
            return;
        }
    }
    /**
     * §5.3 — the viability pass, for each entry: the orientation gate, then its
     * alert directives over the whole timeline, then — scoped to the day — its
     * takeover and standard directives. Fills the three sets in position order,
     * and the earliest future activation of each higher set (§5.9 interrupts).
     */
    pass(show, plans) {
        const dayIndex = this.calendar.dayIndexAt(show);
        const dayStart = dayIndex >= 0 ? this.calendar.days[dayIndex].startTime : Number.NEGATIVE_INFINITY;
        const standard = this.standardList;
        const takeover = this.takeoverList;
        const alert = this.alertList;
        standard.length = 0;
        takeover.length = 0;
        alert.length = 0;
        let nextTakeover = Number.POSITIVE_INFINITY;
        let nextAlert = Number.POSITIVE_INFINITY;
        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            if (!this.passesOrientation(plan))
                continue; // directives never read
            if (plan.alert.isOn(show, Number.NEGATIVE_INFINITY))
                alert.push(plan); // never day-scoped (§5.4)
            else {
                const next = plan.alert.nextOn(show);
                if (next < nextAlert)
                    nextAlert = next;
            }
            if (plan.takeover.isOn(show, dayStart))
                takeover.push(plan);
            else {
                const next = plan.takeover.nextOn(show);
                if (next < nextTakeover)
                    nextTakeover = next;
            }
            if (plan.standard.isOn(show, dayStart))
                standard.push(plan);
        }
        this.nextTakeoverOn = nextTakeover;
        this.nextAlertOn = nextAlert;
    }
    /**
     * §5.9 — the activation that cuts an item of this set: under standard, the
     * next takeover or alert; under a takeover, the next alert; nothing cuts an alert.
     */
    interruptFor(kind) {
        if (kind === STANDARD)
            return this.nextAlertOn < this.nextTakeoverOn ? this.nextAlertOn : this.nextTakeoverOn;
        if (kind === TAKEOVER)
            return this.nextAlertOn;
        return Number.POSITIVE_INFINITY;
    }
    /** §5.6 — the cursor of an item's set. */
    cursorOf(set) {
        return set === "alert" ? this.alertCursor : set === "takeover" ? this.takeoverCursor : this.standardCursor;
    }
    /** §5.3 step 2 — an empty slot for the orientation rendered excludes a media entry. */
    passesOrientation(plan) {
        if (plan.board)
            return plan.set !== null;
        if (plan.item === null)
            return false;
        const orientation = this.rendered;
        if (orientation === null)
            return plan.portrait !== null || plan.landscape !== null;
        return (orientation === "portrait" ? plan.portrait : plan.landscape) !== null;
    }
    /** The orientation whose slot supplies the file (§5.7); without an orientation, landscape's first (§5.14). */
    playOrientation(plan) {
        const orientation = this.rendered;
        if (orientation !== null)
            return orientation;
        const first = ORIENTATION_WHEN_MISSING;
        if ((first === "portrait" ? plan.portrait : plan.landscape) !== null)
            return first;
        return first === "portrait" ? "landscape" : "portrait";
    }
    /** §5.6 — the first entry after the cursor, wrapping; the first entry with no cursor. */
    choose(list, cursor) {
        if (!cursor.has) {
            this.chosenCode = "rotation.start";
            return 0;
        }
        for (let i = 0; i < list.length; i++) {
            if (cursor.isBefore(list[i])) {
                this.chosenCode = "rotation.next";
                return i;
            }
        }
        this.chosenCode = "rotation.wrap";
        return 0;
    }
    /** Set.prototype.clear allocates a new table even when empty: keep the idle paths allocation-free. */
    clearFailures() {
        if (this.failed.size > 0)
            this.failed.clear();
    }
    allFailed(list) {
        if (this.failed.size < list.length)
            return false;
        for (let i = 0; i < list.length; i++)
            if (!this.failed.has(list[i].id))
                return false;
        return true;
    }
    /** The RenderItem for a chosen entry, or null when the entry is skipped on the spot. */
    build(plan, kind, cursor, show) {
        const set = kind === ALERT ? "alert" : kind === TAKEOVER ? "takeover" : "standard";
        const project = this.snap.project;
        if (plan.board) {
            const sessionSet = plan.set;
            let resolution;
            try {
                resolution = this.boardResolver(sessionSet, {
                    showNow: show,
                    timezone: this.calendar.timeZone,
                    entries: this.snap.sessionSetEntries.get(sessionSet.id) ?? NO_SET_ENTRIES,
                    sessions: this.snap.sessions,
                    snapshot: this.snap,
                });
            }
            catch (error) {
                this.skipPlan(plan, cursor, "media.load_failed", show, `the board resolver failed: ${error?.message ?? String(error)}`);
                return null;
            }
            const pageCount = Number.isSafeInteger(resolution?.pageCount) && resolution.pageCount >= 1 ? resolution.pageCount : 1;
            const anchorPage = Number.isSafeInteger(resolution?.anchorPage) && resolution.anchorPage >= 0 && resolution.anchorPage < pageCount ? resolution.anchorPage : 0;
            const item = {
                token: this.token(),
                kind: "sessionBoard",
                entryId: plan.id,
                position: plan.position,
                set,
                code: this.chosenCode,
                name: sessionSet.name,
                board: Object.freeze({
                    sessionSetId: sessionSet.id,
                    model: resolution?.model ?? null,
                    pageCount,
                    anchorPage,
                    pageDuration: sessionSet.duration,
                    logoItemId: sessionSet.logoItemId,
                    styleItemId: sessionSet.brandStyleItemId ?? project.brandStyleItemId,
                }),
                backing: this.backing(sessionSet.backingItemId ?? project.backingItemId),
                hint: this.hint(kind, sessionSet.duration * pageCount, show),
                pip: this.demoOn,
            };
            return Object.freeze(item);
        }
        const orientation = this.playOrientation(plan);
        const file = orientation === "portrait" ? plan.portrait : plan.landscape;
        if (file === null || !isPlayableType(file.contentType)) {
            this.skipPlan(plan, cursor, "media.not_playable", show, file === null
                ? `entry ${plan.id} has no file to play`
                : `entry ${plan.id}: file ${file.id} is ${file.contentType}, not image or video media`);
            return null;
        }
        const window = playbackWindow(plan.entry, plan.item, file, orientation);
        const video = isVideoType(file.contentType);
        const item = {
            token: this.token(),
            kind: "media",
            entryId: plan.id,
            position: plan.position,
            set,
            code: this.chosenCode,
            name: plan.item.name,
            media: Object.freeze({
                mediaItemId: plan.item.id,
                mediaFileId: file.id,
                contentType: file.contentType,
                codec: file.codec,
                isVideo: video,
                start: window.start,
                duration: window.duration,
                durationSource: window.source,
            }),
            backing: this.backing(project.backingItemId),
            hint: this.hint(kind, video ? watchdogSeconds(window, file) : window.duration, show),
            pip: this.demoOn,
        };
        return Object.freeze(item);
    }
    /**
     * §5.9 — a duration, unless a known interrupt comes first: the next
     * activation of a higher set (interruptFor) replaces the duration.
     */
    hint(kind, seconds, show) {
        const interrupt = this.interruptFor(kind);
        if (interrupt < show + Math.round(seconds * 1000)) {
            return Object.freeze({ kind: "time", at: interrupt });
        }
        return Object.freeze({ kind: "duration", seconds });
    }
    /** §5.10 — a backing media item, resolved in the orientation rendered with no fallback. */
    backing(itemId) {
        return this.layer(itemId, this.rendered ?? ORIENTATION_WHEN_MISSING);
    }
    /** A media item drawn as a layer — a backing, demo branding — resolved in `orientation` with no fallback (§5.7). */
    layer(itemId, orientation) {
        if (itemId === null)
            return null;
        const item = this.snap.mediaItems.get(itemId);
        if (item === undefined)
            return null;
        const fileId = orientation === "portrait" ? item.portraitFileId : item.landscapeFileId;
        const file = fileId === null ? undefined : this.snap.mediaFiles.get(fileId);
        if (file === undefined)
            return null;
        return Object.freeze({ mediaItemId: item.id, mediaFileId: file.id, contentType: file.contentType });
    }
    /** §5.5 — nothing new is produced: the last frame stays, and the marker is armed 2 s out. */
    rearm(show) {
        this.armMarker(show + this.emptyRetryMs, RETRY);
    }
    /** §5.9 — marker 0: the next tick evaluates, whatever the show time's value or sign. */
    forceMarker(reason) {
        this.marker = 0;
        this.markerForced = true;
        this.markerReason = reason;
    }
    /** Arm the marker at a show instant; any tick at or after it evaluates. */
    armMarker(at, reason) {
        this.marker = at;
        this.markerForced = false;
        this.markerReason = reason;
    }
    /** Whether this hold is already recorded: holds are recorded on entry, not on each retry. */
    holding(code) {
        return this.lastStateKind === "hold" && this.lastStateCode === code;
    }
    hold(code, show, message) {
        this.rearm(show);
        this.emit({ showTime: show, kind: "hold", code, message });
    }
    /** §5.2 — an authored blank: clear the screen, once. */
    blank(show) {
        this.rearm(show);
        if (this.currentItem !== null && this.currentItem.kind === "blank")
            return;
        const entry = this.activeEntry;
        const item = Object.freeze({ kind: "blank", token: this.token(), entryId: null, scheduleEntryId: entry.id, pip: this.demoOn });
        this.currentItem = item;
        this.since = show;
        this.pendingItem = null;
        this.issued = item;
        this.emit({ showTime: show, kind: "blank", code: "schedule.blank", message: `schedule entry ${entry.id} has no playlist: showing nothing, as authored` });
    }
    /** A host-reported failure of an issued item: trace it, move the cursor past it, force the next content. */
    skip(item, code, show, why) {
        this.emit({ showTime: show, kind: "skip", code, entryId: item.entryId, message: `entry ${item.entryId} "${item.name}": ${why}` });
        this.cursorOf(item.set).set(item.position, item.entryId);
        this.failed.add(item.entryId);
        this.forceMarker(SKIPPED);
    }
    /** An entry the engine itself cannot put on screen, found while choosing. */
    skipPlan(plan, cursor, code, show, why) {
        this.emit({ showTime: show, kind: "skip", code, entryId: plan.id, message: why });
        cursor.set(plan.position, plan.id);
        this.failed.add(plan.id);
    }
    token() {
        return this.tokenPrefix + ++this.tokenCount;
    }
    // ── inspection ─────────────────────────────────────────────────────────────
    /** A read-only account of what the engine sees at its last tick. Allocates; not for the tick path. */
    inspect() {
        const show = this.show;
        const dayIndex = Number.isFinite(show) ? this.calendar.dayIndexAt(show) : -1;
        const day = dayIndex >= 0 ? this.calendar.days[dayIndex] : null;
        const dayStart = day !== null ? day.startTime : Number.NEGATIVE_INFINITY;
        const playlist = this.activeState === PLAYLIST ? this.snap.playlists.get(this.activePlaylistId) ?? null : null;
        const plans = playlist !== null ? this.plans.get(playlist.id) ?? [] : [];
        const entries = [];
        const standard = [];
        const takeover = [];
        const alert = [];
        let interruptTakeover = Number.POSITIVE_INFINITY;
        let interruptAlert = Number.POSITIVE_INFINITY;
        for (const plan of plans) {
            const passes = this.passesOrientation(plan);
            const orientation = this.rendered;
            const excluded = passes
                ? null
                : plan.board
                    ? "its session set is not in the cartridge"
                    : plan.item === null
                        ? "its media item is not in the cartridge"
                        : orientation === null
                            ? "no file in either slot"
                            : `no ${orientation} file: the slot is empty`;
            const file = passes && !plan.board ? (this.playOrientation(plan) === "portrait" ? plan.portrait : plan.landscape) : null;
            const takeoverOn = passes ? plan.takeover.nextOn(show) : Number.POSITIVE_INFINITY;
            const alertOn = passes ? plan.alert.nextOn(show) : Number.POSITIVE_INFINITY;
            const standardState = passes ? plan.standard.state(show, dayStart) : "none";
            const takeoverState = passes ? plan.takeover.state(show, dayStart) : "none";
            const alertState = passes ? plan.alert.state(show, Number.NEGATIVE_INFINITY) : "none";
            if (passes && alertState === "on")
                alert.push(plan.id);
            else if (passes && alertOn < interruptAlert)
                interruptAlert = alertOn;
            if (passes && takeoverState === "on")
                takeover.push(plan.id);
            else if (passes && takeoverOn < interruptTakeover)
                interruptTakeover = takeoverOn;
            if (passes && standardState === "on")
                standard.push(plan.id);
            entries.push(Object.freeze({
                entryId: plan.id,
                position: plan.position,
                resourceType: plan.entry.resourceType,
                name: plan.name,
                excluded,
                mediaFileId: file?.id ?? null,
                standard: standardState,
                takeover: takeoverState,
                alert: alertState,
                takeoverOnAt: Number.isFinite(takeoverOn) ? takeoverOn : null,
                alertOnAt: Number.isFinite(alertOn) ? alertOn : null,
            }));
        }
        const workingSet = this.activeState === BLANK
            ? "blank"
            : this.activeState !== PLAYLIST
                ? "none"
                : alert.length > 0
                    ? "alert"
                    : takeover.length > 0
                        ? "takeover"
                        : standard.length > 0
                            ? "standard"
                            : "empty";
        const interrupt = workingSet === "standard"
            ? Math.min(interruptTakeover, interruptAlert)
            : workingSet === "takeover" ? interruptAlert : Number.POSITIVE_INFINITY;
        return Object.freeze({
            showNow: show,
            day,
            orientation: this.orientationValue,
            renderedOrientation: this.rendered,
            demo: this.demoValue,
            scheduleEntry: this.activeEntry,
            playlist: playlist !== null ? { id: playlist.id, name: playlist.name } : null,
            nextBoundary: Number.isFinite(this.nextBoundary) ? this.nextBoundary : null,
            entries,
            workingSet,
            rotation: workingSet === "alert" ? alert : workingSet === "takeover" ? takeover : workingSet === "standard" ? standard : [],
            suppressed: workingSet === "alert"
                ? plans.filter((p) => !alert.includes(p.id) && (takeover.includes(p.id) || standard.includes(p.id))).map((p) => p.id)
                : workingSet === "takeover" ? standard.filter((id) => !takeover.includes(id)) : [],
            interruptAt: Number.isFinite(interrupt) ? interrupt : null,
            cursors: {
                standard: this.standardCursor.has ? this.standardCursor.position : null,
                takeover: this.takeoverCursor.has ? this.takeoverCursor.position : null,
                alert: this.alertCursor.has ? this.alertCursor.position : null,
            },
            marker: this.marker,
            markerReason: MARKER_REASONS[this.markerReason],
            current: this.currentItem,
            currentSince: Number.isFinite(this.since) ? this.since : null,
            pending: this.pendingItem,
        });
    }
}
// ── helpers ─────────────────────────────────────────────────────────────────────
function asOrientation(value) {
    return value === "portrait" || value === "landscape" ? value : null;
}
/** §5.2 — the index of the latest entry whose timestamp ≤ show (ties: the higher id, sorted last), or −1. */
function latestAt(timeline, show) {
    let lo = 0, hi = timeline.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (timeline[mid].timestamp <= show)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo - 1;
}
function setName(kind) {
    return kind === ALERT ? "alert" : kind === TAKEOVER ? "takeover" : "standard";
}
function describePlaylist(id) {
    return id === null ? "no playlist" : `playlist ${id}`;
}
function seconds(value) {
    return `${Math.round(value * 1000) / 1000} s`;
}
/** Compiles every playlist of a Snapshot for the viability pass, once per commit. */
function compilePlans(snapshot) {
    const out = new Map();
    const fileOf = (id) => (id === null ? null : snapshot.mediaFiles.get(id) ?? null);
    for (const [playlistId, playlist] of snapshot.playlists) {
        const plans = [];
        for (const entry of playlist.entries) {
            const directives = snapshot.directives.get(entry.id);
            const standard = directives && directives.standard.length > 0 ? new DirectiveSeries(directives.standard) : NO_DIRECTIVES;
            const takeover = directives && directives.takeover.length > 0 ? new DirectiveSeries(directives.takeover) : NO_DIRECTIVES;
            const alert = directives && directives.alert.length > 0 ? new DirectiveSeries(directives.alert) : NO_DIRECTIVES;
            if (entry.resourceType === "session_set") {
                const set = entry.sessionSetId !== null ? snapshot.sessionSets.get(entry.sessionSetId) ?? null : null;
                plans.push(Object.freeze({
                    entry, id: entry.id, position: entry.position, board: true, item: null, set,
                    portrait: null, landscape: null, standard, takeover, alert,
                    name: set?.name ?? `session set ${entry.sessionSetId}`,
                }));
            }
            else {
                const item = entry.mediaItemId !== null ? snapshot.mediaItems.get(entry.mediaItemId) ?? null : null;
                plans.push(Object.freeze({
                    entry, id: entry.id, position: entry.position, board: false, item, set: null,
                    portrait: item !== null ? fileOf(item.portraitFileId) : null,
                    landscape: item !== null ? fileOf(item.landscapeFileId) : null,
                    standard, takeover, alert,
                    name: item?.name ?? `media item ${entry.mediaItemId}`,
                }));
            }
        }
        out.set(playlistId, Object.freeze(plans));
    }
    return out;
}
