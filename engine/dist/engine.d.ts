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
import { type BoardResolver } from "./board.js";
import type { ShowClock } from "./clock.js";
import type { Orientation, ProjectDay, ResourceType, Snapshot, SurfaceScheduleEntry } from "./model.js";
import type { DemoState, RenderItem } from "./render.js";
import { type DirectiveState } from "./rules.js";
import type { TraceEvent } from "./trace.js";
import { Calendar } from "./venue-time.js";
/** A host that never reports a first frame for this long (monotonic) has failed to load the item. */
export declare const FIRST_FRAME_TIMEOUT_MS = 10000;
/** §5.5 — an empty working set is evaluated again after this much show time. */
export declare const EMPTY_RETRY_MS = 2000;
/** §8.3 — forward show-clock movement beyond real elapsed time plus this is a jump. */
export declare const JUMP_TOLERANCE_MS = 250;
/**
 * §5.14 — with no orientation from the host, the gate is skipped, and each entry
 * plays this orientation's file, else the other one; backings and demo branding
 * resolve in it. Landscape, as §6's Automatic reads a display that is not taller
 * than it is wide.
 */
export declare const ORIENTATION_WHEN_MISSING: Orientation;
export interface EngineOptions {
    readonly snapshot: Snapshot;
    /**
     * The orientation the device renders (§6). The host always supplies it. The
     * schedule is the same whatever it is (§5.1): it decides which entries pass
     * the orientation gate and which file of each plays (§5.3, §5.7).
     */
    readonly orientation: Orientation | null | undefined;
    readonly clock: ShowClock;
    /**
     * True on a host that runs the DemoStation mode (§5.11). The engine then
     * resolves the `demo_station` slot too, and while a demo is on it plays the
     * same playlist in the picture-in-picture, in the opposite orientation
     * (`TickOutput.demo`, `RenderItem.pip`). Otherwise the slot is ignored.
     */
    readonly demoStation?: boolean;
    /** Defaults to the minimal one-page resolver. */
    readonly boardResolver?: BoardResolver;
    readonly firstFrameTimeoutMs?: number;
    readonly emptyRetryMs?: number;
}
/**
 * What one tick produced. The object is reused by the next tick (so a tick
 * that changes nothing allocates nothing): read it before ticking again.
 */
export interface TickOutput {
    readonly showNow: number;
    /** True when the show clock is not real venue time: synthetic Day 1, or a preview. */
    readonly projected: boolean;
    /** A new item to put on screen, or null. An empty working set produces none: the last frame stays. */
    readonly renderItem: RenderItem | null;
    readonly trace: readonly TraceEvent[];
    /**
     * While a DemoStation's demo is on (§5.11): its branding. The demo fills the
     * screen, and every item plays in the picture-in-picture (`pip`). Null
     * otherwise, and always on a host without the DemoStation mode.
     */
    readonly demo: DemoState | null;
}
export type WorkingSetKind = "none" | "standard" | "takeover" | "alert" | "empty" | "blank";
export type MarkerReason = "forced" | "natural" | "watchdog" | "interrupt" | "retry" | "completed" | "skipped";
export interface EntryInspection {
    readonly entryId: number;
    readonly position: number;
    readonly resourceType: ResourceType;
    readonly name: string;
    /** Why the entry is out before its directives are read, or null when it passed the orientation gate. */
    readonly excluded: string | null;
    readonly mediaFileId: number | null;
    readonly standard: DirectiveState;
    readonly takeover: DirectiveState;
    /** Its alert directives' state: over the whole timeline, never day-scoped (§5.4). */
    readonly alert: DirectiveState;
    /** When its takeover next turns ON, if it will. */
    readonly takeoverOnAt: number | null;
    /** When its alert next turns ON, if it will. */
    readonly alertOnAt: number | null;
}
/** A read-only account of the engine at its last tick, for status views. Allocates. */
export interface Inspection {
    readonly showNow: number;
    readonly day: ProjectDay | null;
    /** The device's orientation, as the host set it (§6). */
    readonly orientation: Orientation | null;
    /** The orientation whose files play (§5.1): the device's, or the opposite in a DemoStation's picture-in-picture. */
    readonly renderedOrientation: Orientation | null;
    /** A DemoStation's demo, while it is on (§5.11). */
    readonly demo: DemoState | null;
    /** The active `playlist` schedule entry (§5.2). */
    readonly scheduleEntry: SurfaceScheduleEntry | null;
    readonly playlist: {
        readonly id: number;
        readonly name: string;
    } | null;
    readonly nextBoundary: number | null;
    readonly entries: readonly EntryInspection[];
    readonly workingSet: WorkingSetKind;
    /** Entry ids of the working set, in rotation order. */
    readonly rotation: readonly number[];
    /** Entries a higher set suppresses: standard ones under a takeover; standard and takeover ones under an alert. */
    readonly suppressed: readonly number[];
    /** The next activation that cuts what rules: an alert's or a takeover's under standard, an alert's under a takeover. */
    readonly interruptAt: number | null;
    readonly cursors: {
        readonly standard: number | null;
        readonly takeover: number | null;
        readonly alert: number | null;
    };
    readonly marker: number;
    readonly markerReason: MarkerReason;
    readonly current: RenderItem | null;
    readonly currentSince: number | null;
    readonly pending: RenderItem | null;
}
/**
 * Creates an engine for one committed Snapshot and one device. Options carrying
 * a `slot` — an earlier draft's schedule per orientation — are refused with a
 * TypeError, so a host written for that draft fails loudly.
 */
