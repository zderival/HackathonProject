// Compiles high-level operations into primitive, invertible changes and applies them
// to a working copy of the scene. Pure and synchronous: no I/O, no authorization.
import { AppError } from '../lib/errors.js';
import type { Change, OperationT } from '../schemas/operations.js';
import type { NodeType, SceneNodeT, SceneT } from '../schemas/scene.js';
import { buildNode, IDENTITY_QUAT, shellLayout } from './defaults.js';
import { newNodeId } from './ids.js';
import { compose, IDENTITY_POSE, isUniform, relativeTo, round, type Pose, type Q, type V3 } from './math.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as object, k) && deepEqual((a as any)[k], (b as any)[k]));
}

function splitPath(path: string): string[] {
  const parts = path.split('.');
  for (const p of parts) if (!p || FORBIDDEN_KEYS.has(p)) throw new AppError('VALIDATION_FAILED', { path }, `invalid path ${path}`);
  return parts;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const key of splitPath(path)) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

// Sets a value at path, creating intermediate objects. `undefined` deletes the key.
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = splitPath(path);
  let cur: any = obj;
  for (const key of parts.slice(0, -1)) {
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = structuredClone(value);
}

export function applyChange(scene: SceneT, c: Change): void {
  switch (c.kind) {
    case 'node.add':
      scene.nodes[c.node.id] = structuredClone(c.node);
      break;
    case 'node.remove':
      delete scene.nodes[c.node.id];
      break;
    case 'node.set':
      setPath(scene.nodes[c.nodeId] as any, c.path, c.after);
      break;
    case 'scene.set':
      setPath(scene as any, c.path, c.after);
      break;
  }
}

export function invertChange(c: Change): Change {
  switch (c.kind) {
    case 'node.add':
      return { kind: 'node.remove', node: c.node };
    case 'node.remove':
      return { kind: 'node.add', node: c.node };
    case 'node.set':
    case 'scene.set':
      return { ...c, before: c.after, after: c.before };
  }
}

export function invertChanges(changes: Change[]): Change[] {
  return changes.slice().reverse().map(invertChange);
}

// ---------------------------------------------------------------------------

export interface AssetInfo {
  id: string;
  width: number;
  height: number;
  title: string;
  description: string;
  attribution: string;
}

export interface CompileContext {
  assets: Map<string, AssetInfo>;
}

class Compiler {
  readonly changes: Change[] = [];
  opIndex = 0;

  constructor(
    readonly scene: SceneT,
    readonly ctx: CompileContext,
  ) {}

  fail(code: 'INVALID_REFERENCE' | 'UNSUPPORTED_OPERATION' | 'VALIDATION_FAILED', reason: string, extra: Record<string, unknown> = {}): never {
    throw new AppError(code, { opIndex: this.opIndex, reason, ...extra }, reason);
  }

  node(id: string, ...types: NodeType[]): SceneNodeT {
    const n = this.scene.nodes[id];
    if (!n) this.fail('INVALID_REFERENCE', `node ${id} does not exist`, { nodeId: id });
    if (types.length && !types.includes(n.type)) this.fail('UNSUPPORTED_OPERATION', `node ${id} is a ${n.type}; expected ${types.join(' or ')}`, { nodeId: id });
    return n;
  }

  push(c: Change) {
    applyChange(this.scene, c);
    this.changes.push(c);
  }

  // Sets a node property; plain-object values are merged leaf by leaf.
  setNode(nodeId: string, path: string, value: unknown) {
    if (isPlainObject(value) && !path.startsWith('ext')) {
      const entries = Object.entries(value);
      if (!entries.length) this.fail('VALIDATION_FAILED', `empty object for ${path}`);
      for (const [k, v] of entries) this.setNode(nodeId, `${path}.${k}`, v);
      return;
    }
    const before = getPath(this.scene.nodes[nodeId], path);
    if (deepEqual(before, value)) return;
    this.push({ kind: 'node.set', nodeId, path, before: structuredClone(before), after: structuredClone(value) });
  }

