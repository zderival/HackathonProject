// Authoritative, renderer-independent scene schema (scene schema version 1).
//
// Conventions (see docs/scene-model.md for the full explanation and Unity conversion):
//   * Units are meters; angles inside light props are radians.
//   * Right-handed coordinates, +Y up, local forward is -Z. Walls, artwork and text
//     show their front face toward local +Z (toward a camera looking down -Z at them).
//   * Rotation is a unit quaternion [x, y, z, w].
//   * Scale is per-axis and strictly positive (no mirroring).
//   * A node's transform is relative to its parent; world = parentWorld * T * R * S.
//   * Colors are sRGB hex strings "#rrggbb".
import { Type, type Static } from 'typebox';

export const SCENE_SCHEMA_VERSION = 1;

export const LIMITS = {
  coordinate: 500,
  maxScale: 100,
  minScale: 0.001,
  nameLength: 120,
  textLength: 500,
  descriptionLength: 2000,
  extBytes: 4096,
  maxDepth: 16,
} as const;

const finite = (min: number, max: number, description?: string) =>
  Type.Number({ minimum: min, maximum: max, ...(description ? { description } : {}) });

export const NodeId = Type.String({
  pattern: '^[A-Za-z0-9_-]{1,64}$',
  description: 'Stable node ID, unique within the scene.',
});
export const AssetId = Type.String({ format: 'uuid', description: 'ID of an uploaded asset in this gallery.' });
export const Color = Type.String({ pattern: '^#[0-9a-fA-F]{6}$', description: 'sRGB hex color "#rrggbb".' });

const coord = finite(-LIMITS.coordinate, LIMITS.coordinate);
export const Vec3 = Type.Tuple([coord, coord, coord], { description: 'Meters [x, y, z].' });
const qc = finite(-1, 1);
export const Quat = Type.Tuple([qc, qc, qc, qc], { description: 'Unit quaternion [x, y, z, w].' });
const sc = finite(LIMITS.minScale, LIMITS.maxScale);
export const Scale = Type.Tuple([sc, sc, sc], { description: 'Positive per-axis scale.' });

export const Transform = Type.Object(
  { position: Vec3, rotation: Quat, scale: Scale },
  { additionalProperties: false, description: 'Local transform relative to the parent node.' },
);

export const Ext = Type.Record(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,64}$' }), Type.Unknown(), {
  description: `Client extension metadata. Opaque to the server, at most ${LIMITS.extBytes} bytes as JSON.`,
});

export const Material = Type.Object(
  {
    color: Color,
    roughness: finite(0, 1),
    metalness: finite(0, 1),
    opacity: finite(0, 1),
    emissiveColor: Color,
    emissiveIntensity: finite(0, 10),
    textureAssetId: Type.Union([AssetId, Type.Null()]),
    textureRepeat: Type.Tuple([finite(0.01, 100), finite(0.01, 100)], { description: 'Texture tiling [u, v].' }),
  },
  { additionalProperties: false },
);

export const FrameStyle = Type.Union(
  [Type.Literal('none'), Type.Literal('thin'), Type.Literal('classic'), Type.Literal('modern'), Type.Literal('ornate')],
  { description: 'Frame geometry style, rendered by the client.' },
);

export const Frame = Type.Object(
  {
    style: FrameStyle,
    color: Color,
    width: finite(0, 1, 'Frame border width in meters.'),
    depth: finite(0, 0.5, 'Frame depth in meters.'),
    matColor: Color,
    matWidth: finite(0, 1, 'Mat (passe-partout) width in meters; 0 = no mat.'),
  },
  { additionalProperties: false },
);

const shape = (d: string, min: number, max: number) => finite(min, max, d);

export const RoomProps = Type.Object(
  {
    width: shape('Interior size along X (m).', 1, 200),
    depth: shape('Interior size along Z (m).', 1, 200),
    height: shape('Interior height (m).', 1, 50),
  },
  { additionalProperties: false },
);

export const WallSide = Type.Union(
  [Type.Literal('north'), Type.Literal('south'), Type.Literal('east'), Type.Literal('west'), Type.Null()],
  { description: 'Room shell side this wall belongs to; used by room.resize. north = -Z.' },
);

export const WallProps = Type.Object(
  {
    width: shape('Along local X (m).', 0.05, 200),
    height: shape('Along local Y (m), centered on the node origin.', 0.05, 50),
    thickness: shape('Along local Z (m); front face at +thickness/2.', 0.01, 5),
    shell: WallSide,
    material: Material,
  },
  { additionalProperties: false },
);

export const SurfaceProps = Type.Object(
  {
    width: shape('Along local X (m).', 0.05, 200),
    depth: shape('Along local Z (m).', 0.05, 200),
    material: Material,
  },
  { additionalProperties: false },
);

export const PrimitiveShape = Type.Union([
  Type.Literal('box'),
  Type.Literal('sphere'),
  Type.Literal('cylinder'),
  Type.Literal('cone'),
  Type.Literal('plane'),
  Type.Literal('torus'),
]);

export const PrimitiveProps = Type.Object(
  {
    shape: PrimitiveShape,
    size: Type.Tuple([finite(0.001, 100), finite(0.001, 100), finite(0.001, 100)], {
      description: 'Bounding size in meters [x, y, z] before scale; centered on the origin.',
    }),
    material: Material,
  },
  { additionalProperties: false },
);

export const ArtworkFit = Type.Union([Type.Literal('contain'), Type.Literal('cover'), Type.Literal('stretch')]);

