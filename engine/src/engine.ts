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

import { minimalBoardResolver, type BoardResolution, type BoardResolver } from "./board.js";
import type { ShowClock } from "./clock.js";
import type {
  MediaFile,
  MediaItem,
  Orientation,
  PlaylistEntry,
  ProjectDay,
  ResourceType,
  SessionSet,
  SessionSetEntry,
  Snapshot,
  SurfaceScheduleEntry,
} from "./model.js";
import type {
  Backing,
  BlankRenderItem,
  BoardRenderItem,
  Hint,
  MediaRenderItem,
  PlayableRenderItem,
  RenderItem,
} from "./render.js";
import {
  DirectiveSeries,
  NO_DIRECTIVES,
  isPlayableType,
  isVideoType,
  playbackWindow,
  watchdogSeconds,
  type DirectiveState,
} from "./rules.js";
import type { HoldCode, RenderCode, RotationSet, SkipCode, TraceCode, TraceEvent, TraceKind } from "./trace.js";
import { Calendar } from "./venue-time.js";

/** A host that never reports a first frame for this long (monotonic) has failed to load the item. */
export const FIRST_FRAME_TIMEOUT_MS = 10_000;
/** §5.5 — an empty working set is evaluated again after this much show time. */
export const EMPTY_RETRY_MS = 2_000;
/** §8.3 — forward show-clock movement beyond real elapsed time plus this is a jump. */
export const JUMP_TOLERANCE_MS = 250;

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
  readonly playlist: { readonly id: number; readonly name: string } | null;
  readonly nextBoundary: number | null;
  readonly entries: readonly EntryInspection[];
  readonly workingSet: WorkingSetKind;
  /** Entry ids of the working set, in rotation order. */
  readonly rotation: readonly number[];
  /** Standard entries suppressed by an active takeover. */
  readonly suppressed: readonly number[];
  readonly interruptAt: number | null;
  readonly cursors: { readonly standard: number | null; readonly takeover: number | null };
  readonly marker: number;
  readonly markerReason: MarkerReason;
  readonly current: RenderItem | null;
  readonly currentSince: number | null;
  readonly pending: RenderItem | null;
}

// Working-set kinds, marker reasons and schedule states, as small integers.
const NONE = 0, STANDARD = 1, TAKEOVER = 2, EMPTY = 3;
const FORCED = 0, NATURAL = 1, WATCHDOG = 2, INTERRUPT = 3, RETRY = 4, COMPLETED = 5;
const UNRESOLVED = 0, NOTHING = 1, BLANK = 2, PLAYLIST = 3;
const MARKER_REASONS: readonly MarkerReason[] = ["forced", "natural", "watchdog", "interrupt", "retry", "completed"];

type ResolveCause = "boot" | "boundary" | "jump" | "orientation" | "commit";

const NO_EVENTS: readonly TraceEvent[] = Object.freeze([]);
const NO_SET_ENTRIES: readonly SessionSetEntry[] = Object.freeze([]);

/** One playlist entry, compiled for the viability pass. */
interface EntryPlan {
  readonly entry: PlaylistEntry;
  readonly id: number;
  readonly position: number;
  readonly board: boolean;
  readonly item: MediaItem | null;
  readonly set: SessionSet | null;
  readonly portrait: MediaFile | null;
  readonly landscape: MediaFile | null;
  readonly standard: DirectiveSeries;
  readonly takeover: DirectiveSeries;
  readonly name: string;
}

/** §5.6 — a rotation cursor: the authored position of the last entry shown (id breaks ties). */
class Cursor {
  has = false;
  position = 0;
  entryId = 0;

  clear(): void {
    this.has = false;
  }

  set(position: number, entryId: number): void {
    this.has = true;
    this.position = position;
    this.entryId = entryId;
  }

  isBefore(plan: EntryPlan): boolean {
    return plan.position > this.position || (plan.position === this.position && plan.id > this.entryId);
  }
}

let engines = 0;

/** Creates an engine for one committed Snapshot, one lane and one orientation. */
export function createEngine(options: EngineOptions): SurfaceEngine {
  return new SurfaceEngine(options);
}

export class SurfaceEngine {
  private snap: Snapshot;
  private calendar: Calendar;
  private plans: Map<number, readonly EntryPlan[]>;
  private lane: readonly SurfaceScheduleEntry[];
  private readonly clock: ShowClock;
  private readonly boardResolver: BoardResolver;
  private readonly firstFrameTimeoutMs: number;
  private readonly emptyRetryMs: number;
  private laneSlot: Orientation;
  private orientationValue: Orientation | null;
  private readonly tokenPrefix: string;
  private tokenCount = 0;

