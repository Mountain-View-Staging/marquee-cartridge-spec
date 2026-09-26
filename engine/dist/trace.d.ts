/**
 * The trace: every decision the engine makes, with a stable reason code.
 *
 * Codes are the contract; conformance compares them field for field
 * (conformance/README.md). `message` is for people: free to reword, never
 * compared. A `render` is recorded at the item's first frame; a natural end
 * is not an event, the next `render` shows when it happened.
 */
export type TraceKind = "render" | "cut" | "jump" | "hold" | "blank" | "skip" | "warning";
export type RenderCode = "rotation.start" | "rotation.next" | "rotation.wrap";
export type CutCode = "takeover.activate" | "schedule.change" | "orientation.change" | "cartridge.commit";
export type JumpCode = "jump.backward" | "jump.forward";
export type HoldCode = "set.empty" | "set.all_failed";
export type BlankCode = "schedule.blank";
export type SkipCode = "media.load_failed" | "media.no_first_frame" | "media.watchdog" | "media.not_playable";
export type WarningCode = "orientation.missing";
export type TraceCode = RenderCode | CutCode | JumpCode | HoldCode | BlankCode | SkipCode | WarningCode;
/** Which rotation an item came from (§5.5). */
export type RotationSet = "standard" | "takeover";
export interface TraceEvent {
    /** The show clock at the decision (Unix ms). */
    readonly showTime: number;
    readonly kind: TraceKind;
    readonly code: TraceCode;
    /** render, skip: the entry concerned. cut: the entry that was on screen. */
    readonly entryId?: number;
    /** render: the rotation it came from. */
    readonly set?: RotationSet;
    /** render of a media item: the media file for this orientation. */
    readonly mediaFileId?: number;
    /** render of a session board: the session set. */
    readonly sessionSetId?: number;
    /** Plain words for operators. Never compared. */
    readonly message: string;
}
