// Minimal vector/quaternion helpers. Quaternions are [x, y, z, w].
export type V3 = [number, number, number];
export type Q = [number, number, number, number];

export function qMul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qConj(q: Q): Q {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function qNormalize(q: Q): Q {
  const len = Math.hypot(...q) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function qRotate(q: Q, v: V3): V3 {
  const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qConj(q));
  return [p[0], p[1], p[2]];
}

export interface Pose {
  position: V3;
  rotation: Q;
  scale: V3;
}

const isUniform = (s: V3) => Math.abs(s[0] - s[1]) < 1e-9 && Math.abs(s[1] - s[2]) < 1e-9;

// Composes parent * local. Exact when parent scale is uniform.
export function compose(parent: Pose, local: Pose): Pose {
  const scaled: V3 = [local.position[0] * parent.scale[0], local.position[1] * parent.scale[1], local.position[2] * parent.scale[2]];
  const r = qRotate(parent.rotation, scaled);
  return {
    position: [parent.position[0] + r[0], parent.position[1] + r[1], parent.position[2] + r[2]],
    rotation: qNormalize(qMul(parent.rotation, local.rotation)),
    scale: [parent.scale[0] * local.scale[0], parent.scale[1] * local.scale[1], parent.scale[2] * local.scale[2]],
  };
}

// Local pose that yields `world` under `parent`. Requires uniform parent scale.
export function relativeTo(parent: Pose, world: Pose): Pose {
  const inv = qConj(parent.rotation);
  const d: V3 = [world.position[0] - parent.position[0], world.position[1] - parent.position[1], world.position[2] - parent.position[2]];
  const r = qRotate(inv, d);
  return {
    position: [r[0] / parent.scale[0], r[1] / parent.scale[1], r[2] / parent.scale[2]],
    rotation: qNormalize(qMul(inv, world.rotation)),
    scale: [world.scale[0] / parent.scale[0], world.scale[1] / parent.scale[1], world.scale[2] / parent.scale[2]],
  };
}

export const IDENTITY_POSE: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

export { isUniform };

export const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;