  // The show clock at this tick and the previous one (§8.3).
  private show = Number.NaN;
  private lastShow = Number.NaN;
  private lastMono = Number.NaN;

  // The schedule (§5.2).
  private activeEntry: SurfaceScheduleEntry | null = null;
  private activeState = UNRESOLVED;
  private activePlaylistId: number | null = null;
  private activeFrom = Number.NEGATIVE_INFINITY;
  private nextBoundary = Number.POSITIVE_INFINITY;
  private mustResolve = true;
  private resolveCause: ResolveCause = "boot";

  // Rotation (§5.5, §5.6).
  private readonly standardCursor = new Cursor();
  private readonly takeoverCursor = new Cursor();
  private lastSet = NONE;
  /** Entries that failed since the last first frame: when it covers the working set, hold. */
  private readonly failed = new Set<number>();

  // The one render marker (§5.9).
  private marker = 0;
  private markerReason = FORCED;

  private currentItem: RenderItem | null = null;
  private since = Number.NaN;
  private pendingItem: PlayableRenderItem | null = null;
  private pendingMono = Number.NaN;
  private issued: RenderItem | null = null;

  private events: TraceEvent[] | null = null;
  private lastStateKind: TraceKind | null = null;
  private lastStateCode: TraceCode | null = null;
  private orientationWarned = false;

  // Host events applied at the next tick, so they share its showNow.
  private orientationChanged = false;
  private previousOrientation: Orientation | null = null;
  private incoming: Snapshot | null = null;
  private committing = false;

  // Buffers of the viability pass, reused.
  private readonly standardList: EntryPlan[] = [];
  private readonly takeoverList: EntryPlan[] = [];
  private interruptAt = Number.POSITIVE_INFINITY;
  private chosenCode: RenderCode = "rotation.start";

  private readonly out: { showNow: number; projected: boolean; renderItem: RenderItem | null; trace: readonly TraceEvent[] } = {
    showNow: 0,
    projected: false,
    renderItem: null,
    trace: NO_EVENTS,
  };

  constructor(options: EngineOptions) {
    const { snapshot, slot, clock } = options;
    if (!snapshot || snapshot.kind !== "surface") throw new TypeError("createEngine needs a surface Snapshot (loadCartridge)");
    if (slot !== "portrait" && slot !== "landscape") throw new TypeError(`createEngine: slot must be 'portrait' or 'landscape', not ${String(slot)}`);
    if (!clock || typeof clock.now !== "function") throw new TypeError("createEngine needs a show clock (surfaceClock() or previewClock())");
    this.snap = snapshot;
    this.calendar = new Calendar(snapshot.days, snapshot.meta.timezone);
    this.plans = compilePlans(snapshot);
    this.laneSlot = slot;
    this.lane = snapshot.scheduleBySlot[slot];
    this.orientationValue = asOrientation(options.orientation);
    this.clock = clock;
    this.boardResolver = options.boardResolver ?? minimalBoardResolver;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
    this.emptyRetryMs = options.emptyRetryMs ?? EMPTY_RETRY_MS;
    this.tokenPrefix = `e${++engines}.`;
  }

  get snapshot(): Snapshot {
    return this.incoming ?? this.snap;
  }
  get slot(): Orientation {
    return this.laneSlot;
  }
  get orientation(): Orientation | null {
    return this.orientationValue;
  }
  /** The show clock at the last tick. */
  get showNow(): number {
    return this.show;
  }
  /** What is on screen: the last item that reported its first frame, or the blank. */
  get current(): RenderItem | null {
    return this.currentItem;
  }
  /** The show time of the current item's first frame (board pages are timed from it). */
  get currentSince(): number {
    return this.since;
  }
  /** The item issued and awaiting its first frame. */
  get pending(): RenderItem | null {
    return this.pendingItem;
  }
  get venueCalendar(): Calendar {
    return this.calendar;
  }

  // ── host → engine ──────────────────────────────────────────────────────────

