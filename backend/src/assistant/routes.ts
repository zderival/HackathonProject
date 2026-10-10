import { Type } from 'typebox';
import type { App } from '../app.js';
import { requireUser } from '../http/context.js';
import { AppError } from '../lib/errors.js';
import { isLang, LangSchema, type Lang } from '../lib/i18n.js';
import { ErrorResponse, GalleryIdParams } from '../schemas/api.js';
import { AUDIO_INPUT_FORMATS, validateAudio } from './audio.js';

const ConversationParams = Type.Object({ conversationId: Type.String({ format: 'uuid' }) });
const CommandParams = Type.Object({ commandId: Type.String({ format: 'uuid' }) });

const Conversation = Type.Object({
  id: Type.String(),
  galleryId: Type.String(),
  language: LangSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const Command = Type.Object(
  {
    id: Type.String({ description: 'Stable command ID: poll it, or wait for WebSocket "assistant" messages.' }),
    conversationId: Type.String(),
    galleryId: Type.String(),
    requestId: Type.String(),
    status: Type.Union(
      [
        Type.Literal('queued'),
        Type.Literal('processing'),
        Type.Literal('applied'),
        Type.Literal('needs_clarification'),
        Type.Literal('answered'),
        Type.Literal('failed'),
        Type.Literal('cancelled'),
      ],
      {
        description:
          'applied: the edit/undo/redo committed (see actionId/revision). needs_clarification: nothing changed; show reply + question. answered: question/suggestions only; nothing changed. failed: nothing changed; see error.',
      },
    ),
    final: Type.Boolean({ description: 'True once status will not change any more (speech may still become ready).' }),
    inputKind: Type.Union([Type.Literal('text'), Type.Literal('audio')]),
    text: Type.Union([Type.String(), Type.Null()]),
    transcript: Type.Union([Type.String(), Type.Null()], { description: 'What the model heard (audio input). Show it so users can correct mistakes.' }),
    language: LangSchema,
    intent: Type.Union([Type.String(), Type.Null()]),
    reply: Type.Union([Type.String(), Type.Null()], { description: 'Written reply in `language`. Available before speech.' }),
    question: Type.Union([Type.String(), Type.Null()], { description: 'Follow-up question (is it right? / clarification).' }),
    suggestions: Type.Array(Type.String(), { description: 'Optional ideas. Never applied unless the user asks.' }),
    actionId: Type.Union([Type.String(), Type.Null()], { description: 'Committed action (one undo step) when applied.' }),
    revision: Type.Union([Type.Integer(), Type.Null()]),
    error: Type.Union([Type.Object({ code: Type.String(), message: Type.String(), details: Type.Optional(Type.Unknown()) }), Type.Null()]),
    speech: Type.Object({
      status: Type.Union([Type.Literal('disabled'), Type.Literal('pending'), Type.Literal('ready'), Type.Literal('failed')]),
      path: Type.Union([Type.String(), Type.Null()], { description: 'GET this for a signed audio URL when ready.' }),
      error: Type.Union([Type.String(), Type.Null()]),
    }),
    createdAt: Type.String({ format: 'date-time' }),
    completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { title: 'AssistantCommand' },
);

const SelectedNodeIds = Type.Array(Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' }), { maxItems: 50 });

export async function assistantRoutes(app: App) {
  const { assistant, config, storage } = app.deps;
  const limits = config.assistant;

  app.post(
    '/v1/galleries/:galleryId/assistant/conversations',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Start an assistant conversation (editors)',
        description: 'Conversations are private to their creator and keep bounded history for follow-ups ("a little larger", "undo that").',
        params: GalleryIdParams,
        body: Type.Optional(Type.Object({ language: Type.Optional(LangSchema) }, { additionalProperties: false })),
        response: { 201: Conversation, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { userId } = requireUser(req);
      reply.code(201);
      return assistant.createConversation(req.params.galleryId, userId, req.body?.language ?? req.lang);
    },
  );

  app.get(
    '/v1/galleries/:galleryId/assistant/conversations',
    { schema: { tags: ['assistant'], summary: 'Your conversations in this gallery', params: GalleryIdParams, response: { 200: Type.Object({ items: Type.Array(Conversation) }) } } },
    async (req) => ({ items: await assistant.listConversations(req.params.galleryId, requireUser(req).userId) }),
  );

  app.get(
    '/v1/assistant/conversations/:conversationId/commands',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Conversation history (newest first)',
        params: ConversationParams,
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
          before: Type.Optional(Type.String({ format: 'date-time' })),
        }),
        response: { 200: Type.Object({ items: Type.Array(Command), nextBefore: Type.Union([Type.String(), Type.Null()]) }) },
      },
    },
    async (req) => assistant.commands(req.params.conversationId, requireUser(req).userId, { limit: req.query.limit ?? 20, before: req.query.before }),
  );

  app.post(
    '/v1/assistant/conversations/:conversationId/commands',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Send a typed command (asynchronous)',
        description:
          'Returns 202 with a queued command. Clear requests are applied immediately as ONE action (one undo step); unclear ones return needs_clarification without changing anything. Retrying with the same requestId returns the same command and never applies twice. Progress: GET /v1/assistant/commands/{id} or WebSocket "assistant" messages.',
        params: ConversationParams,
        body: Type.Object(
          {
            requestId: Type.String({ minLength: 8, maxLength: 100 }),
            text: Type.String({ minLength: 1, maxLength: limits.maxInputChars }),
            language: Type.Optional(LangSchema),
            audioEnabled: Type.Optional(Type.Boolean({ default: true, description: 'false = mute: no speech is generated.' })),
            selectedNodeIds: Type.Optional(SelectedNodeIds),
          },
          { additionalProperties: false },
        ),
        response: { 202: Command, 200: Command, 429: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { userId } = requireUser(req);
      const r = await assistant.submit({
        conversationId: req.params.conversationId,
        userId,
        requestId: req.body.requestId,
        text: req.body.text.trim(),
        language: req.body.language,
        audioEnabled: req.body.audioEnabled ?? true,
        selectedNodeIds: req.body.selectedNodeIds ?? [],
      });
      reply.code(r.duplicate ? 200 : 202);
      return r.command;
    },
  );

  app.post(
    '/v1/assistant/conversations/:conversationId/voice-commands',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Send a push-to-talk voice clip (multipart, asynchronous)',
        description: `multipart/form-data. Text fields first: requestId (required), language, audioEnabled ("true"/"false"), selectedNodeIds (JSON array), durationMs. Then the file part "audio": ${AUDIO_INPUT_FORMATS.join(', ')} (detected from content), at most ${limits.maxAudioBytes} bytes and ${limits.maxAudioSeconds} s. The transcript is returned on the command; unclear audio yields needs_clarification instead of an edit.`,
        consumes: ['multipart/form-data'],
        params: ConversationParams,
        response: { 202: Command, 200: Command, 413: ErrorResponse, 415: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { userId } = requireUser(req);
      if (!req.isMultipart()) throw new AppError('UNSUPPORTED_MEDIA_TYPE', { expected: 'multipart/form-data' });
      const fields: Record<string, string> = {};
      let audio: Buffer | null = null;
      for await (const part of req.parts({ limits: { fileSize: limits.maxAudioBytes, files: 1, fields: 10, fieldSize: 4000 } })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'audio') {
            part.file.resume();
            continue;
          }
          audio = await part.toBuffer();
          if (part.file.truncated) throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: limits.maxAudioBytes });
        } else fields[part.fieldname] = String(part.value);
      }
      if (!audio) throw new AppError('VALIDATION_FAILED', { field: 'audio', reason: 'missing audio part' });
      const requestId = fields.requestId ?? '';
      if (requestId.length < 8 || requestId.length > 100) throw new AppError('VALIDATION_FAILED', { field: 'requestId' });
      let language: Lang | undefined;
      if (fields.language) {
        if (!isLang(fields.language)) throw new AppError('VALIDATION_FAILED', { field: 'language' });
        language = fields.language;
      }
      let selectedNodeIds: string[] = [];
      if (fields.selectedNodeIds) {
        try {
          selectedNodeIds = JSON.parse(fields.selectedNodeIds);
        } catch {
          throw new AppError('VALIDATION_FAILED', { field: 'selectedNodeIds' });
        }
        if (!Array.isArray(selectedNodeIds) || selectedNodeIds.length > 50 || !selectedNodeIds.every((s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s)))
          throw new AppError('VALIDATION_FAILED', { field: 'selectedNodeIds' });
      }
      const declaredMs = fields.durationMs !== undefined ? Number(fields.durationMs) : undefined;
      if (declaredMs !== undefined && !(Number.isFinite(declaredMs) && declaredMs >= 0)) throw new AppError('VALIDATION_FAILED', { field: 'durationMs' });
      const checked = validateAudio(audio, { maxBytes: limits.maxAudioBytes, maxSeconds: limits.maxAudioSeconds, declaredMs });

      const r = await assistant.submit({
        conversationId: req.params.conversationId,
        userId,
        requestId,
        audio: { data: audio, mimeType: checked.mimeType },
        language,
        audioEnabled: fields.audioEnabled !== 'false',
        selectedNodeIds,
      });
      reply.code(r.duplicate ? 200 : 202);
      return r.command;
    },
  );

  app.get(
    '/v1/assistant/commands/:commandId',
    { schema: { tags: ['assistant'], summary: 'Command status and result', params: CommandParams, response: { 200: Command, 404: ErrorResponse } } },
    async (req) => assistant.get(req.params.commandId, requireUser(req).userId),
  );

  app.post(
    '/v1/assistant/commands/:commandId/cancel',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Cancel a queued/processing command',
        description: 'If the edit already committed, the command stays "applied" (use undo instead). Otherwise it becomes "cancelled" and nothing is changed.',
        params: CommandParams,
        response: { 200: Command },
      },
    },
    async (req) => assistant.cancel(req.params.commandId, requireUser(req).userId),
  );

  app.get(
    '/v1/assistant/commands/:commandId/speech',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Spoken reply: short-lived signed URL (when speech.status = ready)',
        params: CommandParams,
        response: {
          200: Type.Object({ commandId: Type.String(), mimeType: Type.String(), url: Type.String(), expiresAt: Type.String(), proxyPath: Type.String() }),
          404: ErrorResponse,
        },
      },
    },
    async (req) => {
      const { key: _k, ...rest } = await assistant.speech(req.params.commandId, requireUser(req).userId);
      return rest;
    },
  );

  app.get(
    '/v1/assistant/commands/:commandId/speech/audio',
    { schema: { tags: ['assistant'], summary: 'Spoken reply audio through the API (authorized proxy)', params: CommandParams } },
    async (req, reply) => {
      const s = await assistant.speech(req.params.commandId, requireUser(req).userId);
      const obj = await storage.getStream(s.key);
      reply.header('content-type', s.mimeType).header('cache-control', 'private, max-age=300');
      if (obj.contentLength) reply.header('content-length', obj.contentLength);
      return reply.send(obj.body);
    },
  );
}
