// WebSocket message contract (protocol version 1). Client messages are validated at
// runtime; server message schemas document what clients receive and are exported to
// contracts/ for type generation. Narrative: docs/websocket-protocol.md.
import { Type } from 'typebox';
import { ActionRequest, WireChange } from '../schemas/operations.js';
import { Scene } from '../schemas/scene.js';

const Role = Type.Union([Type.Literal('owner'), Type.Literal('editor'), Type.Literal('viewer')]);
const Capability = Type.Union([Type.Literal('edit'), Type.Literal('view')]);

// ---- Client -> server ---------------------------------------------------------

export const ClientPing = Type.Object({ type: Type.Literal('ping'), t: Type.Optional(Type.Number()) }, { additionalProperties: false, title: 'ClientPing' });
export const ClientResync = Type.Object(
  {
    type: Type.Literal('resync'),
    fromRevision: Type.Optional(Type.Integer({ minimum: 0, description: 'Last revision applied locally; omit to request a fresh snapshot.' })),
  },
  { additionalProperties: false, title: 'ClientResync' },
);
export const ClientSubmit = Type.Object(
  { type: Type.Literal('submit'), clientMsgId: Type.String({ maxLength: 100 }), action: ActionRequest },
  { additionalProperties: false, title: 'ClientSubmit', description: 'Edit connections only. Same semantics as POST /actions.' },
);
export const ClientMessage = Type.Union([ClientPing, ClientResync, ClientSubmit], { title: 'ClientMessage' });

// ---- Server -> client ---------------------------------------------------------

const CapabilityFlags = {
  canView: Type.Boolean(),
  canEdit: Type.Boolean(),
  canManage: Type.Boolean(),
  canUseAssistant: Type.Boolean(),
  canUpload: Type.Boolean(),
};

export const ServerHello = Type.Object(
  {
    type: Type.Literal('hello'),
    connectionId: Type.String(),
    galleryId: Type.String(),
    role: Role,
    capability: Capability,
    ...CapabilityFlags,
    heartbeatMs: Type.Integer(),
    serverTime: Type.String(),
    protocolVersion: Type.Literal(1),
  },
  { title: 'ServerHello' },
);

export const ServerSnapshot = Type.Object(
  {
    type: Type.Literal('snapshot'),
    galleryId: Type.String(),
    revision: Type.Integer(),
    reason: Type.Union([Type.Literal('initial'), Type.Literal('requested'), Type.Literal('gap')]),
    scene: Scene,
  },
  { title: 'ServerSnapshot', description: 'Authoritative state. Replace the local copy entirely.' },
);

export const ServerOps = Type.Object(
  {
    type: Type.Literal('ops'),
    eventId: Type.String({ description: '"<galleryId>:<revision>", unique; use for duplicate suppression.' }),
    galleryId: Type.String(),
    revision: Type.Integer({ description: 'Apply only if it equals localRevision + 1.' }),
    baseRevision: Type.Integer(),
    actionId: Type.String(),
    requestId: Type.String(),
    source: Type.Union([Type.Literal('manual'), Type.Literal('ai'), Type.Literal('undo'), Type.Literal('redo'), Type.Literal('system')]),
    actor: Type.Union([Type.Object({ userId: Type.String(), displayName: Type.String() }), Type.Null()]),
    label: Type.Union([Type.String(), Type.Null()]),
    undoOf: Type.Union([Type.Integer(), Type.Null()]),
    redoOf: Type.Union([Type.Integer(), Type.Null()]),
    ts: Type.String({ format: 'date-time' }),
    changes: Type.Array(WireChange),
  },
  { title: 'ServerOps', description: 'One committed action. Changes are applied in order.' },
);

export const ServerAck = Type.Object(
  {
    type: Type.Literal('ack'),
    clientMsgId: Type.String(),
    requestId: Type.String(),
    actionId: Type.String(),
    revision: Type.Integer(),
    duplicate: Type.Boolean(),
    noop: Type.Boolean(),
  },
  { title: 'ServerAck', description: 'Your submit committed. The matching "ops" event is delivered separately, in revision order.' },
);

export const ServerError = Type.Object(
  {
    type: Type.Literal('error'),
    code: Type.String(),
    message: Type.String({ description: 'Localized.' }),
    clientMsgId: Type.Optional(Type.String()),
    requestId: Type.Optional(Type.String()),
    details: Type.Optional(Type.Unknown()),
    fatal: Type.Optional(Type.Boolean({ description: 'true: the server closes the connection next.' })),
  },
  { title: 'ServerError' },
);

export const ServerPermissions = Type.Object(
  { type: Type.Literal('permissions'), galleryId: Type.String(), role: Role, capability: Capability, ...CapabilityFlags },
  { title: 'ServerPermissions', description: 'Your access changed (e.g. downgraded to viewer). Update the UI immediately.' },
);

export const ServerPong = Type.Object(
  { type: Type.Literal('pong'), t: Type.Optional(Type.Number()), serverTime: Type.String(), revision: Type.Integer() },
  { title: 'ServerPong' },
);

export const ServerAssistant = Type.Object(
  { type: Type.Literal('assistant'), command: Type.Unknown({ description: 'AssistantCommand (see OpenAPI).' }) },
  { title: 'ServerAssistant', description: 'Private to the requesting user on their edit connections.' },
);

export const ServerDonation = Type.Object(
  {
    type: Type.Union([Type.Literal('donation'), Type.Literal('donations')]),
    galleryId: Type.String(),
    donation: Type.Optional(Type.Unknown({ description: 'The newly verified donation (type "donation").' })),
    summary: Type.Unknown({ description: 'Same shape as GET /v1/galleries/{id}/donations.' }),
  },
  { title: 'ServerDonation', description: 'Donation verified on-chain ("donation") or donation settings changed ("donations"). Not part of the revision sequence.' },
);

export const ServerMessage = Type.Union([ServerHello, ServerSnapshot, ServerOps, ServerAck, ServerError, ServerPermissions, ServerPong, ServerAssistant, ServerDonation], {
  title: 'ServerMessage',
});

export const CLOSE_CODES = {
  1000: 'normal close',
  1001: 'server shutting down: reconnect with backoff',
  4001: 'ticket invalid/expired/used: get a new ticket',
  4002: 'protocol error',
  4008: 'slow consumer / too many pending events: reconnect and resync',
  4029: 'too many connections for this gallery',
  4403: 'access revoked: do not reconnect without re-resolving access',
} as const;
