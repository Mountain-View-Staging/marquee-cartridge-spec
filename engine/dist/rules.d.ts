/**
 * The pure rules of what is on screen, each a function of its inputs only.
 * The engine composes them; hosts and tools may call them directly.
 */
import type { Directive, MediaFile, MediaItem, Orientation, PlaylistEntry } from "./model.js";
/** §5.8 — a still with no end and no display_duration. */
export declare const DEFAULT_STILL_SECONDS = 8;
/** §5.9 — a video's watchdog when its length is unknown. */
export declare const WATCHDOG_UNKNOWN_SECONDS = 300;
/** §5.9 — the grace added to a video's watchdog. */
export declare const WATCHDOG_GRACE_SECONDS = 10;
/** §5.12 — any `video/*` is a video; no allow-list. */
export declare function isVideoType(contentType: string): boolean;
/** §5.12 — any `image/*` is an image; no allow-list. */
export declare function isImageType(contentType: string): boolean;
/** §5.13 — only image and video media play; a typeface or a style book does not. */
export declare function isPlayableType(contentType: string): boolean;
/** §5.7 — the file in the slot for this orientation. No fallback: an empty slot is an exclusion. */
export declare function fileIdFor(item: MediaItem, orientation: Orientation): number | null;
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
export declare function playbackWindow(entry: PlaylistEntry, item: MediaItem, file: MediaFile, orientation: Orientation): PlaybackWindow;
/**
 * §5.9 — a video's watchdog: the window's duration, else the clip's
 * intrinsic duration, else 300 s, plus 10 s of grace.
 */
export declare function watchdogSeconds(window: PlaybackWindow, file: MediaFile): number;
export type DirectiveState = "on" | "off" | "none";
/**
 * One entry's directives of one type (§5.4), compiled for lookups that
 * neither allocate nor scan: binary searches over sorted timestamps.
 * Directives sharing a timestamp are ordered by id; the highest id governs.
 */
export declare class DirectiveSeries {
    private readonly times;
    private readonly on;
    /** `directives` sorted by (timestamp, id), as the Snapshot holds them. */
    constructor(directives: readonly Directive[]);
    get length(): number;
    /**
     * §5.4 — the index of the governing directive at `at`: the latest with
     * timestamp ≤ at, kept only if it falls inside the current day, which
     * starts at `dayStart` (−Infinity outside every day). −1 when none governs.
     */
    governing(at: number, dayStart: number): number;
    /** ON when the governing directive exists and is on screen. */
    isOn(at: number, dayStart: number): boolean;
    state(at: number, dayStart: number): DirectiveState;
    /**
     * The earliest instant after `at` at which this series turns ON: the first
     * later timestamp whose governing directive is on screen. +Infinity if none.
     */
    nextOn(at: number): number;
}
export declare const NO_DIRECTIVES: DirectiveSeries;
