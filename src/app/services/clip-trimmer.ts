import { BlobSource, BufferTarget, Conversion, Input, MP4, Mp4OutputFormat, Output, WebMOutputFormat, WEBM } from 'mediabunny';

/**
 * Trims a video Blob down to an exact [startSec, endSec) window via mediabunny (WebCodecs-based
 * decode/encode). The rolling buffer hands back the entire recording so far (see
 * rolling-buffer-recorder.service.ts), so this is what turns that into a clip whose length
 * actually matches the configured pre-roll/post-roll.
 */
export async function trimClip(blob: Blob, startSec: number, endSec: number, mimeType: string): Promise<Blob> {
  const input = new Input({ formats: [WEBM, MP4], source: new BlobSource(blob) });
  try {
    const target = new BufferTarget();
    const format = mimeType.includes('mp4') ? new Mp4OutputFormat() : new WebMOutputFormat();
    const output = new Output({ format, target });

    const start = Math.max(0, startSec);
    const end = Math.max(start + 0.05, endSec);
    const conversion = await Conversion.init({ input, output, trim: { start, end } });
    if (!conversion.isValid) {
      throw new Error('Clip trim conversion is not valid for this input');
    }
    await conversion.execute();
    if (!target.buffer) {
      throw new Error('Clip trim produced no output');
    }
    return new Blob([target.buffer], { type: mimeType || 'video/webm' });
  } finally {
    // Without this, the decoder/reader resources mediabunny opened for this Input are never
    // freed - harmless for a single trim, but leaked WebCodecs decoders eventually make later
    // trims hang indefinitely (observed as a device getting permanently stuck in "capturing"
    // after its first successful clip).
    input.dispose();
  }
}
