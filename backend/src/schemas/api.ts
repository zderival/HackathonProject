// Shared HTTP envelope schemas.
import { Type } from 'typebox';

export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ description: 'Stable machine-readable code, e.g. REVISION_CONFLICT.' }),
      message: Type.String({ description: 'User-facing message in the request language.' }),
      details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      requestId: Type.String({ description: 'Echoed in the X-Request-Id response header; quote it in bug reports.' }),
    }),
  },
  { title: 'ErrorResponse' },
);

export const GalleryIdParams = Type.Object({ galleryId: Type.String({ format: 'uuid' }) });

export const Role = Type.Union([Type.Literal('owner'), Type.Literal('editor'), Type.Literal('viewer')]);
export const SharingMode = Type.Union([Type.Literal('restricted'), Type.Literal('view_link'), Type.Literal('edit_link')]);

export const Capabilities = Type.Object({
  canView: Type.Boolean(),
  canEdit: Type.Boolean(),
  canManage: Type.Boolean(),
  canUseAssistant: Type.Boolean(),
  canUpload: Type.Boolean(),
});

export const GallerySummary = Type.Object({
  id: Type.String({ format: 'uuid' }),
  title: Type.String(),
  description: Type.String(),
  ownerId: Type.String({ format: 'uuid' }),
  role: Role,
  capabilities: Capabilities,
  sharingMode: SharingMode,
  revision: Type.Integer(),
  schemaVersion: Type.Integer(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
