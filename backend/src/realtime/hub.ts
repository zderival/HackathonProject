// In-process fan-out of committed scene events to WebSocket subscribers.
//
// Single-instance design: the first deployment runs one service instance. Scaling
// horizontally requires a shared broadcast channel (e.g. PostgreSQL LISTEN/NOTIFY or
// Redis pub/sub) feeding publish() on every instance; persistence and recovery do not
// depend on the hub because every client can resync from the database.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { OpsEvent, Publisher } from '../actions/service.js';
import type { Db } from '../db/pool.js';
import { capabilitiesFor, resolveAccess, type Principal, type Role } from '../galleries/access.js';
import type { Lang } from '../lib/i18n.js';
import type { SceneT } from '../schemas/scene.js';

export type ConnCapability = 'edit' | 'view';

export interface Connection {
  id: string;
  ws: WebSocket;
  galleryId: string;
  principal: Principal;
  capability: ConnCapability;
  role: Role;
  lang: Lang;
  // 'syncing': snapshot not sent yet, events are buffered.
  state: 'syncing' | 'live' | 'closed';
  buffer: OpsEvent[];
  lastRevision: number;
  replaying: boolean;
  alive: boolean;
  connectedAt: number;
}

export interface HubDeps {
  db: Db;
  eventsSince(galleryId: string, after: number): Promise<{ currentRevision: number; events: OpsEvent[]; complete: boolean }>;
  maxBufferedBytes: number;
  maxSyncBuffer: number;
  log: { warn: (o: object, msg: string) => void; info: (o: object, msg: string) => void };
}

export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TICKET_INVALID: 4001,
  ACCESS_REVOKED: 4403,
  SLOW_CONSUMER: 4008,
  TOO_MANY_CONNECTIONS: 4029,
  PROTOCOL_ERROR: 4002,
} as const;

export class RealtimeHub implements Publisher {
  private galleries = new Map<string, Set<Connection>>();

  constructor(private deps: HubDeps) {}

  connectionCount(galleryId?: string) {
    if (galleryId) return this.galleries.get(galleryId)?.size ?? 0;
    let n = 0;
    for (const set of this.galleries.values()) n += set.size;
    return n;
  }

  countByCapability(galleryId: string, capability: ConnCapability) {
    let n = 0;
    for (const c of this.galleries.get(galleryId) ?? []) if (c.capability === capability) n++;
    return n;
  }

  // Registers before the snapshot is read so no commit can fall between them.
  register(input: Omit<Connection, 'id' | 'state' | 'buffer' | 'lastRevision' | 'replaying' | 'alive' | 'connectedAt'>): Connection {
    const conn: Connection = {
      ...input,
      id: randomUUID(),
      state: 'syncing',
      buffer: [],
      lastRevision: -1,
      replaying: false,
      alive: true,
      connectedAt: Date.now(),
    };
    let set = this.galleries.get(conn.galleryId);
    if (!set) this.galleries.set(conn.galleryId, (set = new Set()));
    set.add(conn);
    return conn;
  }

  unregister(conn: Connection) {
    conn.state = 'closed';
    conn.buffer = [];
    const set = this.galleries.get(conn.galleryId);
    set?.delete(conn);
    if (set && !set.size) this.galleries.delete(conn.galleryId);
  }

  send(conn: Connection, msg: object): boolean {
    if (conn.state === 'closed' || conn.ws.readyState !== conn.ws.OPEN) return false;
    // Bounded per-connection queue: a consumer that cannot keep up is disconnected
    // and must reconnect + resync, instead of growing server memory.
    if (conn.ws.bufferedAmount > this.deps.maxBufferedBytes) {
      this.deps.log.warn({ conn: conn.id, buffered: conn.ws.bufferedAmount }, 'slow websocket consumer; closing');
      this.close(conn, CLOSE.SLOW_CONSUMER, 'slow consumer: reconnect and resync');
      return false;
    }
    conn.ws.send(JSON.stringify(msg));
    return true;
  }

  close(conn: Connection, code: number, reason: string) {
    if (conn.state === 'closed') return;
    this.unregister(conn);
    try {
      conn.ws.close(code, reason.slice(0, 120));
    } catch {
      conn.ws.terminate();
    }
  }

  // Sends the initial (or recovery) snapshot and flushes events buffered meanwhile.
  completeSync(conn: Connection, snapshot: { scene: SceneT; revision: number }, reason: string) {
    if (conn.state === 'closed') return;
    this.send(conn, {
      type: 'snapshot',
      galleryId: conn.galleryId,
      revision: snapshot.revision,
      reason,
      scene: snapshot.scene,
    });
    conn.lastRevision = snapshot.revision;
    const buffered = conn.buffer.sort((a, b) => a.revision - b.revision);
    conn.buffer = [];
    conn.state = 'live';
    for (const ev of buffered) this.deliver(conn, ev);
  }

