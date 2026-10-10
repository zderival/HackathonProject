// Voice-clip validation. The format is detected from the bytes, never trusted from the
// client's Content-Type. Accepted formats are those Gemini documents for audio input
// (https://ai.google.dev/gemini-api/docs/audio), covering what browsers record:
// Chrome/Firefox MediaRecorder -> audio/webm (Opus), Safari -> audio/mp4 (AAC, sent as audio/m4a).
import { AppError } from '../lib/errors.js';

export const AUDIO_INPUT_FORMATS = ['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/m4a', 'audio/aac', 'audio/flac', 'audio/aiff'] as const;
export type AudioMime = (typeof AUDIO_INPUT_FORMATS)[number];

export function sniffAudio(b: Buffer): AudioMime | null {
  if (b.length < 12) return null;
  const ascii = (o: number, n: number) => b.toString('latin1', o, o + n);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 4) === 'FORM' && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) return 'audio/aiff';
  if (ascii(4, 4) === 'ftyp') return 'audio/m4a';
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac';
  return null;
}

// Exact duration for PCM WAV; other formats rely on the byte limit plus the
// client-declared duration (documented in docs/assistant.md).
export function wavDurationSec(b: Buffer): number | null {
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 16 <= b.length) byteRate = b.readUInt32LE(off + 16);
    if (id === 'data') return byteRate ? Math.min(size, b.length - off - 8) / byteRate : null;
    off += 8 + size + (size % 2);
  }
  return null;
}

export function validateAudio(data: Buffer, opts: { maxBytes: number; maxSeconds: number; declaredMs?: number }): { mimeType: AudioMime; durationSec: number | null } {
  if (!data.length) throw new AppError('VALIDATION_FAILED', { field: 'audio', reason: 'empty audio' });
  if (data.length > opts.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: opts.maxBytes });
  const mimeType = sniffAudio(data);
  if (!mimeType) throw new AppError('UNSUPPORTED_MEDIA_TYPE', { supported: AUDIO_INPUT_FORMATS, reason: 'unrecognized audio format' });
  const durationSec = mimeType === 'audio/wav' ? wavDurationSec(data) : opts.declaredMs !== undefined ? opts.declaredMs / 1000 : null;
  if (durationSec !== null && durationSec > opts.maxSeconds) throw new AppError('PAYLOAD_TOO_LARGE', { maxSeconds: opts.maxSeconds, durationSec: Math.round(durationSec * 10) / 10 });
  return { mimeType, durationSec };
}
