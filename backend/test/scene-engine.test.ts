import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { starterScene } from '../src/scene/defaults.js';
import { applyChange, compileOps, invertChanges } from '../src/scene/engine.js';
import { validateScene } from '../src/scene/validate.js';

const limits = { maxNodes: 2000, maxSceneBytes: 2_000_000 };
const ctx = { assets: new Map() };

function compileExpectingError(ops: any[]) {
  try {
    compileOps(starterScene(), ops, ctx);
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected an error');
}

describe('scene engine', () => {
  it('starter scene is valid', () => {
    expect(validateScene(starterScene(), limits)).toEqual([]);
  });

  it('compiles ops into invertible changes', () => {
    const scene = starterScene();
    const { scene: next, changes } = compileOps(
      scene,
      [
        { op: 'node.add', node: { id: 'box1', type: 'primitive', parentId: 'room-main', transform: { position: [1, 0.25, 0] } } },
        { op: 'node.setMaterial', nodeId: 'wall-north', material: { color: '#ffffff' } },
        { op: 'node.duplicate', nodeId: 'box1', newId: 'box2' },
        { op: 'scene.setEnvironment', environment: { fog: { enabled: true } } },
      ] as any,
      ctx,
    );
    expect(next.nodes.box2.transform.position).toEqual([1.3, 0.25, 0]);
    expect((next.nodes['wall-north'].props as any).material.color).toBe('#ffffff');
    expect(next.environment.fog.enabled).toBe(true);
    expect(validateScene(next, limits)).toEqual([]);

    // Applying the inverse restores the original exactly.
    const restored = structuredClone(next);
    for (const c of invertChanges(changes)) applyChange(restored, c);
    expect(restored).toEqual(scene);
  });

  it('room.resize moves the shell walls, floor and ceiling', () => {
    const { scene } = compileOps(starterScene(), [{ op: 'room.resize', nodeId: 'room-main', width: 14, height: 4 }] as any, ctx);
    const north = scene.nodes['wall-north'] as any;
    const east = scene.nodes['wall-east'] as any;
    expect(north.props.width).toBeCloseTo(14.3);
    expect(north.props.height).toBe(4);
    expect(east.transform.position[0]).toBeCloseTo(7.075);
    expect((scene.nodes['ceiling-main'] as any).transform.position[1]).toBe(4);
    expect(validateScene(scene, limits)).toEqual([]);
  });

  it('remove takes the subtree and clears the viewer room', () => {
    const { scene, changes } = compileOps(starterScene(), [{ op: 'node.remove', nodeId: 'room-main' }] as any, ctx);
    expect(Object.keys(scene.nodes)).toEqual([]);
    expect(scene.viewerAnchor.roomId).toBeNull();
    // Children are removed before parents, so the inverse re-adds parents first.
    const removed = changes.filter((c) => c.kind === 'node.remove').map((c: any) => c.node.id);
    expect(removed.indexOf('label-welcome')).toBeLessThan(removed.indexOf('wall-north'));
    expect(removed.at(-1)).toBe('room-main');
  });

  it('rejects a parent cycle', () => {
    const { scene } = compileOps(starterScene(), [{ op: 'node.reparent', nodeId: 'room-main', parentId: 'wall-north' }] as any, ctx);
    const issues = validateScene(scene, limits);
    expect(issues.some((i) => /cycle/.test(i.message))).toBe(true);
  });

  it('rejects unknown properties, wrong types and out-of-range values', () => {
    const bad = [
      { op: 'node.update', nodeId: 'wall-north', set: { 'props.banana': 1 } },
      { op: 'node.update', nodeId: 'wall-north', set: { 'props.width': -3 } },
      { op: 'node.update', nodeId: 'wall-north', set: { 'props.material.color': 'red' } },
      { op: 'node.update', nodeId: 'wall-north', set: { 'transform.rotation': [0, 0, 0, 2] } },
      { op: 'node.update', nodeId: 'wall-north', set: { 'transform.position': [Number.NaN, 0, 0] } },
      { op: 'node.update', nodeId: 'wall-north', set: { 'transform.scale': [-1, 1, 1] } },
    ];
    for (const op of bad) {
      const { scene } = compileOps(starterScene(), [op] as any, ctx);
      expect(validateScene(scene, { ...limits, touched: new Set(['wall-north']) }).length, JSON.stringify(op)).toBeGreaterThan(0);
    }
  });

  it('rejects a non-normalized quaternion', () => {
    const { scene } = compileOps(starterScene(), [{ op: 'node.setTransform', nodeId: 'wall-north', rotation: [0, 0.5, 0, 0.5] }] as any, ctx);
    expect(validateScene(scene, limits)[0].message).toMatch(/normalized/);
  });

  it('reports structured errors for missing nodes and wrong node types', () => {
    expect(compileExpectingError([{ op: 'node.remove', nodeId: 'nope' }]).code).toBe('INVALID_REFERENCE');
    const e = compileExpectingError([{ op: 'node.setText', nodeId: 'wall-north', text: 'x' }]);
    expect(e.code).toBe('UNSUPPORTED_OPERATION');
    expect(e.details).toMatchObject({ opIndex: 0, nodeId: 'wall-north' });
  });

  it('refuses prototype-polluting paths', () => {
    const e = compileExpectingError([{ op: 'node.update', nodeId: 'wall-north', set: { 'props.__proto__': { x: 1 } } }]);
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(({} as any).x).toBeUndefined();
  });

  it('keepWorldTransform preserves world pose when reparenting', () => {
    const { scene } = compileOps(
      starterScene(),
      [{ op: 'node.reparent', nodeId: 'label-welcome', parentId: 'room-main', keepWorldTransform: true }] as any,
      ctx,
    );
    // label at local [0, 1.1, 0.085] on north wall at [0, 1.75, -4.075]
    const p = scene.nodes['label-welcome'].transform.position;
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(2.85);
    expect(p[2]).toBeCloseTo(-3.99);
  });
});