  tick(wallMs: number, monoMs: number): TickOutput {
    this.events = null;
    this.issued = null;
    if (this.incoming !== null) this.install();
    const show = this.clock.now(wallMs, monoMs, this.calendar);
    this.show = show;
    if (this.committing) this.afterCommit(show);
    if (this.orientationChanged) this.afterOrientationChange(show);

    // §8.3 — a move the monotonic clock cannot explain is a jump.
    if (this.lastShow === this.lastShow) {
      const moved = show - this.lastShow;
      if (moved < 0) this.jump("jump.backward", show);
      else if (moved - (monoMs - this.lastMono) > JUMP_TOLERANCE_MS) this.jump("jump.forward", show);
    }
    this.lastShow = show;
    this.lastMono = monoMs;

    if (this.mustResolve || show >= this.nextBoundary || show < this.activeFrom) this.resolveSchedule(show);

    if (this.pendingItem !== null) {
      if (monoMs - this.pendingMono < this.firstFrameTimeoutMs) return this.output(show, wallMs);
      const late = this.pendingItem;
      this.pendingItem = null;
      this.skip(late, "media.no_first_frame", show, `no first frame within ${this.firstFrameTimeoutMs / 1000} s`);
    }

    if (show >= this.marker) this.evaluate(show, monoMs);
    return this.output(show, wallMs);
  }

  /** The item's first frame is on screen: arm the marker from its hint. */
  onFirstFrame(token: string): readonly TraceEvent[] {
    this.events = null;
    const item = this.pendingItem;
    if (item === null || item.token !== token) return NO_EVENTS;
    this.pendingItem = null;
    const show = this.show;
    this.currentItem = item;
    this.since = show;
    if (item.hint.kind === "time") {
      this.marker = item.hint.at;
      this.markerReason = INTERRUPT;
    } else {
      this.marker = show + Math.round(item.hint.seconds * 1000);
      this.markerReason = item.kind === "media" && item.media.isVideo ? WATCHDOG : NATURAL;
    }
    (item.set === "takeover" ? this.takeoverCursor : this.standardCursor).set(item.position, item.entryId);
    this.failed.clear();
    const hint = item.hint.kind === "time"
      ? `until ${this.calendar.format(item.hint.at)}, when a takeover starts`
      : item.kind === "media" && item.media.isVideo
        ? item.media.duration === null
          ? "to the end of the clip"
          : `for ${seconds(item.media.duration)} (${item.media.durationSource})`
        : item.kind === "media"
          ? `for ${seconds(item.hint.seconds)} (${item.media.durationSource})`
          : `for ${seconds(item.hint.seconds)} (${item.board.pageCount} × ${seconds(item.board.pageDuration)})`;
    const what = item.kind === "media" ? `file ${item.media.mediaFileId}` : `the session board of set ${item.board.sessionSetId}`;
    this.emit(item.kind === "media"
      ? { showTime: show, kind: "render", code: item.code, entryId: item.entryId, set: item.set, mediaFileId: item.media.mediaFileId, message: `entry ${item.entryId} "${item.name}": ${what}, ${item.set} rotation, ${hint}` }
      : { showTime: show, kind: "render", code: item.code, entryId: item.entryId, set: item.set, sessionSetId: item.board.sessionSetId, message: `entry ${item.entryId} "${item.name}": ${what}, ${item.set} rotation, ${hint}` });
    return this.events ?? NO_EVENTS;
  }

  /** The media reached the end of its window: evaluate the next content at the next tick. */
  onMediaCompleted(token: string): readonly TraceEvent[] {
    this.events = null;
    const item = this.currentItem;
    if (item !== null && item.kind !== "blank" && item.token === token) {
      this.marker = 0;
      this.markerReason = COMPLETED;
    }
    return NO_EVENTS;
  }

  /** The host could not show the item: skip it and move on. */
  onLoadFailed(token: string, reason?: string): readonly TraceEvent[] {
    this.events = null;
    const why = reason ? `load failed: ${reason}` : "load failed";
    if (this.pendingItem !== null && this.pendingItem.token === token) {
      const item = this.pendingItem;
      this.pendingItem = null;
      this.skip(item, "media.load_failed", this.show, why);
    } else if (this.currentItem !== null && this.currentItem.kind !== "blank" && this.currentItem.token === token) {
      this.skip(this.currentItem, "media.load_failed", this.show, why);
    }
    return this.events ?? NO_EVENTS;
  }

