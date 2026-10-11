// Canonical links handed to the website and encoded in QR codes. Phones open them in
// their normal mobile browser; no app is involved.
//
//   Mobile VR viewer:              {VIEWER_BASE_URL}/view/{galleryId}[?link={viewToken}]
//   Website editor:                {PUBLIC_WEB_URL}/g/{galleryId}
//   Edit invitation link (website): {PUBLIC_WEB_URL}/g/{galleryId}/join?link={editToken}
//   Phone pairing (preview):       {VIEWER_BASE_URL}/p/{pairingCode}
//   Invitation (website):          {PUBLIC_WEB_URL}/invite/{invitationToken}
//
// A link only identifies a gallery (plus an optional share token). Access is always
// decided by the server when the link is resolved, so rotated tokens and restricted
// mode take effect for every QR code ever printed.
import QRCode from 'qrcode';
import type { Config } from '../config.js';

const trim = (u: string) => u.replace(/\/+$/, '');

export function viewerLink(config: Config, galleryId: string, viewToken?: string | null) {
  const base = `${trim(config.viewerBaseUrl)}/view/${galleryId}`;
  return viewToken ? `${base}?link=${encodeURIComponent(viewToken)}` : base;
}

export function editorLink(config: Config, galleryId: string) {
  return `${trim(config.publicWebUrl)}/g/${galleryId}`;
}

export function editJoinLink(config: Config, galleryId: string, editToken: string) {
  return `${trim(config.publicWebUrl)}/g/${galleryId}/join?link=${encodeURIComponent(editToken)}`;
}

export function pairingLink(config: Config, code: string) {
  return `${trim(config.viewerBaseUrl)}/p/${encodeURIComponent(code)}`;
}

export function invitationLink(config: Config, token: string) {
  return `${trim(config.publicWebUrl)}/invite/${encodeURIComponent(token)}`;
}

export type ParsedLink =
  | { kind: 'gallery'; galleryId: string; linkToken: string | null }
  | { kind: 'pairing'; code: string }
  | { kind: 'invitation'; token: string };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

// Parses any of the link shapes above (and older /g/{id} viewer links). The host is not
// trusted or required to match: only the path and query are used, and the result is
// authorized separately.
export function parseLink(raw: string): ParsedLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  let m = new RegExp(`/(?:view|g)/(${UUID})(/join)?$`).exec(path);
  if (m) return { kind: 'gallery', galleryId: m[1].toLowerCase(), linkToken: url.searchParams.get('link') || null };
  m = /\/p\/([A-Za-z0-9_-]{6,64})$/.exec(path);
  if (m) return { kind: 'pairing', code: m[1] };
  m = /\/invite\/([A-Za-z0-9_-]{10,100})$/.exec(path);
  if (m) return { kind: 'invitation', token: m[1] };
  return null;
}

export async function renderQr(text: string, format: 'png' | 'svg', size: number): Promise<Buffer | string> {
  const opts = { errorCorrectionLevel: 'M' as const, margin: 2, width: size };
  return format === 'svg' ? QRCode.toString(text, { ...opts, type: 'svg' }) : QRCode.toBuffer(text, { ...opts, type: 'png' });
}
