// Scene operations: the only way to change a scene. Manual edits, AI plans, undo and
// redo all go through the same pipeline (src/actions/service.ts).
import { Type, type Static } from 'typebox';
import {
  AssetId,
  Color,
  Environment,
  Frame,
  Material,
  NodeId,
  NodeTypeSchema,
  Quat,
  Scale,
  Vec3,
  ViewerAnchor,
} from './scene.js';

const op = <T extends string, P extends Record<string, any>>(name: T, props: P, description: string) =>
  Type.Object({ op: Type.Literal(name), ...props }, { additionalProperties: false, description, title: name });

// Dotted path into a node, e.g. "transform.position", "props.frame.color", "visible".
export const NodePath = Type.String({
  pattern: '^(name|visible|locked|transform(\\.(position|rotation|scale))?|props(\\.[A-Za-z][A-Za-z0-9]{0,40}){0,2}|ext(\\.[A-Za-z0-9_.-]{1,64})?)$',
  description: 'Dotted property path inside a node. Use node.reparent to change parentId.',
});

const NodeInput = Type.Object(
  {
    id: Type.Optional(NodeId),
    type: NodeTypeSchema,
    name: Type.Optional(Type.String({ maxLength: 120 })),
    parentId: Type.Optional(Type.Union([NodeId, Type.Null()])),
    transform: Type.Optional(
      Type.Object(
        { position: Type.Optional(Vec3), rotation: Type.Optional(Quat), scale: Type.Optional(Scale) },
        { additionalProperties: false },
      ),
    ),
    visible: Type.Optional(Type.Boolean()),
    locked: Type.Optional(Type.Boolean()),
    props: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    ext: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  {
    additionalProperties: false,
    description: 'New node. Missing fields are filled with type defaults (see capabilities.defaults); the result is fully validated.',
  },
);

export const Operation = Type.Union([
  op('node.add', { node: NodeInput }, 'Create a node. The ID is generated when omitted.'),
  op(
    'node.update',
    { nodeId: NodeId, set: Type.Record(NodePath, Type.Unknown(), { minProperties: 1, maxProperties: 50 }) },
    'Set one or more properties by path. Object values are merged key by key.',
  ),
  op('node.remove', { nodeId: NodeId }, 'Remove a node and all its descendants.'),
  op(
    'node.duplicate',
    { nodeId: NodeId, newId: Type.Optional(NodeId), offset: Type.Optional(Vec3) },
    'Copy a node (and descendants). The copy is offset in parent space (default [0.3, 0, 0]).',
  ),
  op(
    'node.reparent',
    { nodeId: NodeId, parentId: Type.Union([NodeId, Type.Null()]), keepWorldTransform: Type.Optional(Type.Boolean()) },
    'Move a node under another parent. keepWorldTransform (default false) preserves its world pose.',
  ),
  op(
    'node.setTransform',
    { nodeId: NodeId, position: Type.Optional(Vec3), rotation: Type.Optional(Quat), scale: Type.Optional(Scale) },
    'Set any of position / rotation / scale (local).',
  ),
  op('node.setMaterial', { nodeId: NodeId, material: Type.Partial(Material) }, 'Change material fields of a wall, floor, ceiling or primitive.'),
  op('node.setVisibility', { nodeId: NodeId, visible: Type.Boolean() }, 'Show or hide a node.'),
  op('node.setText', { nodeId: NodeId, text: Type.String({ maxLength: 500 }) }, 'Change a text label.'),
  op(
    'artwork.place',
    {
      nodeId: Type.Optional(NodeId),
      assetId: AssetId,
      parentId: Type.Optional(Type.Union([NodeId, Type.Null()])),
      position: Type.Optional(Vec3),
      rotation: Type.Optional(Quat),
      width: Type.Optional(Type.Number({ minimum: 0.01, maximum: 20 })),
      title: Type.Optional(Type.String({ maxLength: 200 })),
    },
    'Create an artwork panel for an asset, or swap the image of an existing one (nodeId). Height follows the image aspect ratio.',
  ),
  op(
    'artwork.hangOnWall',
    {
      nodeId: NodeId,
      wallId: NodeId,
      x: Type.Optional(Type.Number({ minimum: -100, maximum: 100, description: 'Offset along the wall from its center (m).' })),
      centerHeight: Type.Optional(
        Type.Number({ minimum: 0, maximum: 50, description: 'Height of the artwork center above the wall bottom (m). Default 1.5.' }),
      ),
    },
    'Reparent an artwork onto a wall, facing out from the wall front.',
  ),
  op('artwork.setFrame', { nodeId: NodeId, frame: Type.Partial(Frame) }, 'Change frame settings of an artwork.'),
  op(
    'room.resize',
    {
      nodeId: NodeId,
      width: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      depth: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      height: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    },
    "Resize a room. Its shell walls (props.shell set), floor and ceiling children are moved and resized to match.",
  ),
  op(
    'scene.setEnvironment',
    { environment: Type.Partial(Environment) },
    'Change background, ambient light and fog. Nested fog fields merge.',
  ),
  op(
    'scene.setViewerAnchor',
    {
      position: Vec3,
      rotation: Quat,
      roomId: Type.Optional(Type.Union([NodeId, Type.Null()])),
    },
    'Move the shared viewpoint used by phone viewers. Head tracking is composed on top by the phone.',
  ),
]);

export type OperationT = Static<typeof Operation>;
export const OPERATION_NAMES = Operation.anyOf.map((s: any) => s.properties.op.const as string);

// Primitive, invertible changes produced by compiling operations. Stored in history.
export type Change =
  | { kind: 'node.add'; node: any }
  | { kind: 'node.remove'; node: any }
  | { kind: 'node.set'; nodeId: string; path: string; before: unknown; after: unknown }
  | { kind: 'scene.set'; path: string; before: unknown; after: unknown };

// Compact form sent to clients in "ops" events and HTTP results.
export const WireChange = Type.Union([
  Type.Object({ kind: Type.Literal('node.add'), node: Type.Unknown({ description: 'Full SceneNode.' }) }),
  Type.Object({ kind: Type.Literal('node.remove'), nodeId: NodeId }),
  Type.Object({ kind: Type.Literal('node.set'), nodeId: NodeId, path: Type.String(), value: Type.Unknown() }),
  Type.Object({
    kind: Type.Literal('scene.set'),
    path: Type.String({ description: 'e.g. "environment.fog.color" or "viewerAnchor".' }),
    value: Type.Unknown(),
  }),
]);
export type WireChangeT = Static<typeof WireChange>;

export function toWire(changes: Change[]): WireChangeT[] {
  return changes.map((c) => {
    switch (c.kind) {
      case 'node.add':
        return { kind: c.kind, node: c.node };
      case 'node.remove':
        return { kind: c.kind, nodeId: c.node.id };
      case 'node.set':
        return { kind: c.kind, nodeId: c.nodeId, path: c.path, value: c.after };
      case 'scene.set':
        return { kind: c.kind, path: c.path, value: c.after };
    }
  });
}

export const ConflictMode = Type.Union([Type.Literal('strict'), Type.Literal('merge')], {
  description:
    'strict (default): fail if the gallery revision is not baseRevision. merge: fail only if a change committed after baseRevision touched the same node properties (or removed/added the same nodes).',
});

export const ActionRequest = Type.Object(
  {
    requestId: Type.String({ minLength: 8, maxLength: 100, description: 'Client-generated idempotency key (UUID recommended).' }),
    actionId: Type.Optional(Type.String({ format: 'uuid', description: 'Optional client-generated action ID.' })),
    baseRevision: Type.Integer({ minimum: 0, description: 'Revision the client based these edits on.' }),
    conflictMode: Type.Optional(ConflictMode),
    label: Type.Optional(Type.String({ maxLength: 200, description: 'Human label shown in history, e.g. "Move painting".' })),
    ops: Type.Array(Operation, { minItems: 1, maxItems: 200 }),
  },
  { additionalProperties: false },
);
export type ActionRequestT = Static<typeof ActionRequest>;

export { Color, ViewerAnchor };
