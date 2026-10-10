// Machine-readable description of what the backend supports, so clients can generate
// property controls and disable unavailable actions without hard-coding rules.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import type { App } from '../app.js';
import { AUDIO_INPUT_FORMATS } from '../assistant/audio.js';
import { SUPPORTED_IMAGE_FORMATS } from '../assets/service.js';
import { capabilitiesFor, requireAccess } from '../galleries/access.js';
import { principalFor } from '../http/context.js';
import { LANGUAGES, type Lang } from '../lib/i18n.js';
import { GalleryIdParams } from '../schemas/api.js';
import { describeFields } from '../schemas/describe.js';
import { Operation } from '../schemas/operations.js';
import { Environment, LIMITS, NODE_PROPS, NODE_SCHEMAS, NODE_TYPES, SCENE_SCHEMA_VERSION, ViewerAnchor } from '../schemas/scene.js';
import { DEFAULT_PROPS } from '../scene/defaults.js';

export const SMOKE_REPORT_PATH = path.resolve(process.env.ASSISTANT_SMOKE_REPORT ?? 'reports/gemini-smoke.json');

const LANGUAGE_NAMES: Record<Lang, { english: string; native: string }> = {
  en: { english: 'English', native: 'English' },
  ht: { english: 'Haitian Creole', native: 'Kreyòl ayisyen' },
  fr: { english: 'French', native: 'Français' },
  es: { english: 'Spanish', native: 'Español' },
  ko: { english: 'Korean', native: '한국어' },
};

// What the provider documentation says (checked 2026-10-10), kept separate from what was
// actually verified by a live smoke test with the configured key and models.
const DOCUMENTED: Record<'textUnderstanding' | 'audioInput' | 'speechOutput', string> = {
  textUnderstanding: 'Gemini is multilingual; no per-language guarantee is published.',
  audioInput: 'Gemini audio understanding is multilingual; no per-language accuracy is published.',
  speechOutput: 'Gemini 3.8 Flash TTS documentation lists English, Haitian Creole, French, Spanish and Korean.',
};

let smokeCache: { at: number; value: any } | null = null;
async function smokeReport() {
  if (smokeCache && Date.now() - smokeCache.at < 60_000) return smokeCache.value;
  let value: any = null;
  try {
    value = JSON.parse(await readFile(SMOKE_REPORT_PATH, 'utf8'));
  } catch {
    /* no report yet */
  }
  smokeCache = { at: Date.now(), value };
  return value;
}