export const ArtworkProps = Type.Object(
  {
    assetId: Type.Union([AssetId, Type.Null()], { description: 'Image asset shown on the panel; null = empty panel.' }),
    width: shape('Image area width (m), excluding frame.', 0.01, 20),
    height: shape('Image area height (m), excluding frame.', 0.01, 20),
    fit: ArtworkFit,
    title: Type.String({ maxLength: 200 }),
    description: Type.String({ maxLength: LIMITS.descriptionLength }),
    attribution: Type.String({ maxLength: 300 }),
    frame: Frame,
  },
  { additionalProperties: false },
);

export const TextAlign = Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')]);

export const TextProps = Type.Object(
  {
    text: Type.String({ maxLength: LIMITS.textLength }),
    fontSize: shape('Cap height in meters.', 0.01, 5),
    color: Color,
    align: TextAlign,
    maxWidth: shape('Wrap width in meters.', 0.1, 50),
    backgroundColor: Type.Union([Color, Type.Null()]),
    billboard: Type.Boolean({ description: 'If true the client keeps the label facing the camera.' }),
  },
  { additionalProperties: false },
);

export const GroupProps = Type.Object({}, { additionalProperties: false });

export const LightType = Type.Union([
  Type.Literal('ambient'),
  Type.Literal('directional'),
  Type.Literal('point'),
  Type.Literal('spot'),
]);

export const LightProps = Type.Object(
  {
    lightType: LightType,
    color: Color,
    intensity: finite(0, 100, 'Relative intensity; clients map to their light units.'),
    range: finite(0, 200, 'Point/spot falloff distance (m); 0 = infinite.'),
    angle: finite(0, Math.PI / 2, 'Spot cone half-angle (radians).'),
    penumbra: finite(0, 1),
    castShadow: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const NodeTypeSchema = Type.Union([
  Type.Literal('room'),
  Type.Literal('wall'),
  Type.Literal('floor'),
  Type.Literal('ceiling'),
  Type.Literal('primitive'),
  Type.Literal('artwork'),
  Type.Literal('text'),
  Type.Literal('group'),
  Type.Literal('light'),
]);

export const NODE_TYPES = ['room', 'wall', 'floor', 'ceiling', 'primitive', 'artwork', 'text', 'group', 'light'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_PROPS = {
  room: RoomProps,
  wall: WallProps,
  floor: SurfaceProps,
  ceiling: SurfaceProps,
  primitive: PrimitiveProps,
  artwork: ArtworkProps,
  text: TextProps,
  group: GroupProps,
  light: LightProps,
} as const;

function nodeSchema<T extends NodeType>(type: T) {
  return Type.Object(
    {
      id: NodeId,
      type: Type.Literal(type),
      name: Type.String({ maxLength: LIMITS.nameLength }),
      parentId: Type.Union([NodeId, Type.Null()]),
      transform: Transform,
      visible: Type.Boolean(),
      locked: Type.Boolean({ description: 'Editor hint: locked nodes are not selectable in the website editor.' }),
      props: NODE_PROPS[type],
      ext: Ext,
    },
    { additionalProperties: false, title: `${type} node` },
  );
}

export const NODE_SCHEMAS = {
  room: nodeSchema('room'),
  wall: nodeSchema('wall'),
  floor: nodeSchema('floor'),
  ceiling: nodeSchema('ceiling'),
  primitive: nodeSchema('primitive'),
  artwork: nodeSchema('artwork'),
  text: nodeSchema('text'),
  group: nodeSchema('group'),
  light: nodeSchema('light'),
} as const;

export const SceneNode = Type.Union(
  [
    NODE_SCHEMAS.room,
    NODE_SCHEMAS.wall,
    NODE_SCHEMAS.floor,
    NODE_SCHEMAS.ceiling,
    NODE_SCHEMAS.primitive,
    NODE_SCHEMAS.artwork,
    NODE_SCHEMAS.text,
    NODE_SCHEMAS.group,
    NODE_SCHEMAS.light,
  ],
  { description: 'Any scene node, discriminated by "type".' });

export const Environment = Type.Object(
  {
    backgroundColor: Color,
    skybox: Type.Union([Type.Literal('color'), Type.Literal('gradient'), Type.Literal('studio')]),
    gradientTopColor: Color,
    gradientBottomColor: Color,
    ambientColor: Color,
    ambientIntensity: finite(0, 10),
    fog: Type.Object(
      { enabled: Type.Boolean(), color: Color, near: finite(0, 1000), far: finite(0, 1000) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ViewerAnchor = Type.Object(
  {
    position: Vec3,
    rotation: Type.Tuple([qc, qc, qc, qc], {
      description: 'Base orientation; the phone composes its local head rotation on top: world = anchor * head.',
    }),
    roomId: Type.Union([NodeId, Type.Null()]),
  },
  { additionalProperties: false, description: 'Website-controlled viewpoint for phone viewers (world space, eye position).' },
);

export const Scene = Type.Object(
  {
    schemaVersion: Type.Literal(SCENE_SCHEMA_VERSION),
    environment: Environment,
    viewerAnchor: ViewerAnchor,
    nodes: Type.Record(NodeId, SceneNode, { description: 'All nodes keyed by ID; hierarchy via parentId.' }),
    ext: Ext,
  },
  { additionalProperties: false },
);

export type Vec3T = Static<typeof Vec3>;
export type QuatT = Static<typeof Quat>;
export type MaterialT = Static<typeof Material>;
export type FrameT = Static<typeof Frame>;
export type EnvironmentT = Static<typeof Environment>;
export type ViewerAnchorT = Static<typeof ViewerAnchor>;
export type SceneNodeT = Static<typeof SceneNode>;
export type SceneT = Static<typeof Scene>;