export declare function createEngine(options: EngineOptions): SurfaceEngine;
export declare class SurfaceEngine {
    private snap;
    private calendar;
    private plans;
    /** The `playlist` slot: the one schedule (§5.2). */
    private lane;
    /** The `demo_station` slot on a DemoStation host (§5.11); empty otherwise. */
    private demoLane;
    private readonly demoStation;
    private readonly clock;
    private readonly boardResolver;
    private readonly firstFrameTimeoutMs;
    private readonly emptyRetryMs;
    /** The device's orientation (§6). */
    private orientationValue;
    /** The orientation whose files play (§5.1): the device's, or the opposite during a demo (§5.11). */
    private rendered;
    private readonly tokenPrefix;
    private tokenCount;
    private show;
    private lastShow;
    private lastMono;
    private activeEntry;
    private activeState;
    private activePlaylistId;
    private activeFrom;
    private nextBoundary;
    private mustResolve;
    private resolveCause;
    private demoEntry;
    private demoOn;
    private demoValue;
    private readonly standardCursor;
    private readonly takeoverCursor;
    private readonly alertCursor;
    private lastSet;
    /** Entries that failed since an item last finished its time: when it covers the working set, hold. */
    private readonly failed;
    private marker;
    private markerForced;
    private markerReason;
    private currentItem;
    private since;
    /** Whether the current item's reports still count: from its first frame until its time is over or it is cut. */
    private currentLive;
    private pendingItem;
    private pendingMono;
    /** The activation known to cut the pending item when it was chosen: a takeover's or an alert's (§5.9). */
    private pendingInterruptAt;
    /** Which of the two that activation is, for the trace's words. */
    private pendingInterruptByAlert;
    private issued;
    private events;
    private lastStateKind;
    private lastStateCode;
    private orientationWarned;
    private orientationChanged;
    private previousOrientation;
    private incoming;
    private committing;
    private readonly standardList;
    private readonly takeoverList;
    private readonly alertList;
    /** The earliest future activations among the viable entries (§5.9), from the last pass. */
    private nextTakeoverOn;
    private nextAlertOn;
    private chosenCode;
    private readonly out;
    constructor(options: EngineOptions);
    get snapshot(): Snapshot;
    /** The device's orientation (§6). */
    get orientation(): Orientation | null;
    /** The orientation whose files play (§5.1): the device's, or the opposite in a DemoStation's picture-in-picture. */
    get renderedOrientation(): Orientation | null;
    /** A DemoStation's demo, while it is on (§5.11). */
    get demo(): DemoState | null;
    /** The show clock at the last tick. */
    get showNow(): number;
    /** What is on screen: the last item that reported its first frame, or the blank. */
    get current(): RenderItem | null;
    /** The show time of the current item's first frame (board pages are timed from it). */
    get currentSince(): number;
    /** The item issued and awaiting its first frame. */
    get pending(): RenderItem | null;
    get venueCalendar(): Calendar;
    tick(wallMs: number, monoMs: number): TickOutput;
    /** The item's first frame is on screen: arm the marker from its hint. */
    onFirstFrame(token: string): readonly TraceEvent[];
    /** The media reached the end of its window: evaluate the next content at the next tick. */
    onMediaCompleted(token: string): readonly TraceEvent[];
    /** The host could not show the item: skip it and move on. */
    onLoadFailed(token: string, reason?: string): readonly TraceEvent[];
    /**
     * The device's orientation changed (§5.1, §6): the operator set it, or the
     * driven display turned. At the next tick the engine cuts, keeps both
     * cursors — the playlist is the same — and continues with the new
     * orientation's files. During a demo the picture-in-picture turns with it.
     */
    setOrientation(orientation: Orientation | null | undefined): readonly TraceEvent[];
    /** A new cartridge is committed: reset all state and cut at the next tick (§5.9). */
    commit(snapshot: Snapshot): readonly TraceEvent[];
    private output;
    private emit;
    private install;
    private afterCommit;
    /**
     * §5.1 — a rotation. The schedule does not depend on the orientation, so the
     * playlist is the same and both cursors are kept; the entry on screen is cut,
     * and the next pass runs in the new orientation. A schedule boundary reached
     * in the same tick is a cause of its own, recorded by the resolution.
     */
    private afterOrientationChange;
    private jump;
    /**
     * §5.2 — the latest `playlist` entry whose timestamp ≤ showNow, and on a
     * DemoStation host the latest `demo_station` entry (§5.11). A boundary that
     * keeps the playlist and the mode does nothing but update the demo branding.
     * One that changes the playlist resets both cursors; one that starts or ends a
     * demo moves the rotation between the full screen and the picture-in-picture
     * and keeps them. Either cuts and forces the next content.
     */
    private resolveSchedule;
    /** §5.1, §5.11 — the orientation whose files play: the device's, or its opposite while a demo is on. */
    private updateRendered;
    /** §5.11 — the active `demo_station` entry, and its branding in the device's own orientation while it turns the demo on. */
    private updateDemo;
    /** The marker is reached: the current content ends, and the next is chosen. */
    private evaluate;
    private renderNext;
    /**
     * §5.3 — the viability pass, for each entry: the orientation gate, then its
     * alert directives over the whole timeline, then — scoped to the day — its
     * takeover and standard directives. Fills the three sets in position order,
     * and the earliest future activation of each higher set (§5.9 interrupts).
     */
    private pass;
    /**
     * §5.9 — the activation that cuts an item of this set: under standard, the
     * next takeover or alert; under a takeover, the next alert; nothing cuts an alert.
     */
    private interruptFor;
    /** §5.6 — the cursor of an item's set. */
    private cursorOf;
    /** §5.3 step 2 — an empty slot for the orientation rendered excludes a media entry. */
    private passesOrientation;
    /** The orientation whose slot supplies the file (§5.7); without an orientation, landscape's first (§5.14). */
    private playOrientation;
    /** §5.6 — the first entry after the cursor, wrapping; the first entry with no cursor. */
    private choose;
    /** Set.prototype.clear allocates a new table even when empty: keep the idle paths allocation-free. */
    private clearFailures;
    private allFailed;
    /** The RenderItem for a chosen entry, or null when the entry is skipped on the spot. */
    private build;
    /**
     * §5.9 — a duration, unless a known interrupt comes first: the next
     * activation of a higher set (interruptFor) replaces the duration.
     */
    private hint;
    /** §5.10 — a backing media item, resolved in the orientation rendered with no fallback. */
    private backing;
    /** A media item drawn as a layer — a backing, demo branding — resolved in `orientation` with no fallback (§5.7). */
    private layer;
    /** §5.5 — nothing new is produced: the last frame stays, and the marker is armed 2 s out. */
    private rearm;
    /** §5.9 — marker 0: the next tick evaluates, whatever the show time's value or sign. */
    private forceMarker;
    /** Arm the marker at a show instant; any tick at or after it evaluates. */
    private armMarker;
    /** Whether this hold is already recorded: holds are recorded on entry, not on each retry. */
    private holding;
    private hold;
    /** §5.2 — an authored blank: clear the screen, once. */
    private blank;
    /** A host-reported failure of an issued item: trace it, move the cursor past it, force the next content. */
    private skip;
    /** An entry the engine itself cannot put on screen, found while choosing. */
    private skipPlan;
    private token;
    /** A read-only account of what the engine sees at its last tick. Allocates; not for the tick path. */
    inspect(): Inspection;
}