  publish(event: OpsEvent): void {
    for (const conn of this.galleries.get(event.galleryId) ?? []) {
      if (conn.state === 'syncing' || conn.replaying) {
        if (conn.buffer.length >= this.deps.maxSyncBuffer) {
          this.close(conn, CLOSE.SLOW_CONSUMER, 'too many pending events: reconnect and resync');
          continue;
        }
        conn.buffer.push(event);
      } else if (conn.state === 'live') {
        this.deliver(conn, event);
      }
    }
  }

  private deliver(conn: Connection, event: OpsEvent) {
    if (event.revision <= conn.lastRevision) return; // already covered (duplicate suppression)
    if (event.revision !== conn.lastRevision + 1) {
      // Out-of-order publish or dropped event: heal from the database.
      conn.buffer.push(event);
      void this.replay(conn);
      return;
    }
    if (this.send(conn, event)) conn.lastRevision = event.revision;
  }

  // Replays committed events after conn.lastRevision from history; falls back to a
  // fresh snapshot when history no longer covers the gap.
  async replay(conn: Connection) {
    if (conn.replaying || conn.state !== 'live') return;
    conn.replaying = true;
    try {
      const { events, complete } = await this.deps.eventsSince(conn.galleryId, conn.lastRevision);
      if (!complete) {
        await this.resyncSnapshot(conn, 'gap');
        return;
      }
      for (const ev of events) {
        if (ev.revision === conn.lastRevision + 1 && this.send(conn, ev)) conn.lastRevision = ev.revision;
      }
    } catch (err) {
      this.deps.log.warn({ err, conn: conn.id }, 'replay failed');
      this.close(conn, CLOSE.SLOW_CONSUMER, 'replay failed: reconnect');
      return;
    } finally {
      conn.replaying = false;
    }
    const pending = conn.buffer.sort((a, b) => a.revision - b.revision);
    conn.buffer = [];
    for (const ev of pending) this.deliver(conn, ev);
  }

  async resyncSnapshot(conn: Connection, reason: string) {
    conn.state = 'syncing';
    const { rows } = await this.deps.db.query(`SELECT scene, revision FROM galleries WHERE id = $1 AND deleted_at IS NULL`, [conn.galleryId]);
    if (!rows[0]) return this.close(conn, CLOSE.ACCESS_REVOKED, 'gallery deleted');
    this.completeSync(conn, rows[0], reason);
  }

  // Re-evaluates every connection of a gallery after a permission/sharing change.
  // Revoked connections are closed; editors downgraded to viewers lose write capability.
  async recheckGallery(galleryId: string) {
    const conns = [...(this.galleries.get(galleryId) ?? [])];
    await Promise.all(conns.map((c) => this.recheckConnection(c)));
  }

  async recheckConnection(conn: Connection) {
    let role: Role | null = null;
    try {
      role = (await resolveAccess(this.deps.db, conn.galleryId, conn.principal)).role;
    } catch {
      role = null; // gallery deleted
    }
    if (conn.state === 'closed') return;
    if (!role) {
      this.send(conn, { type: 'error', code: 'FORBIDDEN', message: 'access revoked', fatal: true });
      this.close(conn, CLOSE.ACCESS_REVOKED, 'access revoked');
      return;
    }
    const caps = capabilitiesFor(role, conn.principal.readOnly);
    const capability: ConnCapability = conn.capability === 'edit' && caps.canEdit ? 'edit' : 'view';
    if (role !== conn.role || capability !== conn.capability) {
      conn.role = role;
      conn.capability = capability;
      this.send(conn, { type: 'permissions', galleryId: conn.galleryId, role, capability, ...caps, canEdit: capability === 'edit' });
    }
  }

  // Private messages (assistant command updates) go only to that user's editor
  // connections for the gallery; read-only viewer connections never receive them.
  sendToUser(galleryId: string, userId: string, msg: object) {
    for (const conn of this.galleries.get(galleryId) ?? []) {
      if (conn.capability === 'edit' && conn.principal.userId === userId && conn.state !== 'closed') this.send(conn, msg);
    }
  }

  heartbeat() {
    for (const set of this.galleries.values()) {
      for (const conn of set) {
        if (!conn.alive) {
          this.unregister(conn);
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          /* closed */
        }
      }
    }
  }

  // Gallery-wide notices that are not scene changes (e.g. a verified donation). Not part
  // of the revision sequence; clients that miss one simply re-fetch the summary.
  broadcast(galleryId: string, msg: object) {
    for (const conn of this.galleries.get(galleryId) ?? []) if (conn.state === 'live') this.send(conn, msg);
  }

  closeAll(code: number, reason: string) {
    for (const set of [...this.galleries.values()]) for (const conn of [...set]) this.close(conn, code, reason);
  }
}
