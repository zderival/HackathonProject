// Gemini adapter using the official Google Gen AI SDK (@google/genai >= 2.24, the
// Interactions API). Verified against the SDK typings and
// https://ai.google.dev/gemini-api/docs/{structured-output,audio,speech-generation}:
//   * structured output: response_format { type: 'text', mime_type: 'application/json', schema }
//   * audio input: { type: 'audio', data: <base64>, mime_type }
//   * speech: response_format { type: 'audio' } -> output_audio (WAV, 24 kHz mono 16-bit by default)
// Model names come from configuration; `npm run smoke:gemini` checks them for a key.
import { GoogleGenAI } from '@google/genai';
import type { Lang } from '../lib/i18n.js';
import { PLAN_SCHEMA, ProviderError, type AssistantProvider, type PlanInput, type RawPlan } from './provider.js';

export interface GeminiOptions {
  apiKey: string;
  planModel: string;
  ttsModel: string;
  ttsVoice: string;
  timeoutMs: number;
  ttsTimeoutMs: number;
}

export class GeminiProvider implements AssistantProvider {
  readonly name = 'gemini';
  private client: GoogleGenAI;

  constructor(private opts: GeminiOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  async plan(input: PlanInput, signal: AbortSignal): Promise<RawPlan> {
    const parts: any[] = [{ type: 'text', text: input.context }];
    if (input.audio) {
      parts.push({ type: 'text', text: 'The user request is the following voice recording.' });
      parts.push({ type: 'audio', data: input.audio.data.toString('base64'), mime_type: input.audio.mimeType });
    } else {
      // Typed request as JSON data, so it cannot masquerade as system text.
      parts.push({ type: 'text', text: `USER_REQUEST_JSON: ${JSON.stringify({ text: input.text ?? '' })}` });
    }
    if (input.repair) {
      parts.push({
        type: 'text',
        text: `Your previous plan was rejected by the server and NOTHING was applied. Fix it or ask a clarification. REJECTED_PLAN_JSON: ${JSON.stringify(
          input.repair.previousPlan,
        ).slice(0, 4000)} SERVER_ERROR: ${input.repair.error.slice(0, 1500)}`,
      });
    }
    const res: any = await this.call(
      () =>
        this.client.interactions.create(
          {
            model: this.opts.planModel,
            system_instruction: input.systemInstruction,
            input: parts,
            response_format: { type: 'text', mime_type: 'application/json', schema: PLAN_SCHEMA as any },
            generation_config: { temperature: 0.2, thinking_level: 'low' },
            store: false,
          },
          { signal, timeout_ms: this.opts.timeoutMs },
        ),
      signal,
    );
    const text: string | undefined = res?.output_text;
    if (!text) throw new ProviderError('malformed', 'empty model response');
    try {
      return JSON.parse(text) as RawPlan;
    } catch {
      throw new ProviderError('malformed', 'model response is not JSON');
    }
  }

  async speak(text: string, _lang: Lang, signal: AbortSignal) {
    // The TTS models detect the language from the text; the reply is already written
    // in the requested language.
    const res: any = await this.call(
      () =>
        this.client.interactions.create(
          {
            model: this.opts.ttsModel,
            input: [{ type: 'text', text }],
            response_format: { type: 'audio' },
            generation_config: { speech_config: [{ voice: this.opts.ttsVoice }] },
            store: false,
          },
          { signal, timeout_ms: this.opts.ttsTimeoutMs },
        ),
      signal,
    );
    const audio = res?.output_audio;
    if (!audio?.data) throw new ProviderError('malformed', 'no audio in TTS response');
    const data = Buffer.from(audio.data, 'base64');
    const mime: string = audio.mime_type ?? 'audio/wav';
    // Raw PCM (audio/l16) is wrapped in a WAV header so browsers and iOS can play it.
    if (mime.startsWith('audio/l16') || mime.startsWith('audio/pcm')) return { audio: pcmToWav(data, audio.sample_rate ?? 24000, audio.channels ?? 1), mimeType: 'audio/wav' };
    return { audio: data, mimeType: mime };
  }

  private async call<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (signal.aborted) throw new ProviderError('timeout', 'aborted');
      const status = err?.status ?? err?.code;
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timed? ?out/i.test(err?.message ?? '')) throw new ProviderError('timeout', err.message);
      if (status === 429 || status === 408 || (typeof status === 'number' && status >= 500)) throw new ProviderError('retryable', `${status}: ${err.message}`);
      if (err?.cause?.code === 'ECONNRESET' || err?.cause?.code === 'ETIMEDOUT' || err?.message === 'fetch failed') throw new ProviderError('retryable', err.message);
      throw new ProviderError('fatal', `${status ?? ''} ${err?.message ?? err}`.trim());
    }
  }
}

export function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
