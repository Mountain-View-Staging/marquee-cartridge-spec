/**
 * Venue time (specification §8).
 *
 * Every time decision is made in the venue timezone from the cartridge, never
 * the device's. The show clock needs two venue-time facts on every tick when
 * the real time is outside the event: the venue's time of day now, and the
 * instant at which the venue clock reads that time on Day 1. Both are
 * computed here without allocating: the zone's UTC offset is cached per
 * quarter hour (every current zone changes offset on a quarter hour), and
 * Day 1's offsets are worked out once per Snapshot.
 */
import type { ProjectDay } from "./model.js";
export declare const DAY_MS = 86400000;
export declare function isValidTimeZone(timeZone: string): boolean;
/** A venue timezone's offsets, cached so the tick path allocates nothing. */
export declare class VenueZone {
    readonly timeZone: string;
    private readonly parts;
    private bucket;
    private bucketOffset;
    constructor(timeZone: string);
    /** The venue's UTC offset at an instant, in ms: the wall clock minus UTC. */
    offsetAt(t: number): number;
    /** The offset from the platform's timezone database, uncached. */
    exactOffset(t: number): number;
    /** Milliseconds since venue-local midnight at an instant. */
    timeOfDay(t: number): number;
    /** The venue-local date of an instant, as that date's midnight on the UTC axis. */
    localMidnight(t: number): number;
}
/**
 * Places a venue time of day on Day 1 (§8.2), including on a Day 1 whose
 * offset changes (a daylight-saving date):
 *   - a local time that does not exist (the skipped hour) resolves to the
 *     next valid instant, the moment the clocks change;
 *   - a local time that occurs twice (the repeated hour) resolves to the
 *     earlier instant.
 */
export declare class DayOne {
    readonly day: ProjectDay;
    private readonly midnight;
    private readonly before;
    private readonly after;
    /** The instant the offset changes near Day 1, or +Infinity when it does not. */
    private readonly change;
    constructor(zone: VenueZone, day: ProjectDay);
    /** The instant at which the venue clock reads `timeOfDay` on Day 1. */
    at(timeOfDay: number): number;
}
/**
 * The time facts of one Snapshot: its days, its venue zone, and the show
 * clock for a real instant (§8.2).
 */
export declare class Calendar {
    readonly timeZone: string;
    readonly days: readonly ProjectDay[];
    /** False when the cartridge has no days or an unusable timezone: real time is used (degraded). */
    readonly valid: boolean;
    readonly eventStart: number;
    readonly eventEnd: number;
    private readonly zone;
    private readonly dayOne;
    private readonly starts;
    private readonly ends;
    private readonly label;
    constructor(days: readonly ProjectDay[], timeZone: string);
    /**
     * §8.2 — the show clock of a Surface: real venue time inside the event,
     * otherwise Day 1 at the venue's current time of day, clamped to Day 1.
     * The degraded path (no days, or an unknown zone) returns real time.
     */
    surfaceNow(real: number): number;
    /** §5.4 step 1 — the index of the day containing `at`, or −1 outside every day. */
    dayIndexAt(at: number): number;
    /** A venue-local timestamp for messages, e.g. `2026-09-15 11:30:00`. */
    format(at: number): string;
}
