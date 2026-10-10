import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsImport from 'ajv-formats';
import { Type } from 'typebox';
import { Environment, Ext, LIMITS, NODE_SCHEMAS, NodeId, SCENE_SCHEMA_VERSION, ViewerAnchor, type NodeType, type SceneT } from '../schemas/scene.js';

const addFormats = ((addFormatsImport as any).default ?? addFormatsImport) as (ajv: Ajv) => Ajv;

export const ajv = addFormats(new Ajv({ allErrors: true, strict: true }));

const nodeValidators = Object.fromEntries(
  Object.entries(NODE_SCHEMAS).map(([type, schema]) => [type, ajv.compile(schema)]),
) as Record<NodeType, ValidateFunction>;

// Top-level shape; nodes are validated individually by type for precise errors.
const validateShell = ajv.compile(
  Type.Object(
    {
      schemaVersion: Type.Literal(SCENE_SCHEMA_VERSION),
      environment: Environment,
      viewerAnchor: ViewerAnchor,
      nodes: Type.Record(NodeId, Type.Object({}, { additionalProperties: true })),
      ext: Ext,
    },
    { additionalProperties: false },
  ),
);

export interface SceneIssue {
  path: string;
  message: string;
  nodeId?: string;
}

function ajvIssues(errs: ErrorObject[] | null | undefined, prefix: string, nodeId?: string): SceneIssue[] {
  return (errs ?? []).slice(0, 20).map((e) => ({
    path: `${prefix}${e.instancePath}`,
    message: `${e.message ?? 'invalid'}${e.params && 'additionalProperty' in e.params ? `: ${e.params.additionalProperty}` : ''}${
      e.params && 'allowedValue' in e.params ? `: ${JSON.stringify(e.params.allowedValue)}` : ''
    }`,
    ...(nodeId ? { nodeId } : {}),
  }));
}

function findNonFinite(value: unknown, path: string, out: SceneIssue[], nodeId?: string) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push({ path, message: 'must be a finite number', nodeId });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findNonFinite(v, `${path}/${i}`, out, nodeId));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findNonFinite(v, `${path}/${k}`, out, nodeId);
  }
}

function quatIssue(q: unknown, path: string, nodeId?: string): SceneIssue | null {
  if (!Array.isArray(q) || q.length !== 4) return null; // shape errors reported by Ajv
  const len = Math.hypot(...(q as number[]));
  return Math.abs(len - 1) > 1e-3 ? { path, message: `quaternion must be normalized (length ${len.toFixed(4)})`, nodeId } : null;
}

export interface ValidateOptions {
  maxNodes: number;
  maxSceneBytes: number;
  // Only these nodes get full schema validation (others were valid before). Omit for all.
  touched?: Set<string>;
}

export function validateNodeShape(node: any, nodeIdForErrors?: string): SceneIssue[] {
  const id = nodeIdForErrors ?? node?.id;
  const prefix = `/nodes/${id}`;
  const validator = nodeValidators[node?.type as NodeType];
  if (!validator) return [{ path: `${prefix}/type`, message: `unsupported node type ${JSON.stringify(node?.type)}`, nodeId: id }];
  const issues: SceneIssue[] = [];
  findNonFinite(node, prefix, issues, id);
  if (issues.length) return issues;
  if (!validator(node)) return ajvIssues(validator.errors, prefix, id);
  const n = node as { transform: { rotation: unknown }; ext: unknown };
  const q = quatIssue(n.transform.rotation, `${prefix}/transform/rotation`, id);
  if (q) issues.push(q);
  if (JSON.stringify(n.ext).length > LIMITS.extBytes)
    issues.push({ path: `${prefix}/ext`, message: `ext exceeds ${LIMITS.extBytes} bytes`, nodeId: id });
  return issues;
}

// Full validation: schema, graph integrity, limits. Returns [] when valid.
export function validateScene(scene: SceneT, opts: ValidateOptions): SceneIssue[] {
  const issues: SceneIssue[] = [];
  findNonFinite(scene.environment, '/environment', issues);
  findNonFinite(scene.viewerAnchor, '/viewerAnchor', issues);
  if (issues.length) return issues;
  if (!validateShell(scene)) return ajvIssues(validateShell.errors, '');
  const q = quatIssue(scene.viewerAnchor.rotation, '/viewerAnchor/rotation');
  if (q) issues.push(q);
  if (JSON.stringify(scene.ext).length > LIMITS.extBytes) issues.push({ path: '/ext', message: 'ext too large' });

  const nodes = scene.nodes as Record<string, any>;
  const ids = Object.keys(nodes);
  if (ids.length > opts.maxNodes) issues.push({ path: '/nodes', message: `scene has more than ${opts.maxNodes} nodes` });

  for (const id of ids) {
    const node = nodes[id] as any;
    if (opts.touched && !opts.touched.has(id)) continue;
    if (node.id !== id) issues.push({ path: `/nodes/${id}/id`, message: 'node id must match its key', nodeId: id });
    issues.push(...validateNodeShape(node, id));
  }
  if (issues.length) return issues.slice(0, 50);

  // Graph: parents exist, no cycles, bounded depth. Checked for every node (cheap).
  for (const id of ids) {
    let current = nodes[id].parentId;
    let depth = 0;
    const seen = new Set([id]);
    while (current !== null) {
      if (!(current in nodes)) {
        issues.push({ path: `/nodes/${id}/parentId`, message: `parent ${current} does not exist`, nodeId: id });
        break;
      }
      if (seen.has(current)) {
        issues.push({ path: `/nodes/${id}/parentId`, message: 'parent relationship forms a cycle', nodeId: id });
        break;
      }
      seen.add(current);
      if (++depth > LIMITS.maxDepth) {
        issues.push({ path: `/nodes/${id}/parentId`, message: `nesting deeper than ${LIMITS.maxDepth}`, nodeId: id });
        break;
      }
      current = nodes[current].parentId;
    }
  }
  const roomId = scene.viewerAnchor.roomId;
  if (roomId !== null && nodes[roomId]?.type !== 'room')
    issues.push({ path: '/viewerAnchor/roomId', message: `room ${roomId} does not exist` });

  if (!issues.length) {
    const bytes = Buffer.byteLength(JSON.stringify(scene));
    if (bytes > opts.maxSceneBytes) issues.push({ path: '', message: `scene is ${bytes} bytes; limit ${opts.maxSceneBytes}` });
  }
  return issues.slice(0, 50);
}

// Asset IDs referenced by the given nodes (artwork images and material textures).
export function referencedAssetIds(scene: SceneT, nodeIds?: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const ids = nodeIds ?? Object.keys(scene.nodes);
  for (const id of ids) {
    const node = scene.nodes[id] as any;
    if (!node) continue;
    if (node.type === 'artwork' && node.props.assetId) out.add(node.props.assetId);
    if (node.props?.material?.textureAssetId) out.add(node.props.material.textureAssetId);
  }
  return out;
}
