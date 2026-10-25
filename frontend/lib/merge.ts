import type { Aircraft } from './types';

/** How long a good value may fill gaps in later, incomplete reports. */
const FILL_MS = 5 * 60_000;
const FILLABLE = ['callsign', 'reg', 'type', 'desc', 'alt', 'gs', 'track', 'vrate', 'squawk', 'category'] as const;

interface Known {
  a: Aircraft;
  /** Wall-clock time the position was actually reported (receivedAt − seen). */
  reportedAt: number;
}

/**
 * Reconciles reports for the same aircraft coming from different networks.
 * At the edge of coverage networks alternate between fresh data, stale "last position"
 * records without altitude/speed, and older OpenSky positions. Without merging, the UI
 * flickers to blank values and loses the callsign (and with it the route).
 *  - an older report never replaces a newer position;
 *  - missing fields are filled from the last good report (up to 5 min old).
 */
export class AircraftMerger {
  private known = new Map<string, Known>();

  merge(list: Aircraft[], receivedAt = Date.now()): Aircraft[] {
    const out = list.map((a) => this.one(a, receivedAt));
    if (this.known.size > 20_000) this.prune(receivedAt);
    return out;
  }

  one(next: Aircraft, receivedAt = Date.now()): Aircraft {
    const nextAt = receivedAt - (next.seen ?? 0) * 1000;
    const prev = this.known.get(next.hex);
    let merged: Aircraft = next;
    let reportedAt = nextAt;

    if (prev && receivedAt - prev.reportedAt < FILL_MS) {
      if (prev.reportedAt > nextAt + 1000) {
        // We already have a newer position — keep it, but take any fields the new report adds.
        merged = { ...prev.a, seen: (receivedAt - prev.reportedAt) / 1000 };
        for (const k of FILLABLE) if (merged[k] == null && next[k] != null) (merged as any)[k] = next[k];
        reportedAt = prev.reportedAt;
      } else {
        merged = { ...next };
        for (const k of FILLABLE) if (merged[k] == null && prev.a[k] != null) (merged as any)[k] = prev.a[k];
        // A "ground" flag with no speed/altitude data from a stale record is not trustworthy.
        if (merged.onGround && !prev.a.onGround && next.alt === null && next.gs === null) merged.onGround = false;
      }
    }
    this.known.set(next.hex, { a: merged, reportedAt });
    return merged;
  }

  private prune(now: number) {
    for (const [k, v] of this.known) if (now - v.reportedAt > 2 * FILL_MS) this.known.delete(k);
  }
}
