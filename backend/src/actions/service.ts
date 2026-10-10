// The single write pipeline for scenes. Manual edits (HTTP and WebSocket), AI plans,
// undo and redo all commit through `commit()`.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../config.js';
import { withTransaction, type Db } from '../db/pool.js';
import { requireAccess, type Principal } from '../galleries/access.js';
import { AppError } from '../lib/errors.js';
import { toWire, type ActionRequestT, type Change, type OperationT, type WireChangeT } from '../schemas/operations.js';
import type { SceneT } from '../schemas/scene.js';
import {
  applyChange,
  changeKeys,
  compileOps,
  deepEqual,
  getPath,
  invertChanges,
  keysOverlap,
  touchedNodes,
  type AssetInfo,
} from '../scene/engine.js';
import { referencedAssetIds, validateScene } from '../scene/validate.js';

export type ActionSource = 'manual' | 'ai' | 'undo' | 'redo' | 'system';

export interface Actor {
  userId: string;
  displayName: string;
}

export interface OpsEvent {
  type: 'ops';
  eventId: string;
  galleryId: string;
  revision: number;
  baseRevision: number;
  actionId: string;
  requestId: string;
  source: ActionSource;
  actor: Actor | null;
  label: string | null;
  undoOf: number | null;
  redoOf: number | null;
  ts: string;
  changes: WireChangeT[];
}

export interface CommitResult {
  galleryId: string;
  actionId: string;
  requestId: string;
  revision: number;
  baseRevision: number;
  duplicate: boolean;
  noop: boolean;
  changes: WireChangeT[];
  event: OpsEvent | null;
}

export interface Publisher {
  publish(event: OpsEvent): void;
}

// Internal commit request: either compile `ops`, or apply precomputed `changes`
// (undo/redo) through `prepare`, which runs under the gallery row lock.
export interface CommitInput {
  galleryId: string;
  principal: Principal & { userId: string };
  source: ActionSource;
  requestId: string;
  actionId?: string;
  baseRevision: number | null; // null = apply to the latest revision (undo/redo/AI regrounded)
  conflictMode: 'strict' | 'merge';
  label?: string | null;
  ops: OperationT[];
  aiCommandId?: string | null;
  prepare?: (ctx: PrepareContext) => Promise<Prepared>;
  // Called inside the transaction before commit; throw to abort (used by AI to recheck state).
  beforeCommit?: (client: pg.PoolClient) => Promise<void>;
}

export interface Prepared {
  scene: SceneT;
  changes: Change[];
  touchedNodeIds: Set<string>;
  undoOf?: number;
  redoOf?: number;
  label?: string;
}

export interface PrepareContext {
  client: pg.PoolClient;
  scene: SceneT;
  revision: number;
}

const eventId = (galleryId: string, revision: number) => `${galleryId}:${revision}`;

function rowToEvent(row: any): OpsEvent {
  return {
    type: 'ops',
    eventId: eventId(row.gallery_id, row.revision),
    galleryId: row.gallery_id,
    revision: row.revision,
    baseRevision: row.base_revision,
    actionId: row.action_id,
    requestId: row.request_id,
    source: row.source,
    actor: row.actor_id ? { userId: row.actor_id, displayName: row.actor_name ?? '' } : null,
    label: row.label,
    undoOf: row.undo_of,
    redoOf: row.redo_of,
    ts: new Date(row.created_at).toISOString(),
    changes: toWire(row.changes),
  };
}

export class ActionService {
  constructor(
    private db: Db,
    private config: Config,
    private publisher: Publisher,
  ) {}

