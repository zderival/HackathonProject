# Scene model (schema version 1)

The scene is a renderer-independent JSON document owned by the server. Clients render a
local copy and change it only through [operations](#operations). Machine-readable
definitions: `contracts/schemas/scene.schema.json`, `GET /v1/schemas/scene`, and the
field/bounds catalog in `GET /v1/capabilities`.

```jsonc
{
  "schemaVersion": 1,
  "environment": { "backgroundColor": "#20232a", "skybox": "gradient", "ambientColor": "#ffffff", "ambientIntensity": 0.4, "fog": { ... }, ... },
  "viewerAnchor": { "position": [0, 1.6, 2.5], "rotation": [0, 0, 0, 1], "roomId": "room-main" },
  "nodes": { "<nodeId>": { "id", "type", "name", "parentId", "transform", "visible", "locked", "props", "ext" } },
  "ext": {}
}
```

The gallery `revision` (an integer that increases by exactly 1 per committed action) is
returned next to the scene (`GET /v1/galleries/{id}/scene`) and on every event.

## Conventions

| Topic | Rule |
|---|---|
| Units | Meters. Light `angle` is in radians. |
| Handedness | Right-handed coordinate system. |
| Up | +Y. |
| Forward | A node's local forward is **-Z**. Walls, artwork panels and text labels show their front face toward local **+Z** (toward a camera that looks down -Z at them). |
| Rotation | Unit quaternion `[x, y, z, w]` (normalized within 1e-3; the server rejects others). Yaw by angle `a` about +Y is `[0, sin(a/2), 0, cos(a/2)]`. |
| Scale | Per-axis, strictly positive (0.001-100). Mirroring with negative scale is not supported. |
| Hierarchy | `transform` is relative to `parentId` (`null` = world). World = parentWorld x T x R x S (translate, then rotate, then scale; child positions are scaled by ancestor scale). Non-uniform scale on a parent shears rotated children; avoid it for groups. |
| Sizes | Geometric size lives in `props` (`width`, `height`, `size`, ...); `transform.scale` multiplies it. Prefer props for dimensions so physical sizes stay readable. |
| Colors | sRGB hex `"#rrggbb"` (no alpha; opacity is `material.opacity`). Convert to linear in linear-lighting pipelines. |
| IDs | Node IDs match `^[A-Za-z0-9_-]{1,64}$`, unique per scene, stable for the node's lifetime. Asset IDs are UUIDs. |
| Limits | Max nodes, nesting depth (16), scene bytes and coordinate range (+-500 m) are in `capabilities.limits`. |

### Pivot / geometry conventions per type

| Type | Origin | Geometry |
|---|---|---|
| `room` | floor center | logical container; `props.width` (X), `depth` (Z), `height` (Y). Shell walls/floor/ceiling are children. |
| `wall` | center of the wall | box `width` (X) x `height` (Y) x `thickness` (Z); front face at local z = +thickness/2. `props.shell` = `north|south|east|west|null` marks room-shell walls that `room.resize` keeps in place. North is -Z. |
| `floor`, `ceiling` | center | plane `width` (X) x `depth` (Z) in local XZ; floor faces +Y, ceiling faces -Y. |
| `primitive` | center of bounding box | `shape` box/sphere/cylinder/cone/plane/torus fitted to `size` [x, y, z]. Cylinder/cone axis is +Y; plane lies in XZ facing +Y; torus lies in XZ. |
| `artwork` | center of the image area | image rectangle `width` x `height` in local XY facing +Z; the frame (`frame.width`, `depth`, `style`) is drawn around it, outward and backward (-Z). `fit` contain/cover/stretch maps the texture into the rectangle. |
| `text` | horizontally: the left edge, center or right edge per `align`; vertically: the center of the text block | `fontSize` is cap height in meters, wrapped at `maxWidth`; faces +Z unless `billboard` is true. |
| `group` | its transform | no geometry. |
| `light` | light position | `point`/`spot` emit from the origin; `spot` and `directional` point along local **-Z**. `range` 0 = no falloff limit. `intensity` is relative; map it to your engine's units consistently. |

Material fields (`color`, `roughness`, `metalness`, `opacity`, `emissiveColor`,
`emissiveIntensity`, `textureAssetId`, `textureRepeat`) follow the metallic-roughness PBR
model (glTF semantics).

## Viewer anchor and head tracking

`viewerAnchor` is the shared, website-controlled viewpoint: a world-space **eye position**
and a **base orientation**. A phone viewer renders each eye with

```
worldFromHead = anchorPose x localHeadPose
```

where `localHeadPose` comes only from the phone's own sensors (rotation, and optionally
small positional tracking). Head movement is never sent to the server and never changes
the anchor, so it cannot turn other viewers. When the website moves the anchor
(`scene.setViewerAnchor`), every viewer receives the new pose in an `ops` event; clients
should ease to it (e.g. 300-600 ms interpolation, or a fade for large jumps) instead of
snapping. Recenter = reset the local head yaw reference, not the anchor.

