/**
 * RenderItem: the engine's complete description of what should be on screen.
 * The host draws it and reports back with its token.
 *
 * The engine names things by id (media item, media file, session set); the
 * host maps a media file to the rendition it holds (§7.6) and draws. A new
 * RenderItem supersedes any earlier one that has not reported its first
 * frame: reports carrying an older token are ignored.
 */

import type { TemplateSettings } from "./model.js";
import type { DurationSource } from "./rules.js";
import type { RenderCode, RotationSet } from "./trace.js";

/**
 * §5.9 — when the item ends. `duration` arms the render marker at the item's
 * first frame (showNow + seconds); `time` is an absolute show-clock instant,
 * given when a known interrupt comes before the item's natural end.
 */
export type Hint =
  | { readonly kind: "duration"; readonly seconds: number }
  | { readonly kind: "time"; readonly at: number };

/** §5.10 — media composited behind the content. Resolved by orientation, no fallback. */
export interface Backing {
  readonly mediaItemId: number;
  readonly mediaFileId: number;
  readonly contentType: string;
}

/**
 * §5.11 — a DemoStation's demo, while it is on. The demo fills the screen,
 * framed by this branding, and the engine's items play in the picture-in-picture.
 */
export interface DemoState {
  /** The `demo_station` schedule entry whose background turned the demo on. */
  readonly scheduleEntryId: number;
  /** Behind everything. Resolved like a backing, in the device's own orientation: null for an empty slot. */
  readonly background: Backing | null;
  /** In front of everything, resolved the same way; null when the entry has none. */
  readonly overlay: Backing | null;
}

export interface MediaContent {
  readonly mediaItemId: number;
  /** The file in this orientation's slot, played as authored whatever its shape (§5.7). */
  readonly mediaFileId: number;
  /** The imported file's type; the host chooses the rendition (§7.6). */
  readonly contentType: string;
  readonly codec: string | null;
  readonly isVideo: boolean;
  /** Seconds: a video's in-point. */
  readonly start: number;
  /** Seconds on screen (§5.8); null for a video of unknown length that plays to its end. */
  readonly duration: number | null;
  readonly durationSource: DurationSource;
}

export interface BoardContent {
  readonly sessionSetId: number;
  /** Whatever the board resolver returned: what the board says. */
  readonly model: unknown;
  readonly pageCount: number;
  /** The page to open on (the current or next session's). */
  readonly anchorPage: number;
  /** Seconds per page. Page i shows from the first frame + i × pageDuration, from the anchor, wrapping. */
  readonly pageDuration: number;
  readonly logoItemId: number | null;
  /** §9.2 — the style book: the set's, else the project's; null for the Surface's built-in default. */
  readonly styleItemId: number | null;
  /** §5.15 — the template: the set's, else the project's; null for the Surface's built-in default template. */
  readonly templateItemId: number | null;
  /** §5.15 — the settings beside the pointer that applied; null when none. */
  readonly templateSettings: TemplateSettings | null;
  /** §5.15 — the layouts the device shows, its own setting at the time the board was chosen. */
  readonly variant: BoardVariant;
}

/** §5.15 — which of a template's layouts a sign shows: a device setting, like its orientation. */
export type BoardVariant = "now-next" | "schedule" | "both";

interface PlayableBase {
  readonly token: string;
  readonly entryId: number;
  readonly position: number;
  readonly set: RotationSet;
  /** Recorded in the trace when the first frame is reported. */
  readonly code: RenderCode;
  /** The media item's or session set's name, for display. */
  readonly name: string;
  readonly hint: Hint;
  readonly backing: Backing | null;
  /**
   * True when a DemoStation's demo is on (§5.11): the item plays in the
   * picture-in-picture, in the orientation opposite the device's. False on the
   * full screen, and always on a host without the DemoStation mode.
   */
  readonly pip: boolean;
}

export interface MediaRenderItem extends PlayableBase {
  readonly kind: "media";
  readonly media: MediaContent;
}

export interface BoardRenderItem extends PlayableBase {
  readonly kind: "sessionBoard";
  readonly board: BoardContent;
}

/** §5.2 — an authored blank: clear the screen. Needs no report. */
export interface BlankRenderItem {
  readonly kind: "blank";
  readonly token: string;
  readonly entryId: null;
  /** The schedule entry whose playlist is NULL. */
  readonly scheduleEntryId: number;
  /** True when the picture-in-picture is the frame to clear (§5.11). */
  readonly pip: boolean;
}

export type RenderItem = MediaRenderItem | BoardRenderItem | BlankRenderItem;
export type PlayableRenderItem = MediaRenderItem | BoardRenderItem;
