// Gallery authorization. Always resolved from the database at the moment of use;
// no role is ever trusted from a token.
//
// Precedence (highest wins):
//   1. Owner (galleries.owner_id).
//   2. Explicit membership (source invite/direct): its role, regardless of sharing mode.
//   3. Link membership (source link): editor only while sharing_mode = 'edit_link' AND
//      the membership's link_version equals the gallery's (rotation or disabling the
//      edit link removes it).
//   4. Share-link token presented with the request: viewer, while the gallery is in
//      view_link or edit_link mode and the token matches the current view link
//      (or the current edit link in edit_link mode).
//   5. Otherwise no access. In 'restricted' mode only 1-2 apply.
import type { DbClient } from '../db/pool.js';
import { AppError } from '../lib/errors.js';

export type Role = 'owner' | 'editor' | 'viewer';
export type SharingMode = 'restricted' | 'view_link' | 'edit_link';
export type Capability = 'view' | 'edit' | 'manage';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface GalleryAccess {
  galleryId: string;
  role: Role | null;
  via: 'owner' | 'member' | 'link_member' | 'link' | null;
  sharingMode: SharingMode;
  accessVersion: number;
}

export interface Principal {
  userId: string | null;
  linkToken?: string | null;
  // Viewer sessions/tickets are capped to read-only regardless of the account's role.
  readOnly?: boolean;
  // Set for phone/preview sessions: access ends when the session is revoked or expires.
  viewerSessionId?: string | null;
}

export function capabilitiesFor(role: Role | null, readOnly = false) {
  const canView = role !== null;
  const canEdit = !readOnly && (role === 'owner' || role === 'editor');
  const canManage = !readOnly && role === 'owner';
  return { canView, canEdit, canManage, canUseAssistant: canEdit, canUpload: canEdit };
}

export async function resolveAccess(db: DbClient, galleryId: string, p: Principal): Promise<GalleryAccess> {
  const { rows } = await db.query(
    `SELECT g.id, g.owner_id, g.sharing_mode, g.view_link_token, g.edit_link_token, g.link_version, g.access_version,
            m.role AS member_role, m.source AS member_source, m.link_version AS member_link_version,
            ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM viewer_sessions v WHERE v.id = $3 AND v.gallery_id = g.id
                                         AND v.revoked_at IS NULL AND v.expires_at > now())) AS session_ok
     FROM galleries g
     LEFT JOIN gallery_members m ON m.gallery_id = g.id AND m.user_id = $2
     WHERE g.id = $1 AND g.deleted_at IS NULL`,
    [galleryId, p.userId, p.viewerSessionId ?? null],
  );
  const g = rows[0];
  if (!g) throw new AppError('NOT_FOUND', { what: 'gallery' });
  if (!g.session_ok) return { galleryId, role: null, via: null, sharingMode: g.sharing_mode, accessVersion: g.access_version };

  const candidates: { role: Role; via: GalleryAccess['via'] }[] = [];
  if (p.userId && g.owner_id === p.userId) candidates.push({ role: 'owner', via: 'owner' });
  if (g.member_role) {
    if (g.member_source !== 'link') candidates.push({ role: g.member_role, via: 'member' });
    else if (g.sharing_mode === 'edit_link' && g.member_link_version === g.link_version)
      candidates.push({ role: g.member_role, via: 'link_member' });
  }
  if (p.linkToken) {
    const viewOk = (g.sharing_mode === 'view_link' || g.sharing_mode === 'edit_link') && p.linkToken === g.view_link_token;
    const editOk = g.sharing_mode === 'edit_link' && p.linkToken === g.edit_link_token;
    if (viewOk || editOk) candidates.push({ role: 'viewer', via: 'link' });
  }
  const best = candidates.sort((a, b) => RANK[b.role] - RANK[a.role])[0];
  return {
    galleryId,
    role: best?.role ?? null,
    via: best?.via ?? null,
    sharingMode: g.sharing_mode,
    accessVersion: g.access_version,
  };
}

// Throws unless the principal has `need`. Missing access to a gallery reports 404 so
// gallery IDs cannot be probed; lacking a higher capability reports 403.
export async function requireAccess(db: DbClient, galleryId: string, p: Principal, need: Capability): Promise<GalleryAccess> {
  const access = await resolveAccess(db, galleryId, p);
  const caps = capabilitiesFor(access.role, p.readOnly);
  if (!caps.canView) throw new AppError('NOT_FOUND', { what: 'gallery' });
  if (need === 'edit' && !caps.canEdit) throw new AppError('FORBIDDEN', { need });
  if (need === 'manage' && !caps.canManage) throw new AppError('FORBIDDEN', { need });
  return access;
}
