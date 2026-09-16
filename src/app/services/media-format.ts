const CANDIDATE_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
];

/** Picks the first MediaRecorder mime type this browser actually supports (Safari needs mp4, Chrome/Android use webm). */
export function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}
