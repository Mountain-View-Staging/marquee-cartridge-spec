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

class SurfaceClock implements ShowClock {
  readonly kind = "surface" as const;

  now(wallMs: number, _monoMs: number, calendar: Calendar): number {
    return calendar.surfaceNow(wallMs);
  }
}

/** The show clock of a Surface (§8.2). */
export function surfaceClock(): ShowClock {
  return new SurfaceClock();
}

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

type Command = { readonly op: "set"; readonly at: number } | { readonly op: "play" } | { readonly op: "pause" };

/**
 * Commands take effect at the next tick, in the order given, at that tick's
 * monotonic time: the engine never reads a clock between ticks.
 */
class TransportClock implements PreviewClock {
  readonly kind = "preview" as const;
  private started = false;
  private running = true;
  private anchorShow = 0;
  private anchorMono = 0;
  private readonly queue: Command[] = [];

  get playing(): boolean {
    let running = this.running;
    for (const c of this.queue) if (c.op !== "set") running = c.op === "play";
    return running;
  }

  set(showMs: number): void {
    if (!Number.isFinite(showMs)) throw new RangeError(`preview clock: ${showMs} is not an instant`);
    this.queue.push({ op: "set", at: showMs });
  }

  play(): void {
    this.queue.push({ op: "play" });
  }

  pause(): void {
    this.queue.push({ op: "pause" });
  }

  now(wallMs: number, monoMs: number, calendar: Calendar): number {
    if (!this.started) {
      // A preview opens on what a Surface would show right now, and runs.
      this.started = true;
      this.anchorShow = calendar.surfaceNow(wallMs);
      this.anchorMono = monoMs;
    }
    let show = this.running ? this.anchorShow + (monoMs - this.anchorMono) : this.anchorShow;
    if (this.queue.length > 0) {
      for (const c of this.queue) {
        if (c.op === "set") show = c.at;
        else this.running = c.op === "play";
      }
      this.queue.length = 0;
      this.anchorShow = show;
      this.anchorMono = monoMs;
    }
    return show;
  }
}

/** An authoring tool's show clock: set, play, pause. */
export function previewClock(): PreviewClock {
  return new TransportClock();
}
