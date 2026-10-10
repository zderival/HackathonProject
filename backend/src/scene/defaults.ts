import type { MaterialT, NodeType, QuatT, SceneNodeT, SceneT } from '../schemas/scene.js';
import { SCENE_SCHEMA_VERSION } from '../schemas/scene.js';
import { newNodeId } from './ids.js';

export const IDENTITY_QUAT: QuatT = [0, 0, 0, 1];

export function yawQuat(radians: number): QuatT {
  // Rotation about +Y.
  return [0, Math.sin(radians / 2), 0, Math.cos(radians / 2)];
}

export function defaultMaterial(color = '#f2f0eb'): MaterialT {
  return {
    color,
    roughness: 0.8,
    metalness: 0,
    opacity: 1,
    emissiveColor: '#000000',
    emissiveIntensity: 0,
    textureAssetId: null,
    textureRepeat: [1, 1],
  };
}

export const DEFAULT_PROPS: Record<NodeType, Record<string, unknown>> = {
  room: { width: 8, depth: 8, height: 3.5 },
  wall: { width: 4, height: 3, thickness: 0.15, shell: null, material: defaultMaterial() },
  floor: { width: 8, depth: 8, material: defaultMaterial('#8a7560') },
  ceiling: { width: 8, depth: 8, material: defaultMaterial('#ffffff') },
  primitive: { shape: 'box', size: [0.5, 0.5, 0.5], material: defaultMaterial('#cccccc') },
  artwork: {
    assetId: null,
    width: 1,
    height: 1,
    fit: 'contain',
    title: '',
    description: '',
    attribution: '',
    frame: { style: 'classic', color: '#3b2f2f', width: 0.05, depth: 0.04, matColor: '#ffffff', matWidth: 0 },
  },
  text: {
    text: 'Label',
    fontSize: 0.08,
    color: '#222222',
    align: 'center',
    maxWidth: 2,
    backgroundColor: null,
    billboard: false,
  },
  group: {},
  light: { lightType: 'point', color: '#ffffff', intensity: 1, range: 10, angle: Math.PI / 6, penumbra: 0.3, castShadow: false },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Deep-merges `patch` over `base`. Arrays and primitives replace.
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function buildNode(input: {
  id?: string;
  type: NodeType;
  name?: string;
  parentId?: string | null;
  transform?: { position?: number[]; rotation?: number[]; scale?: number[] };
  visible?: boolean;
  locked?: boolean;
  props?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}): SceneNodeT {
  return {
    id: input.id ?? newNodeId(),
    type: input.type,
    name: input.name ?? input.type,
    parentId: input.parentId ?? null,
    transform: {
      position: (input.transform?.position as any) ?? [0, 0, 0],
      rotation: (input.transform?.rotation as any) ?? IDENTITY_QUAT,
      scale: (input.transform?.scale as any) ?? [1, 1, 1],
    },
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    props: deepMerge(structuredClone(DEFAULT_PROPS[input.type]), input.props ?? {}),
    ext: input.ext ?? {},
  } as SceneNodeT;
}

export function defaultEnvironment(): SceneT['environment'] {
  return {
    backgroundColor: '#20232a',
    skybox: 'gradient',
    gradientTopColor: '#3a4a6b',
    gradientBottomColor: '#20232a',
    ambientColor: '#ffffff',
    ambientIntensity: 0.4,
    fog: { enabled: false, color: '#20232a', near: 10, far: 60 },
  };
}

export function emptyScene(): SceneT {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    environment: defaultEnvironment(),
    viewerAnchor: { position: [0, 1.6, 0], rotation: IDENTITY_QUAT, roomId: null },
    nodes: {},
    ext: {},
  };
}

// Shell layout for a room of the given size, in the room's local frame
// (origin at floor center). Shared by the starter template and room.resize.
export function shellLayout(width: number, depth: number, height: number, t = 0.15) {
  return {
    north: { position: [0, height / 2, -depth / 2 - t / 2], rotation: IDENTITY_QUAT, width: width + 2 * t, height },
    south: { position: [0, height / 2, depth / 2 + t / 2], rotation: yawQuat(Math.PI), width: width + 2 * t, height },
    east: { position: [width / 2 + t / 2, height / 2, 0], rotation: yawQuat(-Math.PI / 2), width: depth, height },
    west: { position: [-width / 2 - t / 2, height / 2, 0], rotation: yawQuat(Math.PI / 2), width: depth, height },
    floor: { position: [0, 0, 0], width, depth },
    ceiling: { position: [0, height, 0], width, depth },
    thickness: t,
  };
}

// A furnished starter room: 4 walls, floor, ceiling, lights, a welcome label and an anchor.
export function starterScene(opts: { title?: string } = {}): SceneT {
  const scene = emptyScene();
  const [w, d, h] = [10, 8, 3.5];
  const L = shellLayout(w, d, h);
  const add = (n: SceneNodeT) => (scene.nodes[n.id] = n);

  const room = add(buildNode({ id: 'room-main', type: 'room', name: 'Main room', props: { width: w, depth: d, height: h } }));
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const s = L[side];
    add(
      buildNode({
        id: `wall-${side}`,
        type: 'wall',
        name: `${side[0].toUpperCase()}${side.slice(1)} wall`,
        parentId: room.id,
        transform: { position: s.position, rotation: s.rotation },
        props: { width: s.width, height: s.height, thickness: L.thickness, shell: side },
      }),
    );
  }
  add(buildNode({ id: 'floor-main', type: 'floor', name: 'Floor', parentId: room.id, props: { width: w, depth: d } }));
  add(
    buildNode({
      id: 'ceiling-main',
      type: 'ceiling',
      name: 'Ceiling',
      parentId: room.id,
      transform: { position: L.ceiling.position },
      props: { width: w, depth: d },
    }),
  );
  add(
    buildNode({
      id: 'light-key',
      type: 'light',
      name: 'Ceiling light',
      parentId: room.id,
      transform: { position: [0, h - 0.3, 0] },
      props: { lightType: 'point', intensity: 1.5, range: 15, color: '#fff4e0' },
    }),
  );
  add(
    buildNode({
      id: 'label-welcome',
      type: 'text',
      name: 'Welcome label',
      parentId: 'wall-north',
      transform: { position: [0, 1.1, L.thickness / 2 + 0.01] },
      props: { text: opts.title ?? 'Welcome', fontSize: 0.15 },
    }),
  );
  scene.viewerAnchor = { position: [0, 1.6, d / 2 - 1.5], rotation: IDENTITY_QUAT, roomId: room.id };
  return scene;
}