  /**
   * The host's orientation changed (§5.1, §6): cut and re-resolve at the next
   * tick. The lane follows the orientation when it was the orientation's own.
   */
  setOrientation(orientation: Orientation | null | undefined): readonly TraceEvent[] {
    this.events = null;
    const next = asOrientation(orientation);
    if (next === this.orientationValue) return NO_EVENTS;
    const previous = this.orientationValue;
    if (next !== null && previous !== null && this.laneSlot === previous) this.laneSlot = next;
    if (!this.orientationChanged) this.previousOrientation = previous;
    this.orientationValue = next;
    this.orientationChanged = true;
    return NO_EVENTS;
  }

  /** A new cartridge is committed: reset all state and cut at the next tick (§5.9). */
  commit(snapshot: Snapshot): readonly TraceEvent[] {
    this.events = null;
    if (!snapshot || snapshot.kind !== "surface") throw new TypeError("commit needs a surface Snapshot");
    this.incoming = snapshot;
    return NO_EVENTS;
  }

  // ── the tick's parts ───────────────────────────────────────────────────────

  private output(show: number, wall: number): TickOutput {
    const out = this.out;
    out.showNow = show;
    out.projected = this.clock.kind === "preview" || show !== wall;
    out.renderItem = this.issued;
    out.trace = this.events ?? NO_EVENTS;
    return out;
  }

  private emit(event: TraceEvent): void {
    (this.events ??= []).push(event);
    if (event.kind === "render" || event.kind === "hold" || event.kind === "blank") {
      this.lastStateKind = event.kind;
      this.lastStateCode = event.code;
    }
  }

  private install(): void {
    const snapshot = this.incoming!;
    this.incoming = null;
    this.snap = snapshot;
    this.calendar = new Calendar(snapshot.days, snapshot.meta.timezone);
    this.plans = compilePlans(snapshot);
    this.lane = snapshot.scheduleBySlot[this.laneSlot];
    this.committing = true;
    // A new calendar is not a clock movement.
    this.lastShow = Number.NaN;
    this.lastMono = Number.NaN;
  }

  private afterCommit(show: number): void {
    this.committing = false;
    const on = this.currentItem;
    if (on !== null && on.kind !== "blank") {
      this.emit({ showTime: show, kind: "cut", code: "cartridge.commit", entryId: on.entryId, message: `revision ${this.snap.meta.publishedRevision} of the cartridge is committed; everything restarts` });
    }
    this.currentItem = null;
    this.since = Number.NaN;
    this.pendingItem = null;
    this.standardCursor.clear();
    this.takeoverCursor.clear();
    this.lastSet = NONE;
    this.failed.clear();
    this.activeEntry = null;
    this.activeState = UNRESOLVED;
    this.activePlaylistId = null;
    this.activeFrom = Number.NEGATIVE_INFINITY;
    this.nextBoundary = Number.POSITIVE_INFINITY;
    this.mustResolve = true;
    this.resolveCause = "commit";
    this.marker = 0;
    this.markerReason = FORCED;
    this.lastStateKind = null;
    this.lastStateCode = null;
  }

  private afterOrientationChange(show: number): void {
    this.orientationChanged = false;
    const on = this.currentItem;
    if (on !== null && on.kind !== "blank") {
      this.emit({ showTime: show, kind: "cut", code: "orientation.change", entryId: on.entryId, message: `orientation ${this.previousOrientation ?? "missing"} → ${this.orientationValue ?? "missing"}` });
    }
    this.pendingItem = null;
    this.failed.clear();
    this.lane = this.snap.scheduleBySlot[this.laneSlot];
    this.mustResolve = true;
    if (this.resolveCause === "boundary") this.resolveCause = "orientation";
    this.marker = 0;
    this.markerReason = FORCED;
    if (this.orientationValue !== null) this.orientationWarned = false;
  }

  private jump(code: "jump.backward" | "jump.forward", show: number): void {
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
    this.marker = 0;
    this.markerReason = FORCED;
    this.pendingItem = null;
    this.mustResolve = true;
    if (this.resolveCause === "boundary") this.resolveCause = "jump";
  }