## Converting to other engines

### Unity (left-handed, +Y up, forward +Z, quaternion fields x,y,z,w)

Mirror the Z axis:

| Scene (this API) | Unity |
|---|---|
| position `[x, y, z]` | `new Vector3(x, y, -z)` |
| rotation `[x, y, z, w]` | `new Quaternion(-x, -y, z, w)` |
| scale `[x, y, z]` | `new Vector3(x, y, z)` (unchanged) |
| "forward" (-Z) | `transform.forward` (+Z) |
| front face toward local +Z | front face toward local **-Z** in Unity: build quads/text so they face -Z, or rotate the mesh 180 deg about Y inside the node |
| color `"#rrggbb"` (sRGB) | `ColorUtility.TryParseHtmlString` (sRGB); Unity converts when the project uses linear color space |

Apply the conversion to every local transform (parents and children), then use Unity's
normal parenting; the hierarchy semantics match. The viewer anchor converts the same way;
compose with head tracking as `anchorRotation * headRotation` in Unity space.

Sanity check: a yaw of +90 deg here (`[0, 0.7071, 0, 0.7071]`) turns forward from -Z to -X
(the viewer's left). In Unity the converted quaternion `(0, -0.7071, 0, 0.7071)` turns
`transform.forward` from +Z to -X, which is the same world direction.

### three.js / WebGL / glTF

Same conventions (right-handed, +Y up, cameras look down -Z): copy values directly.
`quaternion.set(x, y, z, w)`, `color.set("#rrggbb")` (mark textures as sRGB).

### SceneKit / RealityKit (iOS)

Right-handed, +Y up, camera looks down -Z: copy directly (`simd_quatf(ix: x, iy: y, iz: z, r: w)`).

## Operations

Every change goes through `POST /v1/galleries/{id}/actions` (or the WebSocket `submit`
message) as an atomic batch. Full argument schemas: `contracts/schemas/operation.schema.json`
and `capabilities.operations`.

| Operation | Purpose |
|---|---|
| `node.add` | Create any node type; missing fields get type defaults (`capabilities.nodeTypes[t].defaults`). |
| `node.update` | Set properties by path (`"props.frame.color"`, `"transform.scale"`, `"ext.myClient.x"`). Objects merge key by key. |
| `node.remove` | Remove a node and its descendants. |
| `node.duplicate` | Copy a subtree with new IDs, offset in parent space. |
| `node.reparent` | Change parent; `keepWorldTransform` preserves the world pose. Cycles are rejected. |
| `node.setTransform` / `setMaterial` / `setVisibility` / `setText` | Focused setters. |
| `artwork.place` | Create an artwork panel for an uploaded asset (height follows the image aspect ratio), or swap the image of an existing panel. |
| `artwork.hangOnWall` | Reparent artwork onto a wall at offset `x` and `centerHeight`, facing out. |
| `artwork.setFrame` | Frame style/color/size and mat. |
| `room.resize` | Change room width/depth/height; shell walls, floor and ceiling follow. |
| `scene.setEnvironment` | Background, skybox, ambient light, fog. |
| `scene.setViewerAnchor` | Move the shared phone viewpoint. |

The server validates the whole resulting scene (types, finite numbers, bounds, normalized
quaternions, references, asset ownership, acyclic hierarchy, size limits) and rejects the
batch with a structured error (`INVALID_SCENE` with `details.issues[]`,
`INVALID_REFERENCE`, `UNSUPPORTED_OPERATION`, `VALIDATION_FAILED` with `details.opIndex`).
Unsupported edits are never silently ignored.

### Committed changes on the wire

Operations compile to primitive changes, which is what clients receive and apply in order:

```jsonc
{ "kind": "node.add",    "node": { /* full node */ } }
{ "kind": "node.remove", "nodeId": "n_abc" }
{ "kind": "node.set",    "nodeId": "wall-north", "path": "props.material.color", "value": "#000000" }
{ "kind": "scene.set",   "path": "viewerAnchor", "value": { "position": [0, 1.6, 1], "rotation": [0, 0, 0, 1], "roomId": "room-main" } }
```

`path` is dot-separated; set the value at that path (creating intermediate objects).
`node.remove` is emitted for every removed descendant (children first).

### Extension metadata

`ext` (scene and node level) holds up to 4 KB of client-defined JSON. The server stores it
but never interprets it. Namespace your keys (`"ext.webEditor.snapGrid"`).
