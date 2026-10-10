// Deterministic provider double for automated tests and offline UI work
// (ASSISTANT_PROVIDER=fake, refused in production). Results produced through it are
// NOT evidence that Gemini or any language works; see docs/assistant.md.
import type { Lang } from '../lib/i18n.js';
import { pcmToWav } from './gemini.js';
import { ProviderError, type AssistantProvider, type PlanInput, type RawPlan } from './provider.js';

export type FakePlanFn = (input: PlanInput, ctx: { call: number; context: any }) => RawPlan | Promise<RawPlan>;
export type FakeSpeakFn = (text: string, lang: Lang) => { audio: Buffer; mimeType: string } | Promise<{ audio: Buffer; mimeType: string }>;

export function rawPlan(p: Partial<RawPlan> & { intent: RawPlan['intent'] }): RawPlan {
  return {
    transcript: null,
    transcriptConfidence: 'high',
    detectedLanguage: 'en',
    operations: [],
    undoActionId: null,
    reply: '',
    question: null,
    suggestions: [],
    ...p,
  };
}

export const ops = (...list: Record<string, unknown>[]) =>
  list.map(({ op, ...args }) => ({ op: String(op), argsJson: JSON.stringify(args) }));

// Offline default: understands a couple of English phrases so the UI flow can be
// exercised without a key; everything else is answered with an explanation.
const defaultPlan: FakePlanFn = (input, { context }) => {
  const text = (input.text ?? '').toLowerCase();
  const sel: string[] = context?.selectedNodeIds ?? [];
  if (/\bundo\b/.test(text)) return rawPlan({ intent: 'undo', reply: '[fake] Undone.' });
  if (/\bhide\b/.test(text) && sel.length)
    return rawPlan({
      intent: 'edit',
      operations: ops(...sel.map((nodeId) => ({ op: 'node.setVisibility', nodeId, visible: false }))),
      reply: '[fake] Hidden.',
      question: 'Is that what you wanted?',
    });
  return rawPlan({ intent: 'answer', reply: '[fake assistant] No language model is configured; set GEMINI_API_KEY.' });
};

export const silentWav = () => pcmToWav(Buffer.alloc(4800), 24000, 1);

export class FakeProvider implements AssistantProvider {
  readonly name = 'fake';
  calls: PlanInput[] = [];
  speakCalls: { text: string; lang: Lang }[] = [];

  constructor(
    public planFn: FakePlanFn = defaultPlan,
    public speakFn: FakeSpeakFn = () => ({ audio: silentWav(), mimeType: 'audio/wav' }),
    public delayMs = 0,
  ) {}

  async plan(input: PlanInput, signal: AbortSignal): Promise<RawPlan> {
    this.calls.push(input);
    await this.wait(signal);
    let context: any = null;
    try {
      context = JSON.parse(input.context.replace(/^[A-Z_]+:\s*/, ''));
    } catch {
      /* not JSON */
    }
    return this.planFn(input, { call: this.calls.length, context });
  }

  async speak(text: string, lang: Lang, signal: AbortSignal) {
    this.speakCalls.push({ text, lang });
    await this.wait(signal);
    return this.speakFn(text, lang);
  }

  private wait(signal: AbortSignal) {
    if (!this.delayMs) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new ProviderError('timeout', 'aborted'));
      });
    });
  }
}
