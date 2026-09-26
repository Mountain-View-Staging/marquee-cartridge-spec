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
 *     showNow ≥ next schedule boundary → resolve  §5.2; a new playlist cuts
 *     waiting for a first frame?  10 s of monotonic time → skip; else return
 *     showNow ≥ marker → renderNext               §5.9: the only place content changes
 *
 *   renderNext:
 *     viability pass → working set → next entry after the cursor → RenderItem
 *     with a hint; an empty set holds (the last frame stays) and retries in 2 s
 *
 * Nothing on the tick path allocates when nothing changes, and nothing
 * touches a database: the Snapshot is indexed once, when committed.
 */
import { type BoardResolver } from "./board.js";
import type { ShowClock } from "./clock.js";
import type { Orientation, ProjectDay, ResourceType, Snapshot, SurfaceScheduleEntry } from "./model.js";
import type { RenderItem } from "./render.js";
import { type DirectiveState } from "./rules.js";
import type { TraceEvent } from "./trace.js";
import { Calendar } from "./venue-time.js";
/** A host that never reports a first frame for this long (monotonic) has failed to load the item. */
export declare const FIRST_FRAME_TIMEOUT_MS = 10000;
/** §5.5 — an empty working set is evaluated again after this much show time. */
export declare const EMPTY_RETRY_MS = 2000;
/** §8.3 — forward show-clock movement beyond real elapsed time plus this is a jump. */
export declare const JUMP_TOLERANCE_MS = 250;
export interface EngineOptions {
    readonly snapshot: Snapshot;
    /** The playlist lane this engine resolves. A Surface uses its orientation's lane. */
    readonly slot: Orientation;
    /** The orientation files are chosen for (§5.7). The host always supplies it. */
    readonly orientation: Orientation | null | undefined;
    readonly clock: ShowClock;
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
}
export type WorkingSetKind = "none" | "standard" | "takeover" | "empty" | "blank";
export type MarkerReason = "forced" | "natural" | "watchdog" | "interrupt" | "retry" | "completed";
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
    /** When its takeover next turns ON, if it will. */
    readonly takeoverOnAt: number | null;
}
/** A read-only account of the engine at its last tick, for status views. Allocates. */
export interface Inspection {
    readonly showNow: number;
    readonly day: ProjectDay | null;
    readonly slot: Orientation;
    readonly orientation: Orientation | null;
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
    /** Standard entries suppressed by an active takeover. */
    readonly suppressed: readonly number[];
    readonly interruptAt: number | null;
    readonly cursors: {
        readonly standard: number | null;
        readonly takeover: number | null;
    };
    readonly marker: number;
    readonly markerReason: MarkerReason;
    readonly current: RenderItem | null;
    readonly currentSince: number | null;
    readonly pending: RenderItem | null;
}
/** Creates an engine for one committed Snapshot, one lane and one orientation. */
export declare function createEngine(options: EngineOptions): SurfaceEngine;
export declare class SurfaceEngine {
    private snap;
    private calendar;
    private plans;
    private lane;
    private readonly clock;
    private readonly boardResolver;
    private readonly firstFrameTimeoutMs;
    private readonly emptyRetryMs;
    private laneSlot;
    private orientationValue;
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
    private readonly standardCursor;
    private readonly takeoverCursor;
    private lastSet;
    /** Entries that failed since the last first frame: when it covers the working set, hold. */
    private readonly failed;
    private marker;
    private markerReason;
    private currentItem;
    private since;
    private pendingItem;
    private pendingMono;
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
    private interruptAt;
    private chosenCode;
    private readonly out;
    constructor(options: EngineOptions);
    get snapshot(): Snapshot;
    get slot(): Orientation;
    get orientation(): Orientation | null;
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
     * The host's orientation changed (§5.1, §6): cut and re-resolve at the next
     * tick. The lane follows the orientation when it was the orientation's own.
     */
    setOrientation(orientation: Orientation | null | undefined): readonly TraceEvent[];
    /** A new cartridge is committed: reset all state and cut at the next tick (§5.9). */
    commit(snapshot: Snapshot): readonly TraceEvent[];
    private output;
    private emit;
    private install;
    private afterCommit;
    private afterOrientationChange;
    private jump;
    /**
     * §5.2 — within the lane, the latest entry whose timestamp ≤ showNow. A
     * boundary that keeps the playlist does nothing; one that changes it resets
     * both cursors and forces the next content.
     */
    private resolveSchedule;
    /** The marker is reached: the current content ends, and the next is chosen. */
    private evaluate;
    private renderNext;
    /**
     * §5.3 — the viability pass: day → orientation → directives, cheapest
     * first. Fills the two sets in position order, and while standard would
     * rule, the earliest future takeover activation (§5.9 interruptAt).
     */
    private pass;
    /** §5.3 step 2 — an empty slot for this orientation excludes a media entry. */
    private passesOrientation;
    /** The orientation whose slot supplies the file (§5.7); without an orientation, the lane's own first. */
    private playOrientation;
    /** §5.6 — the first entry after the cursor, wrapping; the first entry with no cursor. */
    private choose;
    private allFailed;
    /** The RenderItem for a chosen entry, or null when the entry is skipped on the spot. */
    private build;
    /**
     * §5.9 — a duration, unless a known interrupt comes first: while the
     * standard set rules, the next takeover activation replaces the duration.
     */
    private hint;
    /** §5.10 — a backing media item, resolved by orientation with no fallback. */
    private backing;
    /** §5.5 — nothing new is produced: the last frame stays, and the marker is armed 2 s out. */
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
