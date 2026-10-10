// Gemini assistant: gallery-scoped conversations and asynchronous commands.
//
// Flow for one command (typed text or a push-to-talk clip):
//   POST -> row 'queued' (idempotent by requestId) -> 202
//   worker: 'processing' -> model proposes a plan (no DB locks held) -> server validates
//   operations -> commits through ActionService (authorization + revision rechecked under
//   the gallery lock) -> 'applied' | 'needs_clarification' | 'answered' | 'failed'
//   -> written reply published (WebSocket + GET) -> optional speech generated afterwards.
// Speech failure never rolls back an edit or hides the written reply.
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ActionService, CommitResult } from '../actions/service.js';
import type { ObjectStorage } from '../assets/storage.js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { requireAccess } from '../galleries/access.js';
import { AppError, localizedMessage, type ErrorCode } from '../lib/errors.js';
import type { Lang } from '../lib/i18n.js';
import { RateLimiter } from '../lib/rate-limit.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { Operation, type OperationT } from '../schemas/operations.js';
import type { SceneT } from '../schemas/scene.js';
import { ajv } from '../scene/validate.js';
import { buildContext, systemInstruction } from './prompt.js';
import { ProviderError, type AssistantProvider, type RawPlan } from './provider.js';

// One validator per operation name, so a rejected plan gets precise error messages
// (validating against the whole union reports errors from every branch).
const opValidators = new Map((Operation.anyOf as any[]).map((s) => [s.properties.op.const as string, ajv.compile(s)]));

export type CommandStatus = 'queued' | 'processing' | 'applied' | 'needs_clarification' | 'answered' | 'failed' | 'cancelled';
const FINAL: CommandStatus[] = ['applied', 'needs_clarification', 'answered', 'failed', 'cancelled'];

// Server-written assistant text (used when the model's text is unavailable or must not be trusted).
const TEXT: Record<'confirm' | 'unclearAudio' | 'nothingChanged' | 'undone' | 'redone' | 'interrupted' | 'retryConflict', Record<Lang, string>> = {
  confirm: {
    en: 'Does this look right, or should I adjust anything?',
    ht: 'Èske sa bon konsa, oswa ou vle m ajiste yon bagay?',
    fr: 'Est-ce que cela vous convient, ou faut-il ajuster quelque chose ?',
    es: '¿Se ve bien así o quieres que ajuste algo?',
    ko: '이대로 괜찮으신가요, 아니면 조정할까요?',
  },
  unclearAudio: {
    en: "I couldn't hear that clearly. Could you repeat it or type it?",
    ht: 'Mwen pa t tande sa byen. Èske ou ka repete l oswa ekri l?',
    fr: "Je n'ai pas bien compris. Pouvez-vous répéter ou l'écrire ?",
    es: 'No lo escuché con claridad. ¿Puedes repetirlo o escribirlo?',
    ko: '잘 들리지 않았어요. 다시 말씀하시거나 입력해 주시겠어요?',
  },
  nothingChanged: {
    en: 'That is already the case, so nothing needed to change.',
    ht: 'Se deja konsa, kidonk pa t gen anyen pou chanje.',
    fr: "C'est déjà le cas, rien n'a donc été modifié.",
    es: 'Ya está así, así que no hizo falta cambiar nada.',
    ko: '이미 그렇게 되어 있어서 변경할 것이 없었습니다.',
  },
  undone: {
    en: 'I undid that change.',
    ht: 'Mwen anile chanjman sa a.',
    fr: "J'ai annulé cette modification.",
    es: 'Deshice ese cambio.',
    ko: '그 변경을 실행 취소했습니다.',
  },
  redone: {
    en: 'I re-applied that change.',
    ht: 'Mwen refè chanjman sa a.',
    fr: "J'ai rétabli cette modification.",
    es: 'Volví a aplicar ese cambio.',
    ko: '그 변경을 다시 적용했습니다.',
  },
  interrupted: {
    en: 'The server restarted before this request finished. Nothing was changed; please try again.',
    ht: 'Sèvè a te rekòmanse anvan demann sa a te fini. Anyen pa t chanje; tanpri eseye ankò.',
    fr: "Le serveur a redémarré avant la fin de cette demande. Rien n'a été modifié ; veuillez réessayer.",
    es: 'El servidor se reinició antes de terminar esta solicitud. No se cambió nada; inténtalo de nuevo.',
    ko: '요청이 끝나기 전에 서버가 다시 시작되었습니다. 아무것도 변경되지 않았으니 다시 시도해 주세요.',
  },
  retryConflict: {
    en: 'Someone else changed the same items while I was working. Nothing was changed; please ask again.',
    ht: 'Yon lòt moun chanje menm bagay yo pandan m t ap travay. Anyen pa t chanje; tanpri mande ankò.',
    fr: "Quelqu'un a modifié les mêmes éléments pendant que je travaillais. Rien n'a été modifié ; redemandez.",
    es: 'Otra persona cambió los mismos elementos mientras trabajaba. No se cambió nada; vuelve a pedirlo.',
    ko: '작업 중에 다른 사람이 같은 항목을 변경했습니다. 아무것도 변경되지 않았으니 다시 요청해 주세요.',
  },
};