  submit(galleryId: string, principal: Principal & { userId: string }, req: ActionRequestT, source: ActionSource = 'manual') {
    if (req.ops.length > this.config.limits.maxOpsPerBatch)
      throw new AppError('LIMIT_EXCEEDED', { maxOpsPerBatch: this.config.limits.maxOpsPerBatch });
    return this.commit({
      galleryId,
      principal,
      source,
      requestId: req.requestId,
      actionId: req.actionId,
      baseRevision: req.baseRevision,
      conflictMode: req.conflictMode ?? 'strict',
      label: req.label ?? null,
      ops: req.ops,
    });
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    const result = await withTransaction(this.db, async (client) => {
      const { rows } = await client.query(
        `SELECT scene, revision FROM galleries WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [input.galleryId],
      );
      if (!rows[0]) throw new AppError('NOT_FOUND', { what: 'gallery' });
      const current = rows[0].revision as number;
      const scene = rows[0].scene as SceneT;

      // Authorization is rechecked under the lock, so a downgrade that committed
      // before this point always wins.
      await requireAccess(client, input.galleryId, input.principal, 'edit');

      const dup = await client.query(
        `SELECT a.*, u.display_name AS actor_name FROM gallery_actions a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.gallery_id = $1 AND a.actor_id = $2 AND a.request_id = $3`,
        [input.galleryId, input.principal.userId, input.requestId],
      );
      if (dup.rows[0]) {
        const row = dup.rows[0];
        if (JSON.stringify(row.ops) !== JSON.stringify(input.ops) || row.source !== input.source)
          throw new AppError('IDEMPOTENCY_MISMATCH', { requestId: input.requestId });
        const event = rowToEvent(row);
        return { duplicate: true, noop: false, event, revision: row.revision as number, actionId: row.action_id as string, baseRevision: row.base_revision as number };
      }

      if (input.baseRevision !== null) {
        if (input.baseRevision > current) throw new AppError('VALIDATION_FAILED', { baseRevision: input.baseRevision, currentRevision: current }, 'baseRevision is ahead of the gallery');
        if (input.conflictMode === 'strict' && input.baseRevision !== current)
          throw new AppError('REVISION_CONFLICT', { baseRevision: input.baseRevision, currentRevision: current });
      }

      let compiled: Prepared;
      if (input.prepare) {
        compiled = await input.prepare({ client, scene, revision: current });
      } else {
        const assets = await this.loadAssets(client, input.galleryId, assetIdsInOps(input.ops));
        compiled = compileOps(scene, input.ops, { assets });
      }

      if (input.baseRevision !== null && input.conflictMode === 'merge' && input.baseRevision < current) {
        await this.assertNoOverlap(client, input.galleryId, input.baseRevision, current, compiled.changes);
      }

      const issues = validateScene(compiled.scene, {
        maxNodes: this.config.limits.maxNodes,
        maxSceneBytes: this.config.limits.maxSceneBytes,
        touched: compiled.touchedNodeIds,
      });
      if (issues.length) throw new AppError('INVALID_SCENE', { issues });

      const refs = referencedAssetIds(compiled.scene, compiled.touchedNodeIds);
      if (refs.size) {
        const found = await this.loadAssets(client, input.galleryId, refs);
        const missing = [...refs].filter((id) => !found.has(id));
        if (missing.length) throw new AppError('INVALID_REFERENCE', { assetIds: missing, reason: 'asset not found in this gallery' });
      }

      if (!compiled.changes.length) {
        return { duplicate: false, noop: true, event: null, revision: current, actionId: input.actionId ?? randomUUID(), baseRevision: input.baseRevision ?? current };
      }

      await input.beforeCommit?.(client);

      const revision = current + 1;
      const actionId = input.actionId ?? randomUUID();
      await client.query(`UPDATE galleries SET scene = $2, revision = $3, updated_at = now() WHERE id = $1`, [
        input.galleryId,
        compiled.scene,
        revision,
      ]);
      const ins = await client.query(
        `INSERT INTO gallery_actions (gallery_id, revision, action_id, request_id, actor_id, source, base_revision, label, ops, changes, undo_of, redo_of, ai_command_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13)
         RETURNING *, (SELECT display_name FROM users WHERE id = $5) AS actor_name`,
        [
          input.galleryId,
          revision,
          actionId,
          input.requestId,
          input.principal.userId,
          input.source,
          input.baseRevision ?? current,
          compiled.label ?? input.label ?? null,
          JSON.stringify(input.ops),
          JSON.stringify(compiled.changes),
          compiled.undoOf ?? null,
          compiled.redoOf ?? null,
          input.aiCommandId ?? null,
        ],
      );
      if (compiled.undoOf) await client.query(`UPDATE gallery_actions SET undone = true WHERE gallery_id = $1 AND revision = $2`, [input.galleryId, compiled.undoOf]);
      if (compiled.redoOf) {
        // The redo restores the action the undo reverted; it becomes undoable again.
        await client.query(
          `UPDATE gallery_actions SET undone = true WHERE gallery_id = $1 AND revision = $2`,
          [input.galleryId, compiled.redoOf],
        );
      }
      return { duplicate: false, noop: false, event: rowToEvent(ins.rows[0]), revision, actionId, baseRevision: input.baseRevision ?? current };
    });

    // Broadcast strictly after COMMIT. Duplicates are not re-broadcast.
    if (result.event && !result.duplicate) this.publisher.publish(result.event);
    return {
      galleryId: input.galleryId,
      actionId: result.actionId,
      requestId: input.requestId,
      revision: result.revision,
      baseRevision: result.baseRevision,
      duplicate: result.duplicate,
      noop: result.noop,
      changes: result.event?.changes ?? [],
      event: result.event,
    };
  }

  // Undoes the caller's latest undoable action (or a specific one of their own actions)
  // by committing its guarded inverse as a new revision. Collaborators' later changes
  // to other properties are preserved; if anyone changed a property the inverse would
  // restore, the undo is refused with UNDO_CONFLICT instead of overwriting their edit.
  undo(galleryId: string, principal: Principal & { userId: string }, opts: { requestId: string; actionId?: string }) {
    return this.commit({
      galleryId,
      principal,
      source: 'undo',
      requestId: opts.requestId,
      baseRevision: null,
      conflictMode: 'merge',
      ops: [],
      label: null,
      prepare: async ({ client, scene }) => {
        const params: unknown[] = [galleryId, principal.userId];
        let where = `source IN ('manual', 'ai', 'redo') AND NOT undone`;
        if (opts.actionId) {
          params.push(opts.actionId);
          where = `action_id = $3`;
        }
        const { rows } = await client.query(
          `SELECT revision, label, changes, undone, source FROM gallery_actions
           WHERE gallery_id = $1 AND actor_id = $2 AND ${where} ORDER BY revision DESC LIMIT 1`,
          params,
        );
        const target = rows[0];
        if (!target) throw new AppError('NOTHING_TO_UNDO');
        if (target.undone || target.source === 'undo')
          throw new AppError('NOTHING_TO_UNDO', { actionId: opts.actionId, reason: 'action is already undone or is an undo' });
        const applied = applyGuarded(scene, invertChanges(target.changes));
        return { ...applied, undoOf: target.revision, label: `Undo${target.label ? `: ${target.label}` : ''}` };
      },
    });
  }

  // Re-applies the caller's most recently undone action, provided they made no new
  // manual/AI edit since that undo (a new edit clears the redo stack).
  redo(galleryId: string, principal: Principal & { userId: string }, opts: { requestId: string }) {
    return this.commit({
      galleryId,
      principal,
      source: 'redo',
      requestId: opts.requestId,
      baseRevision: null,
      conflictMode: 'merge',
      ops: [],
      label: null,
      prepare: async ({ client, scene }) => {
        const { rows } = await client.query(
          `SELECT u.revision, u.label, u.changes FROM gallery_actions u
           WHERE u.gallery_id = $1 AND u.actor_id = $2 AND u.source = 'undo' AND NOT u.undone
             AND NOT EXISTS (SELECT 1 FROM gallery_actions n WHERE n.gallery_id = u.gallery_id AND n.actor_id = u.actor_id
                             AND n.source IN ('manual', 'ai') AND n.revision > u.revision)
           ORDER BY u.revision DESC LIMIT 1`,
          [galleryId, principal.userId],
        );
        const target = rows[0];
        if (!target) throw new AppError('NOTHING_TO_REDO');
        const applied = applyGuarded(scene, invertChanges(target.changes));
        const label = typeof target.label === 'string' ? target.label.replace(/^Undo(: )?/, '') : '';
        return { ...applied, redoOf: target.revision, label: `Redo${label ? `: ${label}` : ''}` };
      },
    });
  }

  private async assertNoOverlap(client: pg.PoolClient, galleryId: string, base: number, current: number, changes: Change[]) {
    if (current - base > this.config.limits.eventReplayWindow)
      throw new AppError('REVISION_CONFLICT', { baseRevision: base, currentRevision: current, reason: 'base revision too old to merge' });
    const { rows } = await client.query(
      `SELECT revision, changes FROM gallery_actions WHERE gallery_id = $1 AND revision > $2 AND revision <= $3 ORDER BY revision`,
      [galleryId, base, current],
    );
    const mine = changeKeys(changes);
    for (const row of rows) {
      const key = keysOverlap(mine, changeKeys(row.changes));
      if (key)
        throw new AppError('REVISION_CONFLICT', {
          baseRevision: base,
          currentRevision: current,
          conflictingRevision: row.revision,
          key,
        });
    }
  }

  async loadAssets(client: pg.PoolClient | Db, galleryId: string, ids: Iterable<string>): Promise<Map<string, AssetInfo>> {
    const list = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const map = new Map<string, AssetInfo>();
    if (!list.length) return map;
    const { rows } = await client.query(
      `SELECT id, width, height, title, description, attribution FROM assets
       WHERE gallery_id = $1 AND id = ANY($2::uuid[]) AND status = 'ready'`,
      [galleryId, list],
    );
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  // Committed events after `afterRevision`, oldest first. `complete` is false when the
  // history window no longer covers the gap and the client must load a snapshot.
  async eventsSince(galleryId: string, afterRevision: number, limit = 200) {
    const { rows: g } = await this.db.query(`SELECT revision FROM galleries WHERE id = $1`, [galleryId]);
    const current = g[0]?.revision ?? 0;
    if (afterRevision >= current) return { currentRevision: current, events: [] as OpsEvent[], complete: true };
    if (current - afterRevision > Math.min(limit, this.config.limits.eventReplayWindow))
      return { currentRevision: current, events: [] as OpsEvent[], complete: false };
    const { rows } = await this.db.query(
      `SELECT a.*, u.display_name AS actor_name FROM gallery_actions a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.gallery_id = $1 AND a.revision > $2 ORDER BY a.revision LIMIT $3`,
      [galleryId, afterRevision, limit],
    );
    const events = rows.map(rowToEvent);
    // History must be contiguous; otherwise fall back to a snapshot.
    const complete = events.length === current - afterRevision && events.every((e, i) => e.revision === afterRevision + 1 + i);
    return { currentRevision: current, events: complete ? events : [], complete };
  }

  async history(galleryId: string, opts: { beforeRevision?: number; limit: number }) {
    const { rows } = await this.db.query(
      `SELECT a.revision, a.action_id, a.request_id, a.source, a.label, a.actor_id, u.display_name AS actor_name,
              a.created_at, a.undone, a.undo_of, a.redo_of, a.ai_command_id, jsonb_array_length(a.changes) AS change_count
       FROM gallery_actions a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.gallery_id = $1 AND ($2::bigint IS NULL OR a.revision < $2)
       ORDER BY a.revision DESC LIMIT $3`,
      [galleryId, opts.beforeRevision ?? null, opts.limit + 1],
    );
    const items = rows.slice(0, opts.limit).map((r) => ({
      revision: r.revision,
      actionId: r.action_id,
      requestId: r.request_id,
      source: r.source,
      label: r.label,
      actor: r.actor_id ? { userId: r.actor_id, displayName: r.actor_name } : null,
      createdAt: new Date(r.created_at).toISOString(),
      undone: r.undone,
      undoOf: r.undo_of,
      redoOf: r.redo_of,
      aiCommandId: r.ai_command_id,
      changeCount: r.change_count,
    }));
    return { items, nextBeforeRevision: rows.length > opts.limit ? items[items.length - 1].revision : null };
  }
}

// Applies inverse changes one by one, requiring the scene to still hold the value each
// change expects to replace. Sequential checking lets one action's own consecutive
// changes to the same property invert cleanly.
function applyGuarded(scene: SceneT, changes: Change[]) {
  const working = structuredClone(scene);
  for (const c of changes) {
    const conflict = (reason: string, key: string) => {
      throw new AppError('UNDO_CONFLICT', { reason, key });
    };
    switch (c.kind) {
      case 'node.add':
        if (working.nodes[c.node.id]) conflict('node exists again', `node/${c.node.id}`);
        if (c.node.parentId !== null && !working.nodes[c.node.parentId]) conflict('parent was removed', `node/${c.node.parentId}`);
        break;
      case 'node.remove': {
        const current = working.nodes[c.node.id];
        if (!current) conflict('node was already removed', `node/${c.node.id}`);
        else if (!deepEqual(current, c.node)) conflict('node was changed by a later edit', `node/${c.node.id}`);
        if (Object.values(working.nodes).some((n) => n.parentId === c.node.id)) conflict('node has new children', `node/${c.node.id}`);
        break;
      }
      case 'node.set': {
        const node = working.nodes[c.nodeId];
        if (!node) conflict('node was removed', `node/${c.nodeId}`);
        else if (!deepEqual(getPath(node, c.path), c.before)) conflict('property was changed by a later edit', `node/${c.nodeId}/${c.path}`);
        break;
      }
      case 'scene.set':
        if (!deepEqual(getPath(working, c.path), c.before)) conflict('setting was changed by a later edit', `scene/${c.path}`);
        break;
    }
    applyChange(working, c);
  }
  return { scene: working, changes, touchedNodeIds: touchedNodes(changes) };
}

function assetIdsInOps(ops: OperationT[]): string[] {
  const ids: string[] = [];
  for (const op of ops) if (op.op === 'artwork.place') ids.push(op.assetId);
  return ids;
}