  setScene(path: string, value: unknown) {
    if (isPlainObject(value) && path !== 'viewerAnchor') {
      for (const [k, v] of Object.entries(value)) this.setScene(`${path}.${k}`, v);
      return;
    }
    const before = getPath(this.scene, path);
    if (deepEqual(before, value)) return;
    this.push({ kind: 'scene.set', path, before: structuredClone(before), after: structuredClone(value) });
  }

  addNode(node: SceneNodeT) {
    if (this.scene.nodes[node.id]) this.fail('VALIDATION_FAILED', `node ${node.id} already exists`, { nodeId: node.id });
    if (node.parentId !== null && !this.scene.nodes[node.parentId])
      this.fail('INVALID_REFERENCE', `parent ${node.parentId} does not exist`, { nodeId: node.parentId });
    this.push({ kind: 'node.add', node });
  }

  children(id: string): SceneNodeT[] {
    return Object.values(this.scene.nodes).filter((n) => n.parentId === id);
  }

  // Post-order: descendants before ancestors (so inverse re-adds parents first).
  subtree(id: string): SceneNodeT[] {
    const out: SceneNodeT[] = [];
    const visit = (nid: string) => {
      for (const c of this.children(nid)) visit(c.id);
      out.push(this.scene.nodes[nid]);
    };
    visit(id);
    return out;
  }

  worldPose(id: string | null): Pose {
    if (id === null) return IDENTITY_POSE;
    const chain: SceneNodeT[] = [];
    for (let cur: string | null = id; cur !== null; cur = this.scene.nodes[cur]?.parentId ?? null) {
      const n = this.scene.nodes[cur];
      if (!n || chain.length > 32) break;
      chain.unshift(n);
    }
    let pose = IDENTITY_POSE;
    for (const n of chain) {
      if (!isUniform(pose.scale as V3)) this.fail('UNSUPPORTED_OPERATION', 'keepWorldTransform requires uniform scale on ancestors');
      pose = compose(pose, n.transform as Pose);
    }
    return pose;
  }