export interface SubmitInput {
  conversationId: string;
  userId: string;
  requestId: string;
  text?: string;
  audio?: { data: Buffer; mimeType: string };
  language?: Lang;
  audioEnabled: boolean;
  selectedNodeIds: string[];
}

export class AssistantService {
  private queue: string[] = [];
  private running = 0;
  private controllers = new Map<string, AbortController>();
  private limiter: RateLimiter;
  private idle: (() => void)[] = [];

  constructor(
    private deps: {
      db: Db;
      config: Config;
      actions: ActionService;
      storage: ObjectStorage;
      hub: RealtimeHub;
      provider: AssistantProvider | null;
      log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
    },
  ) {
    this.limiter = new RateLimiter(deps.config.assistant.commandsPerMinute, 60_000);
  }

  get enabled() {
    return this.deps.provider !== null;
  }

  get providerName() {
    return this.deps.provider?.name ?? 'disabled';
  }

  // ---- Conversations -------------------------------------------------------

  async createConversation(galleryId: string, userId: string, language: Lang) {
    await requireAccess(this.deps.db, galleryId, { userId }, 'edit');
    const { rows } = await this.deps.db.query(
      `INSERT INTO ai_conversations (gallery_id, user_id, language) VALUES ($1, $2, $3) RETURNING *`,
      [galleryId, userId, language],
    );
    return publicConversation(rows[0]);
  }

  async listConversations(galleryId: string, userId: string) {
    const { rows } = await this.deps.db.query(
      `SELECT * FROM ai_conversations WHERE gallery_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 50`,
      [galleryId, userId],
    );
    return rows.map(publicConversation);
  }

  // Conversations are private to the user who created them.
  async conversation(conversationId: string, userId: string) {
    const { rows } = await this.deps.db.query(`SELECT * FROM ai_conversations WHERE id = $1 AND user_id = $2`, [conversationId, userId]);
    if (!rows[0]) throw new AppError('NOT_FOUND', { what: 'conversation' });
    await requireAccess(this.deps.db, rows[0].gallery_id, { userId }, 'view');
    return rows[0];
  }

  async commands(conversationId: string, userId: string, opts: { limit: number; before?: string }) {
    await this.conversation(conversationId, userId);
    const { rows } = await this.deps.db.query(
      `SELECT * FROM ai_commands WHERE conversation_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC LIMIT $3`,
      [conversationId, opts.before ?? null, opts.limit + 1],
    );
    const items = rows.slice(0, opts.limit).map((r) => this.publicCommand(r));
    return { items, nextBefore: rows.length > opts.limit ? items[items.length - 1].createdAt : null };
  }

  // ---- Commands --------------------------------------------------------------

