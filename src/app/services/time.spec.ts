import { decodeTimestamp, encodeTimestamp, epochNow, perfToEpoch } from './time';

describe('time helpers', () => {
  it('round-trips a fractional epoch timestamp exactly through its wire encoding', () => {
    const ts = 1_789_000_123_456.789;
    expect(decodeTimestamp(encodeTimestamp(ts))).toBe(ts);
  });

  it('epochNow lands in the same place as converting a performance.now() reading', () => {
    const viaPerf = perfToEpoch(performance.now());
    expect(Math.abs(epochNow() - viaPerf)).toBeLessThan(50);
  });
});
