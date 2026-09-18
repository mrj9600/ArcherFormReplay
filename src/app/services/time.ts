/** Wall-clock time in ms since the Unix epoch with sub-millisecond resolution. `Date.now()` is
 *  integer-ms; timeOrigin + performance.now() is the same clock at much finer resolution, and
 *  it's the common timeline every device's recording start, trigger and clock offset are
 *  expressed in. */
export function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

/** Converts a performance.now()-style reading into the epoch timeline. */
export function perfToEpoch(perfTimestamp: number): number {
  return performance.timeOrigin + perfTimestamp;
}

/** Timestamps travel over PeerJS as decimal strings: its binary packer stores non-integer
 *  numbers with a hand-rolled double encoding that isn't guaranteed to round-trip exactly, and
 *  epoch milliseconds with a fractional part are exactly the values that need to stay precise. */
export function encodeTimestamp(ts: number): string {
  return ts.toString();
}

export function decodeTimestamp(raw: string | number): number {
  return typeof raw === 'number' ? raw : Number(raw);
}
