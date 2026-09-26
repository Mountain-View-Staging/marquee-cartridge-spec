/**
 * Show clocks (specification §8).
 *
 * The engine samples one clock per tick and uses that single `showNow` for
 * every decision in the tick. Two sources share one interface:
 *
 *   surfaceClock()  a Surface: real venue time inside the event, Day 1 at the
 *                   venue's time of day outside it (§8.2).
 *   previewClock()  an authoring tool's transport: set, play, pause. It is
 *                   always synthetic and runs at real-time rate on the host's
 *                   monotonic clock. Setting it is a show-clock jump (§8.3);
 *                   pausing holds it still, which is not a jump, so whatever
 *                   is on screen simply waits.
 */
import type { Calendar } from "./venue-time.js";
export interface ShowClock {
    readonly kind: "surface" | "preview";
    /**
     * The show clock at this tick. `wallMs` is the host's wall clock (Unix ms),
     * `monoMs` its monotonic clock; `calendar` is the committed Snapshot's.
     */
    now(wallMs: number, monoMs: number, calendar: Calendar): number;
}
/** The show clock of a Surface (§8.2). */
export declare function surfaceClock(): ShowClock;
export interface PreviewClock extends ShowClock {
    readonly kind: "preview";
    /** Jump to a show instant (Unix ms). Any moment, on any day; no Day 1 clamp. */
    set(showMs: number): void;
    /** Advance at real-time rate from the current value. */
    play(): void;
    /** Hold at the current value. */
    pause(): void;
    /** Whether the clock is running, counting commands not yet applied. */
    readonly playing: boolean;
}
/** An authoring tool's show clock: set, play, pause. */
export declare function previewClock(): PreviewClock;
