import { EncodedPacket } from 'mediabunny';
import { BufferedPacket, selectClipRange } from './frame-recorder';

function packet(epochMs: number, isKey: boolean): BufferedPacket {
  return { packet: new EncodedPacket(new Uint8Array(1), isKey ? 'key' : 'delta', epochMs / 1000, 0.033), isKey, epochMs };
}

describe('selectClipRange', () => {
  // Keyframes at 0, 400, 800; a frame every ~100ms in between.
  const packets = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((t) => packet(t, t % 400 === 0));

  it('starts on the last keyframe at or before the window start and ends on the last frame at or before the window end', () => {
    expect(selectClipRange(packets, 550, 950)).toEqual({ startIndex: 4, endIndex: 9 });
  });

  it('starts at the first keyframe when the window starts before any buffered footage', () => {
    expect(selectClipRange(packets, -500, 300)).toEqual({ startIndex: 0, endIndex: 3 });
  });

  it('returns null when nothing is buffered or nothing falls in the window', () => {
    expect(selectClipRange([], 0, 100)).toBeNull();
    expect(selectClipRange(packets.slice(1), 0, 50)).toBeNull();
  });
});