  compile(op: OperationT) {
    switch (op.op) {
      case 'node.add': {
        const id = op.node.id ?? newNodeId();
        const node = buildNode({ ...op.node, id } as any);
        this.addNode(node);
        return;
      }
      case 'node.update': {
        this.node(op.nodeId);
        for (const [path, value] of Object.entries(op.set)) this.setNode(op.nodeId, path, value);
        return;
      }
      case 'node.remove': {
        this.node(op.nodeId);
        for (const n of this.subtree(op.nodeId)) this.push({ kind: 'node.remove', node: structuredClone(n) });
        const roomId = this.scene.viewerAnchor.roomId;
        if (roomId && !this.scene.nodes[roomId]) this.setScene('viewerAnchor', { ...this.scene.viewerAnchor, roomId: null });
        return;
      }
      case 'node.duplicate': {
        const root = this.node(op.nodeId);
        const idMap = new Map<string, string>();
        const nodes = this.subtree(op.nodeId).reverse(); // parents first
        for (const n of nodes) idMap.set(n.id, n.id === root.id && op.newId ? op.newId : newNodeId());
        const offset = op.offset ?? [0.3, 0, 0];
        for (const n of nodes) {
          const copy = structuredClone(n) as SceneNodeT;
          copy.id = idMap.get(n.id)!;
          if (n.id === root.id) {
            copy.name = `${n.name} copy`.slice(0, 120);
            const p = copy.transform.position;
            copy.transform.position = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
          } else {
            copy.parentId = idMap.get(n.parentId!)!;
          }
          this.addNode(copy);
        }
        return;
      }
      case 'node.reparent': {
        const node = this.node(op.nodeId);
        if (op.parentId !== null) this.node(op.parentId);
        if (op.parentId === op.nodeId) this.fail('VALIDATION_FAILED', 'a node cannot be its own parent');
        if (op.keepWorldTransform) {
          const world = this.worldPose(node.id);
          const parent = this.worldPose(op.parentId);
          if (!isUniform(parent.scale as V3)) this.fail('UNSUPPORTED_OPERATION', 'keepWorldTransform requires a uniformly scaled new parent');
          const local = relativeTo(parent, world);
          this.setNode(node.id, 'transform.position', local.position.map((v) => round(v)));
          this.setNode(node.id, 'transform.rotation', local.rotation.map((v) => round(v, 8)));
          this.setNode(node.id, 'transform.scale', local.scale.map((v) => round(v)));
        }
        const before = node.parentId;
        if (before !== op.parentId) this.push({ kind: 'node.set', nodeId: node.id, path: 'parentId', before, after: op.parentId });
        return;
      }
      case 'node.setTransform': {
        this.node(op.nodeId);
        if (op.position) this.setNode(op.nodeId, 'transform.position', op.position);
        if (op.rotation) this.setNode(op.nodeId, 'transform.rotation', op.rotation);
        if (op.scale) this.setNode(op.nodeId, 'transform.scale', op.scale);
        return;
      }
      case 'node.setMaterial': {
        this.node(op.nodeId, 'wall', 'floor', 'ceiling', 'primitive');
        this.setNode(op.nodeId, 'props.material', op.material);
        return;
      }
      case 'node.setVisibility':
        this.node(op.nodeId);
        this.setNode(op.nodeId, 'visible', op.visible);
        return;
      case 'node.setText':
        this.node(op.nodeId, 'text');
        this.setNode(op.nodeId, 'props.text', op.text);
        return;
      case 'artwork.place': {
        const asset = this.ctx.assets.get(op.assetId);
        if (!asset) this.fail('INVALID_REFERENCE', `asset ${op.assetId} is not available in this gallery`, { assetId: op.assetId });
        const aspect = asset.height / asset.width;
        const existing = op.nodeId ? this.scene.nodes[op.nodeId] : undefined;
        if (existing) {
          this.node(existing.id, 'artwork');
          const width = op.width ?? (existing.props as any).width;
          this.setNode(existing.id, 'props.assetId', op.assetId);
          this.setNode(existing.id, 'props.width', round(width, 4));
          this.setNode(existing.id, 'props.height', round(Math.min(20, width * aspect), 4));
          if (op.title !== undefined) this.setNode(existing.id, 'props.title', op.title);
          if (op.parentId !== undefined && op.parentId !== existing.parentId)
            this.push({ kind: 'node.set', nodeId: existing.id, path: 'parentId', before: existing.parentId, after: op.parentId });
          if (op.position) this.setNode(existing.id, 'transform.position', op.position);
          if (op.rotation) this.setNode(existing.id, 'transform.rotation', op.rotation);
          return;
        }
        const parentId = op.parentId ?? null;
        const parent = parentId ? this.node(parentId) : null;
        let width = op.width ?? 1.2;
        if (aspect * width > 20) width = 20 / aspect;
        let position: V3 = (op.position as V3) ?? [0, 1.5, 0];
        if (!op.position && parent?.type === 'wall') {
          const wp = parent.props as any;
          position = [0, 1.5 - wp.height / 2, wp.thickness / 2 + 0.02];
        }
        this.addNode(
          buildNode({
            id: op.nodeId ?? newNodeId('art'),
            type: 'artwork',
            name: op.title || asset.title || 'Artwork',
            parentId,
            transform: { position, rotation: (op.rotation as Q) ?? IDENTITY_QUAT },
            props: {
              assetId: op.assetId,
              width: round(width, 4),
              height: round(width * aspect, 4),
              title: op.title ?? asset.title,
              description: asset.description,
              attribution: asset.attribution,
            },
          }),
        );
        return;
      }
      case 'artwork.hangOnWall': {
        const art = this.node(op.nodeId, 'artwork');
        const wall = this.node(op.wallId, 'wall');
        const wp = wall.props as any;
        const y = (op.centerHeight ?? 1.5) - wp.height / 2;
        if (art.parentId !== wall.id) this.push({ kind: 'node.set', nodeId: art.id, path: 'parentId', before: art.parentId, after: wall.id });
        this.setNode(art.id, 'transform.position', [op.x ?? 0, round(y, 4), round(wp.thickness / 2 + 0.02, 4)]);
        this.setNode(art.id, 'transform.rotation', IDENTITY_QUAT);
        return;
      }
      case 'artwork.setFrame':
        this.node(op.nodeId, 'artwork');
        this.setNode(op.nodeId, 'props.frame', op.frame);
        return;
      case 'room.resize': {
        const room = this.node(op.nodeId, 'room');
        const rp = room.props as any;
        const w = op.width ?? rp.width;
        const d = op.depth ?? rp.depth;
        const h = op.height ?? rp.height;
        this.setNode(room.id, 'props', { width: w, depth: d, height: h });
        for (const child of this.children(room.id)) {
          const cp = child.props as any;
          if (child.type === 'wall' && cp.shell) {
            const L = shellLayout(w, d, h, cp.thickness);
            const s = L[cp.shell as 'north' | 'south' | 'east' | 'west'];
            this.setNode(child.id, 'transform.position', s.position.map((v) => round(v)));
            this.setNode(child.id, 'props.width', round(s.width));
            this.setNode(child.id, 'props.height', round(s.height));
          } else if (child.type === 'floor') {
            this.setNode(child.id, 'props', { width: w, depth: d });
          } else if (child.type === 'ceiling') {
            this.setNode(child.id, 'transform.position', [child.transform.position[0], h, child.transform.position[2]]);
            this.setNode(child.id, 'props', { width: w, depth: d });
          }
        }
        return;
      }
      case 'scene.setEnvironment':
        this.setScene('environment', op.environment);
        return;
      case 'scene.setViewerAnchor': {
        const roomId = op.roomId === undefined ? this.scene.viewerAnchor.roomId : op.roomId;
        if (roomId !== null) this.node(roomId, 'room');
        this.setScene('viewerAnchor', { position: op.position, rotation: op.rotation, roomId });
        return;
      }
      default:
        this.fail('UNSUPPORTED_OPERATION', `unknown operation ${(op as any).op}`);
    }
  }
}