  async submit(input: SubmitInput) {
    const conv = await this.conversation(input.conversationId, input.userId);
    await requireAccess(this.deps.db, conv.gallery_id, { userId: input.userId }, 'edit');
    if (!this.deps.provider) throw new AppError('AI_UNAVAILABLE', { reason: 'assistant is not configured (GEMINI_API_KEY)' });

    const existing = await this.deps.db.query(`SELECT * FROM ai_commands WHERE user_id = $1 AND request_id = $2`, [input.userId, input.requestId]);
    if (existing.rows[0]) {
      const r = existing.rows[0];
      if (r.conversation_id !== input.conversationId || (r.input_text ?? null) !== (input.text ?? null) || r.input_kind !== (input.audio ? 'audio' : 'text'))
        throw new AppError('IDEMPOTENCY_MISMATCH', { requestId: input.requestId });
      return { command: this.publicCommand(r), duplicate: true };
    }
    if (!this.limiter.take(input.userId)) throw new AppError('RATE_LIMITED', { perMinute: this.deps.config.assistant.commandsPerMinute });

    const language = input.language ?? (conv.language as Lang);
    let audioKey: string | null = null;
    if (input.audio) {
      audioKey = `galleries/${conv.gallery_id}/assistant-input/${randomUUID()}-${randomBytes(8).toString('hex')}`;
      await this.deps.storage.put(audioKey, input.audio.data, input.audio.mimeType);
    }
    let row: any;
    try {
      const { rows } = await this.deps.db.query(
        `INSERT INTO ai_commands (conversation_id, gallery_id, user_id, request_id, input_kind, input_text, audio_key, audio_mime,
                                  language, audio_enabled, selected_node_ids, status, speech_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'queued', $12) RETURNING *`,
        [
          conv.id,
          conv.gallery_id,
          input.userId,
          input.requestId,
          input.audio ? 'audio' : 'text',
          input.text ?? null,
          audioKey,
          input.audio?.mimeType ?? null,
          language,
          input.audioEnabled,
          JSON.stringify(input.selectedNodeIds),
          input.audioEnabled ? 'pending' : 'disabled',
        ],
      );
      row = rows[0];
    } catch (err: any) {
      if (err.code === '23505') {
        // Concurrent duplicate submit: return the winner.
        const { rows } = await this.deps.db.query(`SELECT * FROM ai_commands WHERE user_id = $1 AND request_id = $2`, [input.userId, input.requestId]);
        return { command: this.publicCommand(rows[0]), duplicate: true };
      }
      throw err;
    }
    await this.deps.db.query(`UPDATE ai_conversations SET updated_at = now(), language = $2 WHERE id = $1`, [conv.id, language]);
    this.enqueue(row.id);
    return { command: this.publicCommand(row), duplicate: false };
  }

  async get(commandId: string, userId: string) {
    const row = await this.row(commandId, userId);
    return this.publicCommand(row);
  }

  async cancel(commandId: string, userId: string) {
    await this.row(commandId, userId);
    // Takes the row lock: a commit in progress finalizes first and wins.
    const { rows } = await this.deps.db.query(
      `UPDATE ai_commands SET status = 'cancelled', error_code = 'AI_CANCELLED', speech_status = CASE WHEN speech_status = 'pending' THEN 'disabled' ELSE speech_status END,
              completed_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'processing') RETURNING *`,
      [commandId],
    );
    this.controllers.get(commandId)?.abort();
    const row = rows[0] ?? (await this.row(commandId, userId));
    if (rows[0]) this.notify(row);
    return this.publicCommand(row);
  }

  async speech(commandId: string, userId: string) {
    const row = await this.row(commandId, userId);
    if (row.speech_status !== 'ready') throw new AppError('NOT_FOUND', { what: 'speech', speechStatus: row.speech_status });
    const ttl = this.deps.config.signedUrlTtlSec;
    return {
      commandId,
      mimeType: row.speech_mime as string,
      url: await this.deps.storage.signedGetUrl(row.speech_key, ttl, { contentType: row.speech_mime }),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      proxyPath: `/v1/assistant/commands/${commandId}/speech/audio`,
      key: row.speech_key as string,
    };
  }

  private async row(commandId: string, userId: string) {
    const { rows } = await this.deps.db.query(`SELECT * FROM ai_commands WHERE id = $1 AND user_id = $2`, [commandId, userId]);
    if (!rows[0]) throw new AppError('NOT_FOUND', { what: 'command' });
    await requireAccess(this.deps.db, rows[0].gallery_id, { userId }, 'view');
    return rows[0];
  }

