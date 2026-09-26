/**
 * The pure rules of what is on screen, each a function of its inputs only.
 * The engine composes them; hosts and tools may call them directly.
 */

import type { Directive, MediaFile, MediaItem, Orientation, PlaylistEntry } from "./model.js";

/** §5.8 — a still with no end and no display_duration. */
export const DEFAULT_STILL_SECONDS = 8;
/** §5.9 — a video's watchdog when its length is unknown. */
export const WATCHDOG_UNKNOWN_SECONDS = 300;
/** §5.9 — the grace added to a video's watchdog. */
export const WATCHDOG_GRACE_SECONDS = 10;

/** §5.12 — any `video/*` is a video; no allow-list. */
export function isVideoType(contentType: string): boolean {
  return /^video\//i.test(contentType);
}

/** §5.12 — any `image/*` is an image; no allow-list. */
export function isImageType(contentType: string): boolean {
  return /^image\//i.test(contentType);
}

/** §5.13 — only image and video media play; a typeface or a style book does not. */
export function isPlayableType(contentType: string): boolean {
  return isImageType(contentType) || isVideoType(contentType);
}

/** §5.7 — the file in the slot for this orientation. No fallback: an empty slot is an exclusion. */
export function fileIdFor(item: MediaItem, orientation: Orientation): number | null {
  return orientation === "portrait" ? item.portraitFileId : item.landscapeFileId;
}

export type DurationSource = "window" | "clip" | "display_duration" | "default";

export interface PlaybackWindow {
  /** Seconds into the file: a video's in-point. */
  readonly start: number;
  /**
   * Seconds on screen. For a video, start + duration is the out-point. Null
   * only for a video with no end whose length is unknown: it plays to its end.
   */
  readonly duration: number | null;
  /** Which rule gave the duration. */
  readonly source: DurationSource;
}

/**
 * §5.8 — start and duration, for the orientation rendered:
 *   start     start_time_<orientation>, else 0
 *   duration  end − start when the window has an end (end > start), a still too;
 *             a video with no end: to the end of the clip;
 *             a still with no end: display_duration, else 8 s.
 */
export function playbackWindow(entry: PlaylistEntry, item: MediaItem, file: MediaFile, orientation: Orientation): PlaybackWindow {
  const portrait = orientation === "portrait";
  const rawStart = portrait ? entry.startTimePortrait : entry.startTimeLandscape;
  const start = rawStart !== null && rawStart > 0 ? rawStart : 0;
  const end = portrait ? entry.endTimePortrait : entry.endTimeLandscape;
  if (end !== null && end > start) return { start, duration: end - start, source: "window" };
  if (isVideoType(file.contentType)) {
    const length = file.intrinsicDuration;
    return { start, duration: length !== null ? Math.max(0, length - start) : null, source: "clip" };
  }
  const dwell = item.displayDuration;
  if (dwell !== null && dwell > 0) return { start, duration: dwell, source: "display_duration" };
  return { start, duration: DEFAULT_STILL_SECONDS, source: "default" };
}

/**
 * §5.9 — a video's watchdog: the window's duration, else the clip's
 * intrinsic duration, else 300 s, plus 10 s of grace.
 */
export function watchdogSeconds(window: PlaybackWindow, file: MediaFile): number {
  const base = window.source === "window" && window.duration !== null
    ? window.duration
    : file.intrinsicDuration ?? WATCHDOG_UNKNOWN_SECONDS;
  return base + WATCHDOG_GRACE_SECONDS;
}

export type DirectiveState = "on" | "off" | "none";

/**
 * One entry's directives of one type (§5.4), compiled for lookups that
 * neither allocate nor scan: binary searches over sorted timestamps.
 * Directives sharing a timestamp are ordered by id; the highest id governs.
 */
export class DirectiveSeries {
  private readonly times: Float64Array;
  private readonly on: Uint8Array;

  /** `directives` sorted by (timestamp, id), as the Snapshot holds them. */
  constructor(directives: readonly Directive[]) {
    this.times = Float64Array.from(directives, (d) => d.timestamp);
    this.on = Uint8Array.from(directives, (d) => (d.onScreen ? 1 : 0));
  }

  get length(): number {
    return this.times.length;
  }

  /**
   * §5.4 — the index of the governing directive at `at`: the latest with
   * timestamp ≤ at, kept only if it falls inside the current day, which
   * starts at `dayStart` (−Infinity outside every day). −1 when none governs.
   */
  governing(at: number, dayStart: number): number {
    const times = this.times;
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid]! <= at) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    return i >= 0 && times[i]! >= dayStart ? i : -1;
  }

  /** ON when the governing directive exists and is on screen. */
  isOn(at: number, dayStart: number): boolean {
    const i = this.governing(at, dayStart);
    return i >= 0 && this.on[i] === 1;
  }

  state(at: number, dayStart: number): DirectiveState {
    const i = this.governing(at, dayStart);
    return i < 0 ? "none" : this.on[i] === 1 ? "on" : "off";
  }

  /**
   * The earliest instant after `at` at which this series turns ON: the first
   * later timestamp whose governing directive is on screen. +Infinity if none.
   */
  nextOn(at: number): number {
    const times = this.times;
    const n = times.length;
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid]! <= at) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < n; i++) {
      const t = times[i]!;
      let last = i;
      while (last + 1 < n && times[last + 1] === t) last++;
      if (this.on[last] === 1) return t;
      i = last;
    }
    return Number.POSITIVE_INFINITY;
  }
}

export const NO_DIRECTIVES = new DirectiveSeries([]);
