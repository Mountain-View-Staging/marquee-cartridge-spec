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
export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Offsets are cached per UTC quarter hour; a zone never changes offset twice in one. */
const BUCKET_MS = 900_000;
const mod = (a, n) => ((a % n) + n) % n;
export function isValidTimeZone(timeZone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone });
        return true;
    }
    catch {
        return false;
    }
}
/** A venue timezone's offsets, cached so the tick path allocates nothing. */
export class VenueZone {
    timeZone;
    parts;
    bucket = Number.NaN;
    bucketOffset = 0;
    constructor(timeZone) {
        this.timeZone = timeZone;
        this.parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
        });
    }
    /** The venue's UTC offset at an instant, in ms: the wall clock minus UTC. */
    offsetAt(t) {
        const bucket = Math.floor(t / BUCKET_MS);
        if (bucket === this.bucket)
            return this.bucketOffset;
        const start = bucket * BUCKET_MS;
        const first = this.exactOffset(start);
        if (first === this.exactOffset(start + BUCKET_MS - 1)) {
            this.bucket = bucket;
            this.bucketOffset = first;
            return first;
        }
        return this.exactOffset(t); // an offset change inside this quarter hour
    }
    /** The offset from the platform's timezone database, uncached. */
    exactOffset(t) {
        let y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0;
        for (const part of this.parts.formatToParts(t)) {
            switch (part.type) {
                case "year":
                    y = Number(part.value);
                    break;
                case "month":
                    mo = Number(part.value);
                    break;
                case "day":
                    d = Number(part.value);
                    break;
                case "hour":
                    h = Number(part.value);
                    break;
                case "minute":
                    mi = Number(part.value);
                    break;
                case "second":
                    s = Number(part.value);
                    break;
            }
        }
        return Date.UTC(y, mo - 1, d, h, mi, s) - (t - mod(t, 1000));
    }
    /** Milliseconds since venue-local midnight at an instant. */
    timeOfDay(t) {
        return mod(t + this.offsetAt(t), DAY_MS);
    }
    /** The venue-local date of an instant, as that date's midnight on the UTC axis. */
    localMidnight(t) {
        const local = t + this.exactOffset(t);
        return local - mod(local, DAY_MS);
    }
}
/**
 * Places a venue time of day on Day 1 (§8.2), including on a Day 1 whose
 * offset changes (a daylight-saving date):
 *   - a local time that does not exist (the skipped hour) resolves to the
 *     next valid instant, the moment the clocks change;
 *   - a local time that occurs twice (the repeated hour) resolves to the
 *     earlier instant.
 */
export class DayOne {
    day;
    midnight;
    before;
    after;
    /** The instant the offset changes near Day 1, or +Infinity when it does not. */
    change;
    constructor(zone, day) {
        this.day = day;
        this.midnight = zone.localMidnight(day.startTime);
        // Day 1's wall clock spans these instants whatever the offset (−12 h … +14 h).
        const lo = this.midnight - 14 * HOUR_MS;
        const hi = this.midnight + DAY_MS + 12 * HOUR_MS;
        this.before = zone.exactOffset(lo);
        this.after = zone.exactOffset(hi);
        if (this.before === this.after) {
            this.change = Number.POSITIVE_INFINITY;
        }
        else {
            let a = lo, b = hi;
            while (b - a > 1) {
                const m = Math.floor((a + b) / 2);
                if (zone.exactOffset(m) === this.before)
                    a = m;
                else
                    b = m;
            }
            this.change = b;
        }
    }
    /** The instant at which the venue clock reads `timeOfDay` on Day 1. */
    at(timeOfDay) {
        const local = this.midnight + timeOfDay;
        const early = local - this.before;
        if (this.change === Number.POSITIVE_INFINITY)
            return early;
        const late = local - this.after;
        const earlyValid = early < this.change;
        const lateValid = late >= this.change;
        if (earlyValid && lateValid)
            return early < late ? early : late; // repeated: the earlier
        if (earlyValid)
            return early;
        if (lateValid)
            return late;
        return this.change; // skipped: the next valid instant
    }
}
/**
 * The time facts of one Snapshot: its days, its venue zone, and the show
 * clock for a real instant (§8.2).
 */
export class Calendar {
    timeZone;
    days;
    /** False when the cartridge has no days or an unusable timezone: real time is used (degraded). */
    valid;
    eventStart;
    eventEnd;
    zone;
    dayOne;
    starts;
    ends;
    label;
    constructor(days, timeZone) {
        this.timeZone = timeZone;
        this.days = days;
        this.starts = Float64Array.from(days, (d) => d.startTime);
        this.ends = Float64Array.from(days, (d) => d.endTime);
        const zoneOk = isValidTimeZone(timeZone);
        this.valid = zoneOk && days.length > 0;
        this.zone = zoneOk ? new VenueZone(timeZone) : null;
        this.dayOne = this.valid ? new DayOne(this.zone, days[0]) : null;
        this.eventStart = days.length > 0 ? days[0].startTime : Number.NaN;
        this.eventEnd = days.length > 0 ? Math.max(...days.map((d) => d.endTime)) : Number.NaN;
        this.label = new Intl.DateTimeFormat("sv-SE", {
            timeZone: zoneOk ? timeZone : "UTC",
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }
    /**
     * §8.2 — the show clock of a Surface: real venue time inside the event,
     * otherwise Day 1 at the venue's current time of day, clamped to Day 1.
     * The degraded path (no days, or an unknown zone) returns real time.
     */
    surfaceNow(real) {
        if (!this.valid)
            return real;
        if (real >= this.eventStart && real <= this.eventEnd)
            return real;
        const dayOne = this.dayOne;
        const synthetic = dayOne.at(this.zone.timeOfDay(real));
        return synthetic < dayOne.day.startTime || synthetic > dayOne.day.endTime ? dayOne.day.startTime : synthetic;
    }
    /** §5.4 step 1 — the index of the day containing `at`, or −1 outside every day. */
    dayIndexAt(at) {
        let lo = 0, hi = this.starts.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.starts[mid] <= at)
                lo = mid + 1;
            else
                hi = mid;
        }
        const i = lo - 1;
        return i >= 0 && at <= this.ends[i] ? i : -1;
    }
    /** A venue-local timestamp for messages, e.g. `2026-09-15 11:30:00`. */
    format(at) {
        return Number.isFinite(at) ? this.label.format(at) + (this.zone ? "" : " UTC") : String(at);
    }
}