export async function capabilitiesRoutes(app: App) {
  const { config, assistant, donations } = app.deps;

  const operations = (Operation.anyOf as any[]).map((s) => ({
    name: s.properties.op.const as string,
    description: s.description as string,
    fields: describeFields({ properties: Object.fromEntries(Object.entries<any>(s.properties).filter(([k]) => k !== 'op')) }),
    required: (s.required ?? []).filter((k: string) => k !== 'op'),
  }));
  const common = describeFields({
    properties: Object.fromEntries(Object.entries<any>(NODE_SCHEMAS.group.properties).filter(([k]) => !['props', 'type', 'ext'].includes(k))),
  });
  const nodeTypes = Object.fromEntries(
    NODE_TYPES.map((t) => [t, { fields: describeFields(NODE_PROPS[t], 'props'), defaults: { props: DEFAULT_PROPS[t] } }]),
  );

  app.get(
    '/v1/capabilities',
    {
      schema: {
        tags: ['meta'],
        summary: 'Supported node types, editable fields with units and bounds, operations, formats, languages and roles',
        description:
          'Static for a deployment (cache it per session). For full JSON Schemas see /v1/schemas/{scene|operation|node}. For the caller\'s effective role in a gallery see /v1/galleries/{id}/capabilities.',
        security: [],
        response: { 200: Type.Unknown() },
      },
    },
    async () => {
      const smoke = await smokeReport();
      const a = config.assistant;
      const langCaps = Object.fromEntries(
        LANGUAGES.map((l) => [
          l,
          {
            ...LANGUAGE_NAMES[l],
            uiMessages: 'implemented (machine-written; native review recommended)',
            textCommands: smoke?.languages?.[l]?.text ?? 'unverified',
            voiceCommands: smoke?.languages?.[l]?.audioInput ?? 'unverified',
            spokenReplies: smoke?.languages?.[l]?.speechOutput ?? 'unverified',
          },
        ]),
      );
      return {
        apiVersion: 'v1',
        realtimeProtocolVersion: 1,
        sceneSchemaVersion: SCENE_SCHEMA_VERSION,
        conventions: {
          units: 'meters; light angles in radians',
          handedness: 'right-handed',
          up: '+Y',
          forward: 'local -Z (walls, artwork and text show their front face toward local +Z)',
          rotation: 'unit quaternion [x, y, z, w]',
          scale: 'per-axis, strictly positive (no mirroring)',
          hierarchy: 'transform is relative to parentId; world = parentWorld * T * R * S',
          color: 'sRGB hex "#rrggbb"',
          viewerAnchor: 'world-space eye position + base orientation; phones apply local head rotation on top (anchor * head)',
          docs: 'docs/scene-model.md',
        },
        commonNodeFields: common,
        nodeTypes,
        environmentFields: describeFields(Environment, 'environment'),
        viewerAnchorFields: describeFields(ViewerAnchor, 'viewerAnchor'),
        operations,
        limits: {
          maxNodes: config.limits.maxNodes,
          maxOpsPerBatch: config.limits.maxOpsPerBatch,
          maxSceneBytes: config.limits.maxSceneBytes,
          maxNestingDepth: LIMITS.maxDepth,
          maxExtBytes: LIMITS.extBytes,
          coordinateRange: [-LIMITS.coordinate, LIMITS.coordinate],
          scaleRange: [LIMITS.minScale, LIMITS.maxScale],
          eventReplayWindow: config.limits.eventReplayWindow,
          maxEditorsPerGallery: config.limits.maxEditorsPerGallery,
          maxEditorConnectionsPerGallery: config.limits.maxEditorConnectionsPerGallery,
          maxViewerConnectionsPerGallery: config.limits.maxViewerConnectionsPerGallery,
          note: 'Starting assumptions for a small demo (about 5 editors and 10 viewers per gallery), not measured capacity guarantees.',
        },
        liveEditing: {
          recommendedTransformThrottleMs: 50,
          guidance: 'While dragging, send coalesced node.setTransform batches at most every 50 ms (latest value wins) with conflictMode "merge"; send one final batch on release. Never send assets or whole scenes.',
        },
        assets: {
          imageFormats: SUPPORTED_IMAGE_FORMATS.map((f) => `image/${f}`),
          maxUploadBytes: config.limits.maxUploadBytes,
          maxImagePixels: config.limits.maxImagePixels,
          variants: [
            { name: 'original', note: 'same format as upload, metadata stripped, EXIF orientation applied' },
            { name: 'thumb', maxEdge: 256, formats: ['webp'] },
            { name: 'medium', maxEdge: 1024, formats: ['webp', 'jpeg or png (if transparent)'] },
            { name: 'large', maxEdge: 2048, formats: ['webp', 'jpeg or png (if transparent)'], note: 'only when the image is larger than 1024 px' },
          ],
          signedUrlTtlSec: config.signedUrlTtlSec,
        },
        assistant: {
          enabled: assistant.enabled,
          provider: assistant.providerName,
          models: assistant.providerName === 'gemini' ? { plan: a.planModel, speech: a.ttsModel } : null,
          inputs: ['text', 'push-to-talk audio clip'],
          audioInputFormats: AUDIO_INPUT_FORMATS,
          maxAudioBytes: a.maxAudioBytes,
          maxAudioSeconds: a.maxAudioSeconds,
          maxInputChars: a.maxInputChars,
          commandsPerMinute: a.commandsPerMinute,
          speechOutputFormat: 'audio/wav (24 kHz mono 16-bit by default)',
          commandStatuses: ['queued', 'processing', 'applied', 'needs_clarification', 'answered', 'failed', 'cancelled'],
          documented: DOCUMENTED,
          lastSmokeTest: smoke ? { at: smoke.at, models: smoke.models } : null,
          languages: langCaps,
        },
        languages: LANGUAGES,
        roles: {
          owner: capabilitiesFor('owner'),
          editor: capabilitiesFor('editor'),
          viewer: capabilitiesFor('viewer'),
          viewerSession: { ...capabilitiesFor('editor', true), note: 'vs_ tokens and view tickets are read-only regardless of the account role' },
        },
        sharingModes: ['restricted', 'view_link', 'edit_link'],
        features: { assistant: assistant.enabled, voiceCommands: assistant.enabled, spokenReplies: assistant.enabled, qrCodes: true, phonePairing: true, undoRedo: true, donations: donations.enabled },
        donations: donations.enabled
          ? { currency: 'SOL', cluster: config.solana.cluster, minDonationLamports: config.solana.minDonationLamports, custodial: true, goal: false, docs: 'docs/donations.md' }
          : null,
        realtime: { heartbeatMs: config.heartbeatMs, ticketTtlSec: config.auth.wsTicketTtlSec, docs: 'docs/websocket-protocol.md' },
      };
    },
  );

  app.get(
    '/v1/galleries/:galleryId/capabilities',
    {
      schema: {
        tags: ['meta'],
        summary: "The caller's effective role and capabilities in a gallery (use to enable/disable UI)",
        params: GalleryIdParams,
      },
    },
    async (req) => {
      const p = principalFor(req, req.params.galleryId);
      const access = await requireAccess(app.deps.db, req.params.galleryId, p, 'view');
      const caps = capabilitiesFor(access.role, p.readOnly);
      return {
        galleryId: req.params.galleryId,
        role: access.role,
        via: access.via,
        sharingMode: access.sharingMode,
        readOnlySession: !!p.readOnly,
        ...caps,
        canUseAssistant: caps.canUseAssistant && assistant.enabled,
        allowedOperations: caps.canEdit ? operations.map((o) => o.name) : [],
      };
    },
  );

  const schemaDoc = (s: unknown) => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...(s as object) });
  app.get('/v1/schemas/scene', { schema: { tags: ['meta'], summary: 'JSON Schema of the scene document', security: [] } }, async () =>
    schemaDoc((await import('../schemas/scene.js')).Scene),
  );
  app.get('/v1/schemas/operation', { schema: { tags: ['meta'], summary: 'JSON Schema of one scene operation', security: [] } }, async () => schemaDoc(Operation));
  app.get(
    '/v1/schemas/node/:type',
    { schema: { tags: ['meta'], summary: 'JSON Schema of one node type', security: [], params: Type.Object({ type: Type.Union(NODE_TYPES.map((t) => Type.Literal(t)) as any) }) } },
    async (req) => schemaDoc(NODE_SCHEMAS[(req.params as any).type as keyof typeof NODE_SCHEMAS]),
  );
}
