import { Type } from 'typebox';
import type { App } from '../app.js';
import { requireAccess } from '../galleries/access.js';
import { principalFor, requireUser } from '../http/context.js';
import { ErrorResponse, GalleryIdParams } from '../schemas/api.js';
import { ActionRequest, WireChange } from '../schemas/operations.js';

export const ActionResult = Type.Object({
  galleryId: Type.String(),
  actionId: Type.String(),
  requestId: Type.String(),
  revision: Type.Integer({ description: 'Gallery revision after this action (unchanged when noop).' }),
  baseRevision: Type.Integer(),
  duplicate: Type.Boolean({ description: 'True when this requestId was already committed; nothing was applied twice.' }),
  noop: Type.Boolean({ description: 'True when the ops changed nothing; no revision was created.' }),
  changes: Type.Array(WireChange),
});

const OpsEventSchema = Type.Object({
  type: Type.Literal('ops'),
  eventId: Type.String(),
  galleryId: Type.String(),
  revision: Type.Integer(),
  baseRevision: Type.Integer(),
  actionId: Type.String(),
  requestId: Type.String(),
  source: Type.String(),
  actor: Type.Union([Type.Object({ userId: Type.String(), displayName: Type.String() }), Type.Null()]),
  label: Type.Union([Type.String(), Type.Null()]),
  undoOf: Type.Union([Type.Integer(), Type.Null()]),
  redoOf: Type.Union([Type.Integer(), Type.Null()]),
  ts: Type.String(),
  changes: Type.Array(WireChange),
});

export async function actionRoutes(app: App) {
  const { db, actions } = app.deps;

  app.post(
    '/v1/galleries/:galleryId/actions',
    {
      schema: {
        tags: ['scene'],
        summary: 'Apply an atomic batch of scene operations',
        description:
          'All ops apply or none do. Retry with the same requestId after a network failure: a committed request returns duplicate=true instead of applying twice. On 409 REVISION_CONFLICT, load the latest scene (or replay events), rebase the edit and resubmit with a new requestId.',
        params: GalleryIdParams,
        body: ActionRequest,
        response: { 200: ActionResult, 409: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (req) => {
      const { userId } = requireUser(req);
      const principal = { ...principalFor(req, req.params.galleryId), userId };
      const r = await actions.submit(req.params.galleryId, principal, req.body);
      const { event: _e, ...result } = r;
      return result;
    },
  );

  const UndoBody = Type.Object(
    {
      requestId: Type.String({ minLength: 8, maxLength: 100, description: 'Idempotency key; retries return duplicate=true.' }),
      actionId: Type.Optional(Type.String({ format: 'uuid', description: 'Undo this specific action of yours instead of your latest one.' })),
    },
    { additionalProperties: false },
  );

  app.post(
    '/v1/galleries/:galleryId/undo',
    {
      schema: {
        tags: ['scene'],
        summary: "Undo the caller's latest action (guarded inverse, new revision)",
        description:
          'Commits the inverse of your latest manual/AI/redo action as a new revision, broadcast like any edit. Changes by other people are preserved. If someone else has since changed a property this undo would restore, returns 409 UNDO_CONFLICT and changes nothing. 409 NOTHING_TO_UNDO when your history is empty.',
        params: GalleryIdParams,
        body: UndoBody,
        response: { 200: ActionResult, 409: ErrorResponse },
      },
    },
    async (req) => {
      const { userId } = requireUser(req);
      const principal = { ...principalFor(req, req.params.galleryId), userId };
      const { event: _e, ...result } = await actions.undo(req.params.galleryId, principal, req.body);
      return result;
    },
  );

  app.post(
    '/v1/galleries/:galleryId/redo',
    {
      schema: {
        tags: ['scene'],
        summary: "Redo the caller's most recent undo",
        description: 'Available until you make a new manual or AI edit. Same conflict rules as undo.',
        params: GalleryIdParams,
        body: Type.Object({ requestId: UndoBody.properties.requestId }, { additionalProperties: false }),
        response: { 200: ActionResult, 409: ErrorResponse },
      },
    },
    async (req) => {
      const { userId } = requireUser(req);
      const principal = { ...principalFor(req, req.params.galleryId), userId };
      const { event: _e, ...result } = await actions.redo(req.params.galleryId, principal, req.body);
      return result;
    },
  );

  app.get(
    '/v1/galleries/:galleryId/actions',
    {
      schema: {
        tags: ['scene'],
        summary: 'Action history (newest first)',
        params: GalleryIdParams,
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
          beforeRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      },
    },
    async (req) => {
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'view');
      return actions.history(req.params.galleryId, { limit: req.query.limit ?? 30, beforeRevision: req.query.beforeRevision });
    },
  );

  app.get(
    '/v1/galleries/:galleryId/events',
    {
      schema: {
        tags: ['scene'],
        summary: 'Replay committed events after a revision (gap recovery)',
        description: 'If complete=false the gap is outside the retained window: reload GET /scene instead.',
        params: GalleryIdParams,
        querystring: Type.Object({ after: Type.Integer({ minimum: 0 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })) }),
        response: {
          200: Type.Object({ currentRevision: Type.Integer(), complete: Type.Boolean(), events: Type.Array(OpsEventSchema) }),
        },
      },
    },
    async (req) => {
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'view');
      return actions.eventsSince(req.params.galleryId, req.query.after, req.query.limit ?? 200);
    },
  );
}
