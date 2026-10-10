// Assistant model provider interface. The model only PROPOSES a plan; the server
// validates it against the operation schema, authorizes it and commits it through the
// same pipeline as manual edits. Nothing the model returns is ever executed as code.
import { OPERATION_NAMES } from '../schemas/operations.js';
import type { Lang } from '../lib/i18n.js';

export type Intent = 'edit' | 'undo' | 'redo' | 'clarify' | 'answer' | 'unsupported';

export interface PlanInput {
  systemInstruction: string;
  // JSON context: scene summary, selection, assets, recent turns/actions. Untrusted
  // strings (names, titles, descriptions) are embedded as JSON data only.
  context: string;
  text?: string;
  audio?: { data: Buffer; mimeType: string };
  // Present on a repair attempt: why the previous plan was rejected.
  repair?: { previousPlan: unknown; error: string };
}

export interface RawPlan {
  transcript: string | null;
  transcriptConfidence: 'high' | 'low';
  detectedLanguage: Lang | 'other';
  intent: Intent;
  operations: { op: string; argsJson: string }[];
  undoActionId: string | null;
  reply: string;
  question: string | null;
  suggestions: string[];
}

export interface AssistantProvider {
  readonly name: string;
  plan(input: PlanInput, signal: AbortSignal): Promise<RawPlan>;
  speak(text: string, lang: Lang, signal: AbortSignal): Promise<{ audio: Buffer; mimeType: string }>;
}

// Errors from providers are normalized to these, so retries/timeouts behave the same
// for every provider.
export class ProviderError extends Error {
  constructor(
    readonly kind: 'timeout' | 'retryable' | 'fatal' | 'malformed',
    message: string,
  ) {
    super(message);
  }
}

// JSON Schema for the plan (kept inside Gemini's supported structured-output subset:
// object/array/string/enum/nullable types). Operation arguments are carried as JSON
// strings and validated server-side against the full TypeBox operation schema.
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    transcript: {
      type: ['string', 'null'],
      description: 'Audio input only: verbatim transcript in the language actually spoken. null for typed input.',
    },
    transcriptConfidence: { type: 'string', enum: ['high', 'low'], description: 'low if the audio was unclear, noisy or ambiguous.' },
    detectedLanguage: { type: 'string', enum: ['en', 'ht', 'fr', 'es', 'ko', 'other'] },
    intent: { type: 'string', enum: ['edit', 'undo', 'redo', 'clarify', 'answer', 'unsupported'] },
    operations: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: OPERATION_NAMES },
          argsJson: { type: 'string', description: 'JSON object with the operation fields except "op".' },
        },
        required: ['op', 'argsJson'],
      },
    },
    undoActionId: { type: ['string', 'null'], description: 'For intent=undo: actionId from recentActions to undo; null = the latest one.' },
    reply: { type: 'string', description: 'Short reply to the user in the reply language.' },
    question: {
      type: ['string', 'null'],
      description: 'intent=edit: ask whether the result is right or needs refinement. intent=clarify: the focused clarification question.',
    },
    suggestions: { type: 'array', maxItems: 3, items: { type: 'string' }, description: 'Optional further ideas. Never applied unless the user asks.' },
  },
  required: ['transcript', 'transcriptConfidence', 'detectedLanguage', 'intent', 'operations', 'undoActionId', 'reply', 'question', 'suggestions'],
} as const;