  // On startup: commands interrupted mid-flight are failed (their edit, if it committed,
  // is already final via the transactional status update); queued ones are resumed.
  async recover() {
    const { rows } = await this.deps.db.query(
      `UPDATE ai_commands SET status = 'failed', error_code = 'SERVICE_UNAVAILABLE', reply_text = NULL, completed_at = now(), updated_at = now(),
              speech_status = CASE WHEN speech_status = 'pending' THEN 'disabled' ELSE speech_status END
       WHERE status = 'processing' RETURNING id`,
    );
    await this.deps.db.query(`UPDATE ai_commands SET speech_status = 'failed', speech_error = 'interrupted' WHERE speech_status = 'pending' AND status IN ('applied', 'needs_clarification', 'answered', 'failed')`);
    const queued = await this.deps.db.query(`SELECT id FROM ai_commands WHERE status = 'queued' ORDER BY created_at`);
    for (const r of queued.rows) this.enqueue(r.id);
    return { interrupted: rows.length, resumed: queued.rows.length };
  }

  // Resolves when no command is queued or running (tests and graceful shutdown).
  whenIdle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  shutdown() {
    this.queue = [];
    for (const c of this.controllers.values()) c.abort();
  }

  private enqueue(id: string) {
    this.queue.push(id);
    this.pump();
  }

  private pump() {
    while (this.running < this.deps.config.assistant.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      void this.process(id)
        .catch((err) => this.deps.log.error({ err, commandId: id }, 'assistant command crashed'))
        .finally(() => {
          this.running--;
          this.pump();
          if (!this.running && !this.queue.length) for (const r of this.idle.splice(0)) r();
        });
    }
  }

  // ---- Processing ------------------------------------------------------------