  /**
   * §5.2 — within the lane, the latest entry whose timestamp ≤ showNow. A
   * boundary that keeps the playlist does nothing; one that changes it resets
   * both cursors and forces the next content.
   */
  private resolveSchedule(show: number): void {
    const lane = this.lane;
    let lo = 0, hi = lane.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lane[mid]!.timestamp <= show) lo = mid + 1;
      else hi = mid;
    }
    const entry = lo > 0 ? lane[lo - 1]! : null;
    this.activeEntry = entry;
    this.activeFrom = entry !== null ? entry.timestamp : Number.NEGATIVE_INFINITY;
    this.nextBoundary = lo < lane.length ? lane[lo]!.timestamp : Number.POSITIVE_INFINITY;
    const cause = this.resolveCause;
    this.mustResolve = false;
    this.resolveCause = "boundary";

    const state = entry === null ? NOTHING : entry.playlistId === null ? BLANK : PLAYLIST;
    const playlistId = entry !== null ? entry.playlistId : null;
    if (state === this.activeState && playlistId === this.activePlaylistId) return;

    const on = this.currentItem;
    if (cause === "boundary" && this.activeState !== UNRESOLVED && on !== null && on.kind !== "blank") {
      this.emit({
        showTime: show,
        kind: "cut",
        code: "schedule.change",
        entryId: on.entryId,
        message: `schedule entry ${entry?.id} at ${this.calendar.format(show)}: ${describePlaylist(this.activePlaylistId)} → ${describePlaylist(playlistId)}`,
      });
    }
    this.activeState = state;
    this.activePlaylistId = playlistId;
    this.standardCursor.clear();
    this.takeoverCursor.clear();
    this.lastSet = NONE;
    this.failed.clear();
    this.pendingItem = null;
    this.marker = 0;
    this.markerReason = FORCED;
  }

  /** The marker is reached: the current content ends, and the next is chosen. */
  private evaluate(show: number, mono: number): void {
    const reason = this.markerReason;
    const on = this.currentItem;
    if (reason === WATCHDOG && on !== null && on.kind === "media") {
      this.emit({ showTime: show, kind: "skip", code: "media.watchdog", entryId: on.entryId, message: `entry ${on.entryId}: the video did not report its end within ${seconds(on.hint.kind === "duration" ? on.hint.seconds : 0)}` });
    }
    this.renderNext(show, mono, reason);
  }

  private renderNext(show: number, mono: number, reason: number): void {
    if (this.orientationValue === null && !this.orientationWarned) {
      this.orientationWarned = true;
      this.emit({ showTime: show, kind: "warning", code: "orientation.missing", message: "the host supplied no orientation; the orientation gate is skipped" });
    }
    if (this.activeState === BLANK) {
      this.blank(show);
      return;
    }
    const plans = this.activeState === PLAYLIST ? this.plans.get(this.activePlaylistId!) : undefined;
    if (plans === undefined) {
      this.lastSet = EMPTY;
      this.hold("set.empty", show, this.activeState === PLAYLIST
        ? `playlist ${this.activePlaylistId} is not in the cartridge; the last frame stays`
        : `nothing is scheduled on the ${this.laneSlot} lane at ${this.calendar.format(show)}; the last frame stays`);
      return;
    }

    this.pass(show, plans);
    const kind = this.takeoverList.length > 0 ? TAKEOVER : this.standardList.length > 0 ? STANDARD : EMPTY;
    if (kind === TAKEOVER && this.lastSet !== TAKEOVER) this.takeoverCursor.clear(); // a takeover period begins
    const on = this.currentItem;
    if (reason === INTERRUPT && kind === TAKEOVER && on !== null && on.kind !== "blank") {
      this.emit({ showTime: show, kind: "cut", code: "takeover.activate", entryId: on.entryId, message: `a takeover starts at ${this.calendar.format(show)}; entry ${on.entryId} ends now` });
    }
    this.lastSet = kind;
    if (kind === EMPTY) {
      this.failed.clear();
      this.hold("set.empty", show, `no entry of playlist ${this.activePlaylistId} is viable at ${this.calendar.format(show)}; the last frame stays`);
      return;
    }

    const list = kind === TAKEOVER ? this.takeoverList : this.standardList;
    const cursor = kind === TAKEOVER ? this.takeoverCursor : this.standardCursor;
    for (;;) {
      if (this.allFailed(list)) {
        this.failed.clear();
        this.hold("set.all_failed", show, `every entry of the ${kind === TAKEOVER ? "takeover" : "standard"} set failed in a row; trying again in ${seconds(this.emptyRetryMs / 1000)}`);
        return;
      }
      const plan = list[this.choose(list, cursor)]!;
      const item = this.build(plan, kind, cursor, show);
      if (item === null) continue; // skipped; the skip moved the cursor
      this.pendingItem = item;
      this.pendingMono = mono;
      this.issued = item;
      return;
    }
  }

  /**
   * §5.3 — the viability pass: day → orientation → directives, cheapest
   * first. Fills the two sets in position order, and while standard would
   * rule, the earliest future takeover activation (§5.9 interruptAt).
   */
  private pass(show: number, plans: readonly EntryPlan[]): void {
    const dayIndex = this.calendar.dayIndexAt(show);
    const dayStart = dayIndex >= 0 ? this.calendar.days[dayIndex]!.startTime : Number.NEGATIVE_INFINITY;
    const standard = this.standardList;
    const takeover = this.takeoverList;
    standard.length = 0;
    takeover.length = 0;
    let interrupt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      if (!this.passesOrientation(plan)) continue; // directives never read
      if (plan.takeover.isOn(show, dayStart)) takeover.push(plan);
      else {
        const next = plan.takeover.nextOn(show);
        if (next < interrupt) interrupt = next;
      }
      if (plan.standard.isOn(show, dayStart)) standard.push(plan);
    }
    this.interruptAt = interrupt;
  }

  /** §5.3 step 2 — an empty slot for this orientation excludes a media entry. */
  private passesOrientation(plan: EntryPlan): boolean {
    if (plan.board) return plan.set !== null;
    if (plan.item === null) return false;
    const orientation = this.orientationValue;
    if (orientation === null) return plan.portrait !== null || plan.landscape !== null;
    return (orientation === "portrait" ? plan.portrait : plan.landscape) !== null;
  }

  /** The orientation whose slot supplies the file (§5.7); without an orientation, the lane's own first. */
  private playOrientation(plan: EntryPlan): Orientation {
    const orientation = this.orientationValue;
    if (orientation !== null) return orientation;
    const own = this.laneSlot;
    if ((own === "portrait" ? plan.portrait : plan.landscape) !== null) return own;
    return own === "portrait" ? "landscape" : "portrait";
  }

  /** §5.6 — the first entry after the cursor, wrapping; the first entry with no cursor. */
  private choose(list: readonly EntryPlan[], cursor: Cursor): number {
    if (!cursor.has) {
      this.chosenCode = "rotation.start";
      return 0;
    }
    for (let i = 0; i < list.length; i++) {
      if (cursor.isBefore(list[i]!)) {
        this.chosenCode = "rotation.next";
        return i;
      }
    }
    this.chosenCode = "rotation.wrap";
    return 0;
  }

  private allFailed(list: readonly EntryPlan[]): boolean {
    if (this.failed.size < list.length) return false;
    for (let i = 0; i < list.length; i++) if (!this.failed.has(list[i]!.id)) return false;
    return true;
  }

  /** The RenderItem for a chosen entry, or null when the entry is skipped on the spot. */
  private build(plan: EntryPlan, kind: number, cursor: Cursor, show: number): PlayableRenderItem | null {
    const set: RotationSet = kind === TAKEOVER ? "takeover" : "standard";
    const project = this.snap.project;

    if (plan.board) {
      const sessionSet = plan.set!;
      let resolution: BoardResolution;
      try {
        resolution = this.boardResolver(sessionSet, {
          showNow: show,
          timezone: this.calendar.timeZone,
          entries: this.snap.sessionSetEntries.get(sessionSet.id) ?? NO_SET_ENTRIES,
          sessions: this.snap.sessions,
          snapshot: this.snap,
        });
      } catch (error) {
        this.skipPlan(plan, cursor, "media.load_failed", show, `the board resolver failed: ${(error as Error)?.message ?? String(error)}`);
        return null;
      }
      const pageCount = Number.isSafeInteger(resolution?.pageCount) && resolution.pageCount >= 1 ? resolution.pageCount : 1;
      const anchorPage = Number.isSafeInteger(resolution?.anchorPage) && resolution.anchorPage >= 0 && resolution.anchorPage < pageCount ? resolution.anchorPage : 0;
      const item: BoardRenderItem = {
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
    const window = playbackWindow(plan.entry, plan.item!, file, orientation);
    const video = isVideoType(file.contentType);
    const item: MediaRenderItem = {
      token: this.token(),
      kind: "media",
      entryId: plan.id,
      position: plan.position,
      set,
      code: this.chosenCode,
      name: plan.item!.name,
      media: Object.freeze({
        mediaItemId: plan.item!.id,
        mediaFileId: file.id,
        contentType: file.contentType,
        codec: file.codec,
        isVideo: video,
        start: window.start,
        duration: window.duration,
        durationSource: window.source,
      }),
      backing: this.backing(project.backingItemId),
      hint: this.hint(kind, video ? watchdogSeconds(window, file) : window.duration!, show),
    };
    return Object.freeze(item);
  }

  /**
   * §5.9 — a duration, unless a known interrupt comes first: while the
   * standard set rules, the next takeover activation replaces the duration.
   */
  private hint(kind: number, seconds: number, show: number): Hint {
    if (kind === STANDARD && this.interruptAt < show + Math.round(seconds * 1000)) {
      return Object.freeze({ kind: "time", at: this.interruptAt });
    }
    return Object.freeze({ kind: "duration", seconds });
  }

  /** §5.10 — a backing media item, resolved by orientation with no fallback. */
  private backing(itemId: number | null): Backing | null {
    if (itemId === null) return null;
    const item = this.snap.mediaItems.get(itemId);
    if (item === undefined) return null;
    const orientation = this.orientationValue ?? this.laneSlot;
    const fileId = orientation === "portrait" ? item.portraitFileId : item.landscapeFileId;
    const file = fileId === null ? undefined : this.snap.mediaFiles.get(fileId);
    if (file === undefined) return null;
    return Object.freeze({ mediaItemId: item.id, mediaFileId: file.id, contentType: file.contentType });
  }

  /** §5.5 — nothing new is produced: the last frame stays, and the marker is armed 2 s out. */
  private hold(code: HoldCode, show: number, message: string): void {
    this.marker = show + this.emptyRetryMs;
    this.markerReason = RETRY;
    if (this.lastStateKind === "hold" && this.lastStateCode === code) return; // recorded on entry, not on retry
    this.emit({ showTime: show, kind: "hold", code, message });
  }

  /** §5.2 — an authored blank: clear the screen, once. */
  private blank(show: number): void {
    this.marker = show + this.emptyRetryMs;
    this.markerReason = RETRY;
    if (this.currentItem !== null && this.currentItem.kind === "blank") return;
    const entry = this.activeEntry!;
    const item: BlankRenderItem = Object.freeze({ kind: "blank", token: this.token(), entryId: null, scheduleEntryId: entry.id });
    this.currentItem = item;
    this.since = show;
    this.pendingItem = null;
    this.issued = item;
    this.emit({ showTime: show, kind: "blank", code: "schedule.blank", message: `schedule entry ${entry.id} has no playlist: showing nothing, as authored` });
  }

  /** A host-reported failure of an issued item: trace it, move the cursor past it, force the next content. */
  private skip(item: PlayableRenderItem, code: SkipCode, show: number, why: string): void {
    this.emit({ showTime: show, kind: "skip", code, entryId: item.entryId, message: `entry ${item.entryId} "${item.name}": ${why}` });
    (item.set === "takeover" ? this.takeoverCursor : this.standardCursor).set(item.position, item.entryId);
    this.failed.add(item.entryId);
    this.marker = 0;
    this.markerReason = FORCED;
  }

  /** An entry the engine itself cannot put on screen, found while choosing. */
  private skipPlan(plan: EntryPlan, cursor: Cursor, code: SkipCode, show: number, why: string): void {
    this.emit({ showTime: show, kind: "skip", code, entryId: plan.id, message: why });
    cursor.set(plan.position, plan.id);
    this.failed.add(plan.id);
  }

  private token(): string {
    return this.tokenPrefix + ++this.tokenCount;
  }

  // ── inspection ─────────────────────────────────────────────────────────────

  /** A read-only account of what the engine sees at its last tick. Allocates; not for the tick path. */
  inspect(): Inspection {
    const show = this.show;
    const dayIndex = Number.isFinite(show) ? this.calendar.dayIndexAt(show) : -1;
    const day = dayIndex >= 0 ? this.calendar.days[dayIndex]! : null;
    const dayStart = day !== null ? day.startTime : Number.NEGATIVE_INFINITY;
    const playlist = this.activeState === PLAYLIST ? this.snap.playlists.get(this.activePlaylistId!) ?? null : null;
    const plans = playlist !== null ? this.plans.get(playlist.id) ?? [] : [];
    const entries: EntryInspection[] = [];
    const standard: number[] = [];
    const takeover: number[] = [];
    let interrupt = Number.POSITIVE_INFINITY;
    for (const plan of plans) {
      const passes = this.passesOrientation(plan);
      const orientation = this.orientationValue;
      const excluded = passes
        ? null
        : plan.board
          ? "its session set is not in the cartridge"
          : plan.item === null
            ? "its media item is not in the cartridge"
            : `no ${orientation} file: the slot is empty`;
      const file = passes && !plan.board ? (this.playOrientation(plan) === "portrait" ? plan.portrait : plan.landscape) : null;
      const takeoverOn = passes ? plan.takeover.nextOn(show) : Number.POSITIVE_INFINITY;
      const standardState = passes ? plan.standard.state(show, dayStart) : "none";
      const takeoverState = passes ? plan.takeover.state(show, dayStart) : "none";
      if (passes && takeoverState === "on") takeover.push(plan.id);
      else if (passes && takeoverOn < interrupt) interrupt = takeoverOn;
      if (passes && standardState === "on") standard.push(plan.id);
      entries.push(Object.freeze({
        entryId: plan.id,
        position: plan.position,
        resourceType: plan.entry.resourceType,
        name: plan.name,
        excluded,
        mediaFileId: file?.id ?? null,
        standard: standardState,
        takeover: takeoverState,
        takeoverOnAt: Number.isFinite(takeoverOn) ? takeoverOn : null,
      }));
    }
    const workingSet: WorkingSetKind = this.activeState === BLANK
      ? "blank"
      : this.activeState !== PLAYLIST
        ? "none"
        : takeover.length > 0
          ? "takeover"
          : standard.length > 0
            ? "standard"
            : "empty";
    return Object.freeze({
      showNow: show,
      day,
      slot: this.laneSlot,
      orientation: this.orientationValue,
      scheduleEntry: this.activeEntry,
      playlist: playlist !== null ? { id: playlist.id, name: playlist.name } : null,
      nextBoundary: Number.isFinite(this.nextBoundary) ? this.nextBoundary : null,
      entries,
      workingSet,
      rotation: workingSet === "takeover" ? takeover : workingSet === "standard" ? standard : [],
      suppressed: workingSet === "takeover" ? standard.filter((id) => !takeover.includes(id)) : [],
      interruptAt: workingSet === "standard" && Number.isFinite(interrupt) ? interrupt : null,
      cursors: {
        standard: this.standardCursor.has ? this.standardCursor.position : null,
        takeover: this.takeoverCursor.has ? this.takeoverCursor.position : null,
      },
      marker: this.marker,
      markerReason: MARKER_REASONS[this.markerReason]!,
      current: this.currentItem,
      currentSince: Number.isFinite(this.since) ? this.since : null,
      pending: this.pendingItem,
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────

function asOrientation(value: unknown): Orientation | null {
  return value === "portrait" || value === "landscape" ? value : null;
}

function describePlaylist(id: number | null): string {
  return id === null ? "no playlist" : `playlist ${id}`;
}

function seconds(value: number): string {
  return `${Math.round(value * 1000) / 1000} s`;
}

/** Compiles every playlist of a Snapshot for the viability pass, once per commit. */
function compilePlans(snapshot: Snapshot): Map<number, readonly EntryPlan[]> {
  const out = new Map<number, readonly EntryPlan[]>();
  const fileOf = (id: number | null): MediaFile | null => (id === null ? null : snapshot.mediaFiles.get(id) ?? null);
  for (const [playlistId, playlist] of snapshot.playlists) {
    const plans: EntryPlan[] = [];
    for (const entry of playlist.entries) {
      const directives = snapshot.directives.get(entry.id);
      const standard = directives && directives.standard.length > 0 ? new DirectiveSeries(directives.standard) : NO_DIRECTIVES;
      const takeover = directives && directives.takeover.length > 0 ? new DirectiveSeries(directives.takeover) : NO_DIRECTIVES;
      if (entry.resourceType === "session_set") {
        const set = entry.sessionSetId !== null ? snapshot.sessionSets.get(entry.sessionSetId) ?? null : null;
        plans.push(Object.freeze({
          entry, id: entry.id, position: entry.position, board: true, item: null, set,
          portrait: null, landscape: null, standard, takeover,
          name: set?.name ?? `session set ${entry.sessionSetId}`,
        }));
      } else {
        const item = entry.mediaItemId !== null ? snapshot.mediaItems.get(entry.mediaItemId) ?? null : null;
        plans.push(Object.freeze({
          entry, id: entry.id, position: entry.position, board: false, item, set: null,
          portrait: item !== null ? fileOf(item.portraitFileId) : null,
          landscape: item !== null ? fileOf(item.landscapeFileId) : null,
          standard, takeover,
          name: item?.name ?? `media item ${entry.mediaItemId}`,
        }));
      }
    }
    out.set(playlistId, Object.freeze(plans));
  }
  return out;
}