export interface CompileResult {
  scene: SceneT;
  changes: Change[];
  touchedNodeIds: Set<string>;
}

// Applies ops to a copy of `scene`. Throws AppError on the first invalid op.
export function compileOps(scene: SceneT, ops: OperationT[], ctx: CompileContext): CompileResult {
  const working = structuredClone(scene);
  const compiler = new Compiler(working, ctx);
  ops.forEach((op, i) => {
    compiler.opIndex = i;
    compiler.compile(op);
  });
  return { scene: working, changes: compiler.changes, touchedNodeIds: touchedNodes(compiler.changes) };
}

export function touchedNodes(changes: Change[]): Set<string> {
  const out = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'node.add' || c.kind === 'node.remove') out.add(c.node.id);
    else if (c.kind === 'node.set') out.add(c.nodeId);
  }
  return out;
}

// --- Conflict keys --------------------------------------------------------
// A change "touches" keys; two change sets conflict when any keys overlap
// (equal, or one is a path prefix of the other). Adding/removing a node touches
// the whole node.

export function changeKeys(changes: Change[]): string[] {
  return changes.map((c) => {
    switch (c.kind) {
      case 'node.add':
      case 'node.remove':
        return `node/${c.node.id}`;
      case 'node.set':
        return `node/${c.nodeId}/${c.path}`;
      case 'scene.set':
        return `scene/${c.path}`;
    }
  });
}

const keyOverlap = (a: string, b: string) => {
  const [pa, pb] = [a.replace(/\./g, '/'), b.replace(/\./g, '/')];
  return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
};

export function keysOverlap(a: string[], b: string[]): string | null {
  for (const x of a) for (const y of b) if (keyOverlap(x, y)) return x;
  return null;
}