  private async process(id: string) {
    const { db } = this.deps;
    const { rows } = await db.query(`UPDATE ai_commands SET status = 'processing', updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING *`, [id]);
    const cmd = rows[0];
    if (!cmd) return;
    this.notify(cmd);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const outcome = await this.plan(cmd, controller.signal);
      await this.finish(cmd, outcome);
    } catch (err) {
      const e = err instanceof AppError ? err : null;
      if (!e) this.deps.log.error({ err, commandId: id }, 'assistant processing failed');
      await this.finish(cmd, { status: 'failed', errorCode: e?.code ?? 'INTERNAL', errorDetails: e?.details });
    } finally {
      this.controllers.delete(id);
    }
  }

  private async plan(cmd: any, signal: AbortSignal): Promise<Outcome> {
    const lang = cmd.language as Lang;
    const userId = cmd.user_id as string;
    const galleryId = cmd.gallery_id as string;
    const principal = { userId };
    await requireAccess(this.deps.db, galleryId, principal, 'edit');

    let audio: { data: Buffer; mimeType: string } | undefined;
    if (cmd.input_kind === 'audio') {
      const obj = await this.deps.storage.getStream(cmd.audio_key);
      const chunks: Buffer[] = [];
      for await (const c of obj.body) chunks.push(c as Buffer);
      audio = { data: Buffer.concat(chunks), mimeType: cmd.audio_mime };
    }

    let repair: { previousPlan: unknown; error: string } | undefined;
    let repairsLeft = 1;
    let regroundsLeft = 1;
    let transcript: string | null = null;
    for (;;) {
      const { rows } = await this.deps.db.query(`SELECT scene, revision FROM galleries WHERE id = $1 AND deleted_at IS NULL`, [galleryId]);
      if (!rows[0]) throw new AppError('NOT_FOUND', { what: 'gallery' });
      const scene = rows[0].scene as SceneT;
      const revision = rows[0].revision as number;
      const context = buildContext({
        replyLanguage: lang,
        revision,
        scene,
        selectedNodeIds: cmd.selected_node_ids,
        assets: await this.assetsFor(galleryId),
        recentActions: await this.recentActions(galleryId, userId),
        conversation: await this.history(cmd),
        maxNodes: this.deps.config.assistant.maxContextNodes,
        inputKind: cmd.input_kind,
      });

      let plan: RawPlan;
      try {
        plan = normalizePlan(await this.callProvider((s) => this.deps.provider!.plan({ systemInstruction: systemInstruction(), context, text: cmd.input_text ?? undefined, audio, repair }, s), signal, this.deps.config.assistant.timeoutMs));
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'malformed' && repairsLeft-- > 0) {
          repair = { previousPlan: null, error: `your response was not valid JSON for the schema (${err.message})` };
          continue;
        }
        throw err;
      }
      transcript = plan.transcript ?? transcript;
      if (await this.isCancelled(cmd.id)) throw new AppError('AI_CANCELLED');
      const base = { transcript, intent: plan.intent, plan };

      // Unclear audio is never acted on: ask for a repeat / typed correction.
      if (audio && (plan.transcriptConfidence === 'low' || !transcript?.trim()) && plan.intent !== 'answer') {
        return { ...base, status: 'needs_clarification', intent: 'clarify', reply: plan.intent === 'clarify' && plan.reply ? plan.reply : TEXT.unclearAudio[lang], question: plan.question };
      }

      if (plan.intent === 'clarify' || plan.intent === 'unsupported' || (plan.intent === 'edit' && !plan.operations.length)) {
        return { ...base, status: 'needs_clarification', reply: plan.reply, question: plan.question, suggestions: plan.suggestions };
      }
      if (plan.intent === 'answer') return { ...base, status: 'answered', reply: plan.reply, question: plan.question, suggestions: plan.suggestions };

      const actionId = randomUUID();
      const hooks = { aiCommandId: cmd.id, beforeCommit: (client: pg.PoolClient) => this.claimForCommit(client, cmd.id, actionId) };
      if (plan.intent === 'undo' || plan.intent === 'redo') {
        try {
          const r =
            plan.intent === 'undo'
              ? await this.deps.actions.undo(galleryId, principal, { requestId: `ai:${cmd.id}`, actionId: await this.undoTarget(cmd, plan.undoActionId), ...hooks })
              : await this.deps.actions.redo(galleryId, principal, { requestId: `ai:${cmd.id}`, ...hooks });
          return { ...base, status: 'applied', result: r, reply: plan.intent === 'undo' ? TEXT.undone[lang] : TEXT.redone[lang], question: TEXT.confirm[lang], suggestions: [] };
        } catch (err) {
          if (err instanceof AppError && ['UNDO_CONFLICT', 'NOTHING_TO_UNDO', 'NOTHING_TO_REDO'].includes(err.code))
            return { ...base, status: 'failed', errorCode: err.code, errorDetails: err.details };
          throw err;
        }
      }

      // intent === 'edit': parse and validate every proposed operation before committing.
      const parsed = parseOperations(plan);
      if ('error' in parsed) {
        if (repairsLeft-- > 0) {
          repair = { previousPlan: plan, error: parsed.error };
          continue;
        }
        return { ...base, status: 'failed', errorCode: 'AI_INVALID_PLAN', errorDetails: { reason: parsed.error } };
      }
      try {
        const result = await this.deps.actions.commit({
          galleryId,
          principal,
          source: 'ai',
          requestId: `ai:${cmd.id}`,
          actionId,
          // The plan was made against `revision`; merge mode commits it on top of newer
          // unrelated edits but refuses if anyone touched the same properties since.
          baseRevision: revision,
          conflictMode: 'merge',
          label: `Assistant: ${String(cmd.input_text ?? transcript ?? 'voice command').slice(0, 80)}`,
          ops: parsed.ops,
          ...hooks,
        });
        if (result.noop) return { ...base, status: 'answered', reply: TEXT.nothingChanged[lang], question: null, suggestions: plan.suggestions };
        return { ...base, status: 'applied', result, reply: plan.reply, question: plan.question || TEXT.confirm[lang], suggestions: plan.suggestions };
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        if (err.code === 'REVISION_CONFLICT' && regroundsLeft-- > 0) {
          repair = undefined; // re-plan against the latest scene
          continue;
        }
        if (err.code === 'REVISION_CONFLICT') return { ...base, status: 'failed', errorCode: 'REVISION_CONFLICT', reply: TEXT.retryConflict[lang], errorDetails: err.details };
        if (['INVALID_SCENE', 'INVALID_REFERENCE', 'UNSUPPORTED_OPERATION', 'VALIDATION_FAILED', 'LIMIT_EXCEEDED'].includes(err.code)) {
          if (repairsLeft-- > 0) {
            repair = { previousPlan: plan, error: `${err.code}: ${JSON.stringify(err.details ?? {})}` };
            continue;
          }
          return { ...base, status: 'failed', errorCode: 'AI_INVALID_PLAN', errorDetails: { serverError: err.code, ...(err.details ?? {}) } };
        }
        throw err;
      }
    }
  }

  // Inside the commit transaction: lock the command row, refuse if it was cancelled,
  // and mark it applied atomically with the scene change.
  private async claimForCommit(client: pg.PoolClient, commandId: string, actionId: string) {
    const { rows } = await client.query(`SELECT status FROM ai_commands WHERE id = $1 FOR UPDATE`, [commandId]);
    if (rows[0]?.status !== 'processing') throw new AppError('AI_CANCELLED');
    await client.query(`UPDATE ai_commands SET status = 'applied', action_id = $2, updated_at = now() WHERE id = $1`, [commandId, actionId]);
  }

  private async isCancelled(id: string) {
    const { rows } = await this.deps.db.query(`SELECT status FROM ai_commands WHERE id = $1`, [id]);
    return rows[0]?.status === 'cancelled';
  }

  // "undo that": the model may name an action from recentActions; it must be one of the
  // user's own actions. Default: the latest action applied by this conversation.
  private async undoTarget(cmd: any, requested: string | null): Promise<string | undefined> {
    if (requested && /^[0-9a-f-]{36}$/i.test(requested)) {
      const { rows } = await this.deps.db.query(
        `SELECT 1 FROM gallery_actions WHERE gallery_id = $1 AND actor_id = $2 AND action_id = $3`,
        [cmd.gallery_id, cmd.user_id, requested],
      );
      if (rows[0]) return requested;
    }
    const { rows } = await this.deps.db.query(
      `SELECT a.action_id FROM gallery_actions a JOIN ai_commands c ON c.id = a.ai_command_id
       WHERE c.conversation_id = $1 AND a.source IN ('ai', 'redo') AND NOT a.undone ORDER BY a.revision DESC LIMIT 1`,
      [cmd.conversation_id],
    );
    return rows[0]?.action_id;
  }

  private async callProvider<T>(fn: (signal: AbortSignal) => Promise<T>, outer: AbortSignal, timeoutMs: number): Promise<T> {
    const maxRetries = this.deps.config.assistant.maxRetries;
    for (let attempt = 0; ; attempt++) {
      if (outer.aborted) throw new AppError('AI_CANCELLED');
      const signal = AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]);
      try {
        return await fn(signal);
      } catch (err) {
        if (outer.aborted) throw new AppError('AI_CANCELLED');
        const kind = err instanceof ProviderError ? err.kind : signal.aborted ? 'timeout' : 'fatal';
        if ((kind === 'retryable' || kind === 'timeout') && attempt < maxRetries) {
          await sleep(Math.min(4000, 400 * 2 ** attempt) + Math.random() * 200);
          continue;
        }
        if (kind === 'timeout') throw new AppError('AI_TIMEOUT');
        if (kind === 'malformed') throw err;
        this.deps.log.warn({ err: String((err as Error)?.message ?? err) }, 'assistant provider error');
        throw new AppError('AI_UNAVAILABLE');
      }
    }
  }

  private async finish(cmd: any, o: Outcome) {
    const lang = cmd.language as Lang;
    const reply = o.status === 'failed' ? (o.reply ?? localizedMessage((o.errorCode ?? 'INTERNAL') as ErrorCode, lang)) : (o.reply ?? '');
    const speak = cmd.audio_enabled && reply && o.status !== 'cancelled';
    // Applied commands were already marked 'applied' inside the commit transaction;
    // every other outcome must not overwrite a cancellation.
    const { rows } = await this.deps.db.query(
      `UPDATE ai_commands SET status = $2, intent = $3, transcript = $4, reply_text = $5, question = $6, suggestions = $7::jsonb,
              plan = $8::jsonb, action_id = COALESCE($9, action_id), revision = $10, error_code = $11, error_details = $12::jsonb,
              speech_status = $13, completed_at = now(), updated_at = now()
       WHERE id = $1 AND (status = 'processing' OR (status = 'applied' AND $2 = 'applied')) RETURNING *`,
      [
        cmd.id,
        o.status,
        o.intent ?? null,
        o.transcript ?? null,
        reply,
        o.question ?? null,
        JSON.stringify((o.suggestions ?? []).slice(0, 3)),
        o.plan ? JSON.stringify(o.plan) : null,
        o.result?.actionId ?? null,
        o.result?.revision ?? null,
        o.errorCode ?? null,
        o.errorDetails ? JSON.stringify(o.errorDetails) : null,
        speak ? 'pending' : 'disabled',
      ],
    );
    const row = rows[0];
    if (!row) return; // cancelled meanwhile
    this.notify(row);
    if (speak) await this.synthesize(row, [reply, o.status === 'applied' || o.status === 'needs_clarification' ? o.question : null].filter(Boolean).join(' '));
  }

  private async synthesize(row: any, text: string) {
    const lang = row.language as Lang;
    let update: { status: 'ready' | 'failed'; key?: string; mime?: string; error?: string };
    try {
      const out = await this.callProvider((s) => this.deps.provider!.speak(text.slice(0, this.deps.config.assistant.maxSpeechChars), lang, s), new AbortController().signal, this.deps.config.assistant.ttsTimeoutMs);
      const ext = out.mimeType.includes('wav') ? 'wav' : out.mimeType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
      const key = `galleries/${row.gallery_id}/speech/${row.id}-${randomBytes(8).toString('hex')}.${ext}`;
      await this.deps.storage.put(key, out.audio, out.mimeType);
      update = { status: 'ready', key, mime: out.mimeType };
    } catch (err) {
      update = { status: 'failed', error: err instanceof AppError ? err.code : String((err as Error)?.message ?? err).slice(0, 200) };
      this.deps.log.warn({ commandId: row.id, error: update.error }, 'speech generation failed (edit and written reply unaffected)');
    }
    const { rows } = await this.deps.db.query(
      `UPDATE ai_commands SET speech_status = $2, speech_key = $3, speech_mime = $4, speech_error = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id, update.status, update.key ?? null, update.mime ?? null, update.error ?? null],
    );
    this.notify(rows[0]);
  }

  private notify(row: any) {
    this.deps.hub.sendToUser(row.gallery_id, row.user_id, { type: 'assistant', command: this.publicCommand(row) });
  }

  // ---- Context ---------------------------------------------------------------

  private async assetsFor(galleryId: string) {
    const { rows } = await this.deps.db.query(
      `SELECT id, title, width, height FROM assets WHERE gallery_id = $1 AND status = 'ready' ORDER BY created_at DESC LIMIT 50`,
      [galleryId],
    );
    return rows;
  }

  private async recentActions(galleryId: string, userId: string) {
    const { rows } = await this.deps.db.query(
      `SELECT action_id, revision, source, label, undone, ai_command_id, changes, actor_id = $2 AS mine FROM gallery_actions
       WHERE gallery_id = $1 ORDER BY revision DESC LIMIT 6`,
      [galleryId, userId],
    );
    return rows.map((r) => ({
      actionId: r.action_id,
      revision: r.revision,
      byMe: r.mine,
      source: r.source,
      label: r.label,
      undone: r.undone,
      fromThisAssistant: !!r.ai_command_id,
      changes: (r.changes as any[]).slice(0, 20).map((c) =>
        c.kind === 'node.set' || c.kind === 'scene.set'
          ? { kind: c.kind, nodeId: c.nodeId, path: c.path, before: c.before, after: c.after }
          : { kind: c.kind, nodeId: c.node.id, type: c.node.type, name: c.node.name },
      ),
    }));
  }

  private async history(cmd: any) {
    const { rows } = await this.deps.db.query(
      `SELECT input_text, transcript, reply_text, question, status, action_id FROM ai_commands
       WHERE conversation_id = $1 AND created_at < $2 AND status NOT IN ('queued', 'processing')
       ORDER BY created_at DESC LIMIT $3`,
      [cmd.conversation_id, cmd.created_at, this.deps.config.assistant.maxHistoryTurns],
    );
    return rows.reverse().map((r) => ({
      user: String(r.input_text ?? r.transcript ?? '').slice(0, 500),
      assistant: [r.reply_text, r.question].filter(Boolean).join(' ').slice(0, 500),
      status: r.status,
      actionId: r.action_id,
    }));
  }

  publicCommand(r: any) {
    const lang = r.language as Lang;
    return {
      id: r.id as string,
      conversationId: r.conversation_id as string,
      galleryId: r.gallery_id as string,
      requestId: r.request_id as string,
      status: r.status as CommandStatus,
      final: FINAL.includes(r.status),
      inputKind: r.input_kind as 'text' | 'audio',
      text: r.input_text as string | null,
      transcript: r.transcript as string | null,
      language: lang,
      intent: r.intent as string | null,
      reply: r.reply_text as string | null,
      question: r.question as string | null,
      suggestions: (r.suggestions ?? []) as string[],
      actionId: r.action_id as string | null,
      revision: r.revision as number | null,
      error: r.error_code ? { code: r.error_code as string, message: localizedMessage(r.error_code as ErrorCode, lang) ?? r.error_code, details: r.error_details ?? undefined } : null,
      speech: {
        status: r.speech_status as 'disabled' | 'pending' | 'ready' | 'failed',
        path: r.speech_status === 'ready' ? `/v1/assistant/commands/${r.id}/speech` : null,
        error: r.speech_error as string | null,
      },
      createdAt: new Date(r.created_at).toISOString(),
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    };
  }
}

interface Outcome {
  status: CommandStatus;
  intent?: string;
  transcript?: string | null;
  reply?: string | null;
  question?: string | null;
  suggestions?: string[];
  plan?: RawPlan;
  result?: CommitResult;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
}

const INTENTS = ['edit', 'undo', 'redo', 'clarify', 'answer', 'unsupported'];

// Defensive normalization: the model output is untrusted even with a response schema.
export function normalizePlan(p: any): RawPlan {
  if (!p || typeof p !== 'object') throw new ProviderError('malformed', 'plan is not an object');
  if (!INTENTS.includes(p.intent)) throw new ProviderError('malformed', `unknown intent ${JSON.stringify(p.intent)}`);
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);
  return {
    transcript: str(p.transcript, 2000),
    transcriptConfidence: p.transcriptConfidence === 'low' ? 'low' : 'high',
    detectedLanguage: ['en', 'ht', 'fr', 'es', 'ko'].includes(p.detectedLanguage) ? p.detectedLanguage : 'other',
    intent: p.intent,
    operations: Array.isArray(p.operations) ? p.operations.slice(0, 200) : [],
    undoActionId: str(p.undoActionId, 64),
    reply: str(p.reply, 1000) ?? '',
    question: str(p.question, 500),
    suggestions: Array.isArray(p.suggestions) ? p.suggestions.filter((s: unknown) => typeof s === 'string').slice(0, 3).map((s: string) => s.slice(0, 300)) : [],
  };
}

// Builds operations from {op, argsJson} pairs. Only allowlisted operation names pass the
// TypeBox schema; anything else is rejected with a reason fed back to the model.
export function parseOperations(plan: RawPlan): { ops: OperationT[] } | { error: string } {
  const out: OperationT[] = [];
  for (const [i, item] of plan.operations.entries()) {
    if (!item || typeof item !== 'object' || typeof (item as any).op !== 'string') return { error: `operations[${i}] is malformed` };
    let args: unknown;
    try {
      args = typeof item.argsJson === 'string' ? JSON.parse(item.argsJson) : {};
    } catch {
      return { error: `operations[${i}].argsJson is not valid JSON` };
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: `operations[${i}].argsJson must be a JSON object` };
    const op = { ...(args as object), op: item.op };
    const validate = opValidators.get(item.op);
    if (!validate) return { error: `operations[${i}]: unknown operation ${JSON.stringify(item.op)}` };
    if (!validate(op))
      return { error: `operations[${i}] (${item.op}) is invalid: ${(validate.errors ?? []).slice(0, 4).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}` };
    out.push(op as OperationT);
  }
  return { ops: out };
}

function publicConversation(r: any) {
  return { id: r.id, galleryId: r.gallery_id, language: r.language, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
