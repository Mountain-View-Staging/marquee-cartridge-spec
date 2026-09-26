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
class SurfaceClock {
    kind = "surface";
    now(wallMs, _monoMs, calendar) {
        return calendar.surfaceNow(wallMs);
    }
}
/** The show clock of a Surface (§8.2). */
export function surfaceClock() {
    return new SurfaceClock();
}
/**
 * Commands take effect at the next tick, in the order given, at that tick's
 * monotonic time: the engine never reads a clock between ticks.
 */
class TransportClock {
    kind = "preview";
    started = false;
    running = true;
    anchorShow = 0;
    anchorMono = 0;
    queue = [];
    get playing() {
        let running = this.running;
        for (const c of this.queue)
            if (c.op !== "set")
                running = c.op === "play";
        return running;
    }
    set(showMs) {
        if (!Number.isFinite(showMs))
            throw new RangeError(`preview clock: ${showMs} is not an instant`);
        this.queue.push({ op: "set", at: showMs });
    }
    play() {
        this.queue.push({ op: "play" });
    }
    pause() {
        this.queue.push({ op: "pause" });
    }
    now(wallMs, monoMs, calendar) {
        if (!this.started) {
            // A preview opens on what a Surface would show right now, and runs.
            this.started = true;
            this.anchorShow = calendar.surfaceNow(wallMs);
            this.anchorMono = monoMs;
        }
        let show = this.running ? this.anchorShow + (monoMs - this.anchorMono) : this.anchorShow;
        if (this.queue.length > 0) {
            for (const c of this.queue) {
                if (c.op === "set")
                    show = c.at;
                else
                    this.running = c.op === "play";
            }
            this.queue.length = 0;
            this.anchorShow = show;
            this.anchorMono = monoMs;
        }
        return show;
    }
}
/** An authoring tool's show clock: set, play, pause. */
export function previewClock() {
    return new TransportClock();
}
