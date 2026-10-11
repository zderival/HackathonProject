#!/usr/bin/env node
/* Stand-in for the real backend, for trying the front end without Docker/Postgres/S3.
   It implements the same /v1 contract the front end uses (auth, galleries, scene actions, WebSocket, assets,
   sharing, viewer sessions, QR pairing, assistant) and follows backend/docs/*.md and contracts/openapi.json.
   Everything lives in memory and is gone when you stop it. It is NOT a replacement for the real backend:
   run `node tools/verify-backend.mjs <url>` against the real one to check it speaks the same dialect.

   PORT (default 8080, same as the real backend), PUBLIC_API_URL (default http://localhost:PORT, used for WebSocket ticket URLs just like the real one),
   VIEWER_BASE_URL / PUBLIC_WEB_URL (default http://localhost:5173), MOCK_ACCESS_TTL_SEC (default 900). */
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const rid = () => crypto.randomUUID();
const tok = (p, n = 24) => `${p}_${crypto.randomBytes(n).toString("base64url")}`;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

export function createMock(opt = {}) {
  const PORT = Number(opt.port ?? process.env.PORT ?? 8080);
  const PUBLIC_API = (opt.publicApi || process.env.PUBLIC_API_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
  const WEB = (opt.web || process.env.PUBLIC_WEB_URL || "http://localhost:5173").replace(/\/+$/, "");
  const VIEWER = (opt.viewer || process.env.VIEWER_BASE_URL || WEB).replace(/\/+$/, "");
  const ACCESS_TTL = Number(opt.accessTtl ?? process.env.MOCK_ACCESS_TTL_SEC ?? 900);
  const PAIR_TTL = 600, VIEWER_TTL = 12 * 3600;

  const users = new Map(), byName = new Map(), sessions = new Map(), access = new Map(), refresh = new Map();
  const galleries = new Map(), assets = new Map(), vsessions = new Map(), tickets = new Map(), convs = new Map(), commands = new Map();
  const log = [];

  /* ---------------- errors ---------------- */
  const ERR = {
    AI_UNAVAILABLE: [503, "The assistant is unavailable right now."],
    VALIDATION_FAILED: [400, "The request is not valid."], UNAUTHENTICATED: [401, "Sign in to continue."], INVALID_CREDENTIALS: [401, "Wrong username or password."],
    FORBIDDEN: [403, "You don't have permission to do that."], NOT_FOUND: [404, "Not found."], USERNAME_TAKEN: [409, "That username is taken."],
    REVISION_CONFLICT: [409, "Someone changed this since you loaded it."], NOTHING_TO_UNDO: [409, "Nothing to undo."], NOTHING_TO_REDO: [409, "Nothing to redo."],
    LINK_DISABLED: [410, "This link is no longer active."], UNSUPPORTED_MEDIA_TYPE: [415, "Only JPEG, PNG and WebP images are supported."], PAYLOAD_TOO_LARGE: [413, "That file is too large."],
    SCENE_INVALID: [422, "The scene change is not valid."], RATE_LIMITED: [429, "Slow down."], INTERNAL: [500, "Something went wrong."], INVITATION_INVALID: [410, "That invitation isn't valid."],
  };
  class AppError extends Error { constructor(code, details) { super(code); this.code = code; this.details = details ?? null; } }

  /* ---------------- auth ---------------- */
  const pwHash = (pw, salt = crypto.randomBytes(8).toString("hex")) => `${salt}$${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
  const pwOk = (pw, h) => { const [s] = h.split("$"); return pwHash(pw, s) === h; };
  const userView = u => ({ id: u.id, username: u.username, displayName: u.displayName, preferredLanguage: u.preferredLanguage, createdAt: u.createdAt });
  function issue(user) {
    const sid = rid(), a = tok("at"), r = tok("rt");
    const accessExpiresAt = new Date(Date.now() + ACCESS_TTL * 1000), refreshExpiresAt = new Date(Date.now() + 30 * 86400e3);
    sessions.set(sid, { id: sid, userId: user.id, revoked: false });
    access.set(sha(a), { sid, exp: +accessExpiresAt }); refresh.set(sha(r), { sid, exp: +refreshExpiresAt, used: false });
    return { accessToken: a, refreshToken: r, accessExpiresAt: accessExpiresAt.toISOString(), refreshExpiresAt: refreshExpiresAt.toISOString(), tokenType: "Bearer" };
  }
  function caller(req) {
    const h = req.headers.authorization; if (!h) return { kind: "anonymous" };
    const m = /^Bearer\s+(\S+)$/i.exec(h); if (!m) throw new AppError("UNAUTHENTICATED");
    const t = m[1];
    if (t.startsWith("at_")) { const a = access.get(sha(t)); const s = a && sessions.get(a.sid); if (!a || a.exp < Date.now() || !s || s.revoked) throw new AppError("UNAUTHENTICATED"); return { kind: "user", userId: s.userId, sessionId: s.id }; }
    if (t.startsWith("vs_")) { const v = [...vsessions.values()].find(x => x.tokenHash === sha(t) && !x.revoked && x.exp > Date.now()); if (!v) throw new AppError("UNAUTHENTICATED"); return { kind: "viewer", vs: v }; }
    throw new AppError("UNAUTHENTICATED");
  }
  const needUser = c => { if (c.kind !== "user") throw new AppError("UNAUTHENTICATED"); return c; };

  /* ---------------- access ---------------- */
  const RANK = { viewer: 1, editor: 2, owner: 3 };
  function linkOf(req, url) { return req.headers["x-gallery-link"] || url.searchParams.get("link") || null; }
  function principal(req, url, c, gid) {
    if (c.kind === "viewer") { if (c.vs.galleryId !== gid) throw new AppError("NOT_FOUND", { what: "gallery" }); return { userId: c.vs.userId, linkToken: c.vs.linkToken, readOnly: true, vs: c.vs }; }
    return { userId: c.kind === "user" ? c.userId : null, linkToken: linkOf(req, url) };
  }
  function resolveAccess(g, p) {
    if (!g || g.deleted) throw new AppError("NOT_FOUND", { what: "gallery" });
    if (p.vs && (p.vs.revoked || p.vs.exp < Date.now())) return { role: null };
    const cand = [];
    if (p.userId && g.ownerId === p.userId) cand.push({ role: "owner", via: "owner" });
    const m = p.userId && g.members.get(p.userId);
    if (m) { if (m.source !== "link") cand.push({ role: m.role, via: "member" }); else if (g.sharingMode === "edit_link" && m.linkVersion === g.linkVersion) cand.push({ role: m.role, via: "link_member" }); }
    if (p.linkToken) {
      const viewOk = (g.sharingMode === "view_link" || g.sharingMode === "edit_link") && p.linkToken === g.viewToken;
      const editOk = g.sharingMode === "edit_link" && p.linkToken === g.editToken;
      if (viewOk || editOk) cand.push({ role: "viewer", via: "link" });
    }
    return cand.sort((a, b) => RANK[b.role] - RANK[a.role])[0] || { role: null };
  }
  const caps = (role, ro) => ({ canView: !!role, canEdit: !ro && (role === "owner" || role === "editor"), canManage: !ro && role === "owner", canUseAssistant: !ro && (role === "owner" || role === "editor"), canUpload: !ro && (role === "owner" || role === "editor") });
  function need(g, p, what) {
    const a = resolveAccess(g, p), c = caps(a.role, p.readOnly);
    if (!c.canView) throw new AppError("NOT_FOUND", { what: "gallery" });
    if (what === "edit" && !c.canEdit) throw new AppError("FORBIDDEN", { need: what });
    if (what === "manage" && !c.canManage) throw new AppError("FORBIDDEN", { need: what });
    return a;
  }
  const getG = id => { const g = galleries.get(id); if (!g || g.deleted) throw new AppError("NOT_FOUND", { what: "gallery" }); return g; };

  /* ---------------- scene engine (the subset of ops the front end and assistant use) ---------------- */
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/, HEX = /^#[0-9a-fA-F]{6}$/;
  const emptyScene = () => ({ schemaVersion: 1, environment: { backgroundColor: "#0b0a12", skybox: "gradient", gradientTopColor: "#1c2459", gradientBottomColor: "#1d1024", ambientColor: "#ffffff", ambientIntensity: 0.8, fog: { enabled: false, color: "#4a2a3a", near: 10, far: 80 } }, viewerAnchor: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1], roomId: null }, nodes: {}, ext: {} });
  const DEF = {
    artwork: () => ({ assetId: null, width: 1, height: 1, fit: "contain", title: "", description: "", attribution: "", frame: { style: "none", color: "#222222", width: 0.05, depth: 0.04, matColor: "#ffffff", matWidth: 0 } }),
    text: () => ({ text: "Text", fontSize: 0.2, color: "#ffffff", align: "center", maxWidth: 4, backgroundColor: null, billboard: false }),
    group: () => ({}), light: () => ({ lightType: "point", color: "#ffffff", intensity: 1, range: 0, angle: 0.5, penumbra: 0, castShadow: false }),
    primitive: () => ({ shape: "box", size: [1, 1, 1], material: { color: "#cccccc", roughness: 0.6, metalness: 0, opacity: 1, emissiveColor: "#000000", emissiveIntensity: 0, textureAssetId: null, textureRepeat: [1, 1] } }),
    room: () => ({ width: 10, depth: 8, height: 3.5 }), wall: () => ({ width: 4, height: 3, thickness: 0.1, shell: null, material: {} }), floor: () => ({ width: 10, depth: 8, material: {} }), ceiling: () => ({ width: 10, depth: 8, material: {} }),
  };
  const clone = x => JSON.parse(JSON.stringify(x));
  const sceneErr = (msg, d) => new AppError("SCENE_INVALID", { reason: msg, ...d });
  function chk(cond, msg) { if (!cond) throw sceneErr(msg); }
  function finiteArr(a, n, lim = 500) { return Array.isArray(a) && a.length === n && a.every(v => typeof v === "number" && isFinite(v) && Math.abs(v) <= lim); }
  function checkNode(n) {
    chk(ID_RE.test(n.id), "bad node id"); chk(DEF[n.type], "bad node type");
    chk(finiteArr(n.transform.position, 3), "bad position"); chk(finiteArr(n.transform.rotation, 4, 1), "bad rotation"); chk(finiteArr(n.transform.scale, 3, 100) && n.transform.scale.every(v => v >= 0.001), "bad scale");
    chk(JSON.stringify(n.ext || {}).length <= 4096, "ext is larger than 4096 bytes");
    chk(typeof n.name === "string" && n.name.length <= 120, "bad name");
    if (n.type === "artwork") { const p = n.props; chk(p.width >= 0.01 && p.width <= 20 && p.height >= 0.01 && p.height <= 20, "bad artwork size"); chk(p.assetId === null || typeof p.assetId === "string", "bad assetId"); chk(["none", "thin", "classic", "modern", "ornate"].includes(p.frame.style), "bad frame style"); }
    if (n.type === "text") { chk(typeof n.props.text === "string" && n.props.text.length <= 500, "text longer than 500 characters"); chk(HEX.test(n.props.color), "bad text color"); }
  }
  function setPath(obj, path, value) {
    const parts = path.split("."); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
    const k = parts[parts.length - 1];
    if (value && typeof value === "object" && !Array.isArray(value) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) o[k] = { ...o[k], ...value }; else o[k] = value;
    return clone(getPath(obj, path));
  }
  const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const PATH_RE = /^(name|visible|locked|transform(\.(position|rotation|scale))?|props(\.[A-Za-z][A-Za-z0-9]{0,40}){0,2}|ext(\.[A-Za-z0-9_.-]{1,64})?)$/;
  function descendants(scene, id) { const out = [id]; for (const n of Object.values(scene.nodes)) if (n.parentId === id) out.push(...descendants(scene, n.id)); return out; }
  function mkNode(scene, i) {
    const id = i.id || `n_${crypto.randomBytes(5).toString("hex")}`;
    chk(!scene.nodes[id], `node ${id} already exists`);
    const n = { id, type: i.type, name: i.name ?? "", parentId: i.parentId ?? null, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...(i.transform || {}) }, visible: i.visible ?? true, locked: i.locked ?? false, props: { ...(DEF[i.type]?.() || {}), ...(i.props || {}) }, ext: i.ext || {} };
    if (n.parentId) chk(scene.nodes[n.parentId], "parent not found");
    if (n.type === "artwork") n.props.frame = { ...DEF.artwork().frame, ...(i.props?.frame || {}) };
    checkNode(n); return n;
  }
  function applyOp(scene, op) {
    const ch = [];
    const node = id => { const n = scene.nodes[id]; if (!n) throw sceneErr(`node ${id} not found`); return n; };
    const set = (n, path, value) => { const before = clone(getPath(n, path) ?? null); const after = setPath(n, path, value); checkNode(n); ch.push({ kind: "node.set", nodeId: n.id, path, before, after }); };
    switch (op.op) {
      case "node.add": { const n = mkNode(scene, op.node); scene.nodes[n.id] = n; ch.push({ kind: "node.add", node: clone(n) }); break; }
      case "node.update": { const n = node(op.nodeId); const entries = Object.entries(op.set || {}); chk(entries.length > 0, "nothing to set"); for (const [p, v] of entries) { chk(PATH_RE.test(p), `bad path ${p}`); set(n, p, v); } break; }
      case "node.remove": { node(op.nodeId); for (const id of descendants(scene, op.nodeId).reverse()) { ch.push({ kind: "node.remove", node: clone(scene.nodes[id]) }); delete scene.nodes[id]; } break; }
      case "node.duplicate": { const src = node(op.nodeId), off = op.offset || [0.3, 0, 0]; const c = clone(src); c.id = op.newId || `n_${crypto.randomBytes(5).toString("hex")}`; c.transform.position = c.transform.position.map((v, i) => v + off[i]); chk(!scene.nodes[c.id], "id in use"); scene.nodes[c.id] = c; ch.push({ kind: "node.add", node: clone(c) }); break; }
      case "node.reparent": { const n = node(op.nodeId); if (op.parentId) node(op.parentId); const before = n.parentId; n.parentId = op.parentId; ch.push({ kind: "node.set", nodeId: n.id, path: "parentId", before, after: op.parentId }); break; }
      case "node.setTransform": { const n = node(op.nodeId); for (const k of ["position", "rotation", "scale"]) if (op[k]) set(n, `transform.${k}`, op[k]); break; }
      case "node.setVisibility": set(node(op.nodeId), "visible", op.visible); break;
      case "node.setText": { const n = node(op.nodeId); chk(n.type === "text", "not a text node"); set(n, "props.text", op.text); break; }
      case "node.setMaterial": { const n = node(op.nodeId); set(n, "props.material", op.material); break; }
      case "artwork.place": {
        const a = assets.get(op.assetId); chk(a, "asset not found");
        if (op.nodeId && scene.nodes[op.nodeId]) { const n = node(op.nodeId); set(n, "props.assetId", op.assetId); break; }
        const w = op.width ?? 1, n = mkNode(scene, { id: op.nodeId, type: "artwork", name: op.title ?? a.title, parentId: op.parentId ?? null, transform: { position: op.position || [0, 1.5, -3], rotation: op.rotation || [0, 0, 0, 1] }, props: { assetId: op.assetId, width: w, height: w / (a.aspectRatio || 1), title: op.title ?? a.title } });
        scene.nodes[n.id] = n; ch.push({ kind: "node.add", node: clone(n) }); break;
      }
      case "artwork.hangOnWall": { const n = node(op.nodeId); node(op.wallId); const before = n.parentId; n.parentId = op.wallId; ch.push({ kind: "node.set", nodeId: n.id, path: "parentId", before, after: op.wallId }); set(n, "transform.position", [op.x ?? 0, (op.centerHeight ?? 1.5) - 1.5, 0.06]); break; }
      case "artwork.setFrame": { const n = node(op.nodeId); chk(n.type === "artwork", "not an artwork"); for (const [k, v] of Object.entries(op.frame || {})) set(n, `props.frame.${k}`, v); break; }
      case "room.resize": { const n = node(op.nodeId); for (const k of ["width", "depth", "height"]) if (op[k] != null) set(n, `props.${k}`, op[k]); break; }
      case "scene.setEnvironment": {
        for (const [k, v] of Object.entries(op.environment || {})) {
          if (k === "fog" && v && typeof v === "object") { for (const [fk, fv] of Object.entries(v)) { const before = scene.environment.fog[fk]; scene.environment.fog[fk] = fv; ch.push({ kind: "scene.set", path: `environment.fog.${fk}`, before, after: fv }); } continue; }
          if (/Color$/.test(k)) chk(HEX.test(v), `bad color for ${k}`);
          const before = scene.environment[k]; scene.environment[k] = v; ch.push({ kind: "scene.set", path: `environment.${k}`, before, after: v });
        }
        break;
      }
      case "scene.setViewerAnchor": { const before = clone(scene.viewerAnchor), after = { position: op.position, rotation: op.rotation, roomId: op.roomId ?? null }; scene.viewerAnchor = after; ch.push({ kind: "scene.set", path: "viewerAnchor", before, after: clone(after) }); break; }
      default: throw new AppError("VALIDATION_FAILED", { op: op.op });
    }
    return ch;
  }
  function applyWire(scene, c) {
    if (c.kind === "node.add") scene.nodes[c.node.id] = clone(c.node);
    else if (c.kind === "node.remove") delete scene.nodes[c.nodeId];
    else if (c.kind === "node.set") { const n = scene.nodes[c.nodeId]; if (n) { if (c.path === "parentId") n.parentId = c.value; else { const parts = c.path.split("."); let o = n; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {}; o[parts[parts.length - 1]] = clone(c.value); } } }
    else if (c.kind === "scene.set") { const parts = c.path.split("."); let o = scene; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {}; o[parts[parts.length - 1]] = clone(c.value); }
  }
  const wire = ch => ch.map(c => c.kind === "node.add" ? { kind: c.kind, node: c.node } : c.kind === "node.remove" ? { kind: c.kind, nodeId: c.node.id } : c.kind === "node.set" ? { kind: c.kind, nodeId: c.nodeId, path: c.path, value: c.after } : { kind: c.kind, path: c.path, value: c.after });
  const inverse = ch => [...ch].reverse().map(c => c.kind === "node.add" ? { kind: "node.remove", node: c.node } : c.kind === "node.remove" ? { kind: "node.add", node: c.node } : { ...c, before: c.after, after: c.before });
  const touched = ch => new Set(ch.map(c => c.kind === "node.add" ? `n:${c.node.id}` : c.kind === "node.remove" ? `n:${c.node.id}` : c.kind === "node.set" ? `n:${c.nodeId}:${c.path}` : `s:${c.path}`));
  const overlaps = (a, b) => { for (const x of a) for (const y of b) { if (x === y) return true; const xs = x.split(":"), ys = y.split(":"); if (xs[0] === "n" && ys[0] === "n" && xs[1] === ys[1] && (xs.length === 2 || ys.length === 2 || xs[2].startsWith(ys[2]) || ys[2].startsWith(xs[2]))) return true; } return false; };

  function commit(g, p, body, source = "manual", extra = {}) {
    if (!body || typeof body.requestId !== "string" || body.requestId.length < 8 || body.requestId.length > 100) throw new AppError("VALIDATION_FAILED", { field: "requestId" });
    if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) throw new AppError("VALIDATION_FAILED", { field: "baseRevision" });
    if (!Array.isArray(body.ops) || !body.ops.length || body.ops.length > 200) throw new AppError("VALIDATION_FAILED", { field: "ops" });
    const prev = g.requests.get(body.requestId);
    if (prev) return { ...prev, duplicate: true };
    if (body.baseRevision > g.revision) throw new AppError("VALIDATION_FAILED", { field: "baseRevision", reason: "from the future" });
    const merge = body.conflictMode === "merge";
    if (body.baseRevision !== g.revision) {
      if (!merge) throw new AppError("REVISION_CONFLICT", { currentRevision: g.revision, baseRevision: body.baseRevision });
    }
    const draft = clone(g.scene), all = [];
    for (const op of body.ops) all.push(...applyOp(draft, op));
    if (body.baseRevision !== g.revision && merge) {
      const mine = touched(all);
      for (const e of g.events) if (e.revision > body.baseRevision && overlaps(mine, touched(e.rawChanges))) throw new AppError("REVISION_CONFLICT", { currentRevision: g.revision, baseRevision: body.baseRevision, conflictWith: e.revision });
    }
    const base = { galleryId: g.id, actionId: body.actionId || rid(), requestId: body.requestId, baseRevision: body.baseRevision };
    if (!all.length) { const r = { ...base, revision: g.revision, duplicate: false, noop: true, changes: [] }; return r; }
    g.scene = draft; g.revision++; g.updatedAt = now();
    const ev = { type: "ops", eventId: `${g.id}:${g.revision}`, galleryId: g.id, revision: g.revision, baseRevision: body.baseRevision, actionId: base.actionId, requestId: body.requestId, source, actor: p.userId ? { userId: p.userId, displayName: users.get(p.userId)?.displayName || "" } : null, label: body.label ?? null, undoOf: extra.undoOf ?? null, redoOf: extra.redoOf ?? null, ts: now(), changes: wire(all), rawChanges: all };
    g.events.push(ev); if (g.events.length > 500) g.events.shift();
    if (source !== "undo" && source !== "redo") { g.undo.push({ userId: p.userId, revision: g.revision, actionId: base.actionId, changes: all }); g.redo = g.redo.filter(r => r.userId !== p.userId); }
    const result = { ...base, revision: g.revision, duplicate: false, noop: false, changes: ev.changes };
    g.requests.set(body.requestId, { ...result, duplicate: false });
    broadcast(g, ev);
    return result;
  }
  function doUndo(g, p, body, redo) {
    if (!body || typeof body.requestId !== "string" || body.requestId.length < 8) throw new AppError("VALIDATION_FAILED", { field: "requestId" });
    const dup = g.requests.get(body.requestId); if (dup) return { ...dup, duplicate: true };
    const stack = redo ? g.redo : g.undo; const idx = [...stack].reverse().findIndex(e => e.userId === p.userId);
    if (idx < 0) throw new AppError(redo ? "NOTHING_TO_REDO" : "NOTHING_TO_UNDO");
    const entry = stack.splice(stack.length - 1 - idx, 1)[0], inv = inverse(entry.changes);
    const draft = clone(g.scene);
    for (const c of inv) { if (c.kind === "node.set") { const cur = getPath(draft.nodes[c.nodeId] || {}, c.path); if (draft.nodes[c.nodeId] && JSON.stringify(cur) !== JSON.stringify(c.before)) throw new AppError("UNDO_CONFLICT"); } applyWire(draft, c.kind === "node.add" ? { kind: "node.add", node: c.node } : c.kind === "node.remove" ? { kind: "node.remove", nodeId: c.node.id } : c.kind === "node.set" ? { kind: "node.set", nodeId: c.nodeId, path: c.path, value: c.after } : { kind: "scene.set", path: c.path, value: c.after }); }
    g.scene = draft; g.revision++; g.updatedAt = now();
    const ev = { type: "ops", eventId: `${g.id}:${g.revision}`, galleryId: g.id, revision: g.revision, baseRevision: g.revision - 1, actionId: rid(), requestId: body.requestId, source: redo ? "redo" : "undo", actor: p.userId ? { userId: p.userId, displayName: users.get(p.userId)?.displayName || "" } : null, label: null, undoOf: redo ? null : entry.revision, redoOf: redo ? entry.revision : null, ts: now(), changes: wire(inv), rawChanges: inv };
    g.events.push(ev); (redo ? g.undo : g.redo).push({ userId: p.userId, revision: g.revision, actionId: ev.actionId, changes: inv });
    const result = { galleryId: g.id, actionId: ev.actionId, requestId: body.requestId, revision: g.revision, baseRevision: ev.baseRevision, duplicate: false, noop: false, changes: ev.changes };
    g.requests.set(body.requestId, result); broadcast(g, ev); return result;
  }

  /* ---------------- gallery model ---------------- */
  function sharingInfo(g) {
    return { galleryId: g.id, sharingMode: g.sharingMode, linkVersion: g.linkVersion, galleryUrl: `${VIEWER}/view/${g.id}`, viewUrl: g.sharingMode === "restricted" ? null : `${VIEWER}/view/${g.id}?link=${encodeURIComponent(g.viewToken)}`, editorUrl: `${WEB}/g/${g.id}`, editJoinUrl: g.sharingMode === "edit_link" ? `${WEB}/g/${g.id}/join?link=${encodeURIComponent(g.editToken)}` : null };
  }
  function summary(g, role, ro = false) {
    return { id: g.id, title: g.title, description: g.description, ownerId: g.ownerId, role, capabilities: caps(role, ro), sharingMode: g.sharingMode, revision: g.revision, schemaVersion: 1, createdAt: g.createdAt, updatedAt: g.updatedAt };
  }
  function starterScene(title) {
    const s = emptyScene();
    s.nodes.room1 = mkNode(s, { id: "room1", type: "room", name: "Room" });
    s.nodes.label1 = mkNode(s, { id: "label1", type: "text", name: "Welcome", parentId: "room1", transform: { position: [0, 2.2, -3.8] }, props: { text: title } });
    return s;
  }

  /* ---------------- websocket hub ---------------- */
  const conns = new Set();
  function wsSend(c, m) { try { if (!c.socket.destroyed) c.socket.write(frame(JSON.stringify(m))); } catch {} }
  function frame(str, op = 0x1) {
    const p = Buffer.from(str), n = p.length; let h;
    if (n < 126) h = Buffer.from([0x80 | op, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    return Buffer.concat([h, p]);
  }
  function wsClose(c, code, reason = "") { try { const b = Buffer.alloc(2 + Buffer.byteLength(reason)); b.writeUInt16BE(code, 0); b.write(reason, 2); c.socket.write(Buffer.concat([Buffer.from([0x88, b.length]), b])); c.socket.end(); } catch {} conns.delete(c); }
  function broadcast(g, ev) {
    const { rawChanges, ...pub } = ev;
    for (const c of conns) if (c.galleryId === g.id && c.live) { wsSend(c, pub); c.lastRevision = ev.revision; }
  }
  function recheckAll(g) {
    for (const c of [...conns]) if (c.galleryId === g.id) {
      const a = resolveAccess(g, c.principal), cp = caps(a.role, c.principal.readOnly);
      if (!a.role || (c.capability === "edit" && !cp.canEdit)) { wsSend(c, { type: "error", code: "FORBIDDEN", message: ERR.FORBIDDEN[1], fatal: true }); wsClose(c, 4403, "access revoked"); }
    }
  }
  function handleUpgrade(req, socket) {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/v1/ws" || !/websocket/i.test(req.headers.upgrade || "")) return socket.destroy();
    const key = req.headers["sec-websocket-key"];
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")}\r\n\r\n`);
    const c = { socket, galleryId: null, live: false, lastRevision: 0, buf: Buffer.alloc(0), principal: null, capability: "view" };
    const t = tickets.get(sha(url.searchParams.get("ticket") || ""));
    socket.on("error", () => conns.delete(c)); socket.on("close", () => conns.delete(c));
    const g = t && galleries.get(t.galleryId);
    if (!t || t.used || t.exp < Date.now() || !g || g.deleted) { wsSend(c, { type: "error", code: "TICKET_INVALID", message: "That ticket isn't valid.", fatal: true }); return wsClose(c, 4001, "ticket invalid"); }
    t.used = true;
    c.principal = { userId: t.userId, linkToken: t.linkToken, readOnly: t.capability === "view", vs: t.vs || null }; c.capability = t.capability; c.galleryId = g.id;
    const a = resolveAccess(g, c.principal), cp = caps(a.role, c.principal.readOnly);
    if (!a.role || (t.capability === "edit" && !cp.canEdit)) { wsSend(c, { type: "error", code: "FORBIDDEN", message: ERR.FORBIDDEN[1], fatal: true }); return wsClose(c, 4403, "denied"); }
    c.role = a.role; conns.add(c);
    wsSend(c, { type: "hello", connectionId: rid(), galleryId: g.id, role: a.role, capability: t.capability, ...cp, canEdit: t.capability === "edit", heartbeatMs: 25000, serverTime: now(), protocolVersion: 1 });
    wsSend(c, { type: "snapshot", galleryId: g.id, revision: g.revision, reason: "initial", scene: g.scene }); c.lastRevision = g.revision; c.live = true;
    socket.on("data", d => {
      c.buf = Buffer.concat([c.buf, d]);
      for (;;) {
        const b = c.buf; if (b.length < 2) return;
        const op = b[0] & 0x0f, masked = !!(b[1] & 0x80); let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
        const total = off + (masked ? 4 : 0) + len; if (b.length < total) return;
        let payload = b.subarray(off + (masked ? 4 : 0), total);
        if (masked) { const m = b.subarray(off, off + 4); payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4])); }
        c.buf = b.subarray(total);
        if (op === 0x8) return wsClose(c, 1000);
        if (op === 0x9) { socket.write(frame(payload.toString(), 0xa)); continue; }
        if (op !== 0x1) continue;
        let m; try { m = JSON.parse(payload.toString()); } catch { wsSend(c, { type: "error", code: "VALIDATION_FAILED", message: "messages must be JSON text" }); continue; }
        onWs(c, g, m);
      }
    });
  }
  function onWs(c, g, m) {
    if (m.type === "ping") return wsSend(c, { type: "pong", t: m.t, serverTime: now(), revision: g.revision });
    if (m.type === "resync") {
      if (m.fromRevision !== undefined) { for (const e of g.events) if (e.revision > m.fromRevision) { const { rawChanges, ...p } = e; wsSend(c, p); } c.lastRevision = g.revision; }
      else wsSend(c, { type: "snapshot", galleryId: g.id, revision: g.revision, reason: "requested", scene: g.scene });
      return;
    }
    if (m.type === "submit") {
      if (c.capability !== "edit") return wsSend(c, { type: "error", code: "FORBIDDEN", clientMsgId: m.clientMsgId, message: ERR.FORBIDDEN[1] });
      try { const r = commit(g, c.principal, m.action); wsSend(c, { type: "ack", clientMsgId: m.clientMsgId, requestId: r.requestId, actionId: r.actionId, revision: r.revision, duplicate: r.duplicate, noop: r.noop }); }
      catch (e) { const code = e.code || "INTERNAL"; wsSend(c, { type: "error", clientMsgId: m.clientMsgId, requestId: m.action?.requestId, code, message: ERR[code]?.[1] || code, details: e.details }); }
      return;
    }
    wsSend(c, { type: "error", code: "VALIDATION_FAILED", message: "invalid message" });
  }

  /* ---------------- assets ---------------- */
  function sniff(buf) {
    if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { format: "png", mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) { let i = 2; while (i + 9 < buf.length) { if (buf[i] !== 0xff) { i++; continue; } const m = buf[i + 1]; if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { format: "jpeg", mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }; i += 2 + buf.readUInt16BE(i + 2); } return { format: "jpeg", mime: "image/jpeg", width: 1000, height: 1000 }; }
    if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const t = buf.toString("ascii", 12, 16);
      if (t === "VP8X") return { format: "webp", mime: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (t === "VP8L") { const b = buf.readUInt32LE(21); return { format: "webp", mime: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
      return { format: "webp", mime: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }
  function parseMultipart(req, body) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers["content-type"] || ""); if (!m) throw new AppError("UNSUPPORTED_MEDIA_TYPE");
    const bnd = Buffer.from("--" + (m[1] || m[2])), fields = {}, files = {}; let pos = body.indexOf(bnd);
    while (pos >= 0) {
      const next = body.indexOf(bnd, pos + bnd.length); if (next < 0) break;
      const part = body.subarray(pos + bnd.length + 2, next - 2), he = part.indexOf("\r\n\r\n"); if (he < 0) break;
      const head = part.subarray(0, he).toString(), data = part.subarray(he + 4), name = /name="([^"]*)"/.exec(head)?.[1], fn = /filename="([^"]*)"/.exec(head)?.[1];
      if (fn !== undefined) files[name] = { filename: fn, data }; else fields[name] = data.toString();
      pos = next;
    }
    return { fields, files };
  }
  function assetPub(a) { const { variants, data, ...rest } = a; return rest; }
  function manifest(a) {
    const exp = new Date(Date.now() + 600e3).toISOString();
    return { ...assetPub(a), urlsExpireAt: exp, variants: a.variants.map(v => ({ name: v.name, format: v.format, mimeType: v.mimeType, width: v.width, height: v.height, bytes: v.bytes, url: `${PUBLIC_API_URL_FOR_ASSETS()}/v1/assets/${a.id}/variants/${v.name}.${v.format}?sig=${tok("sg", 8)}`, proxyPath: `/v1/assets/${a.id}/variants/${v.name}.${v.format}` })) };
  }
  const PUBLIC_API_URL_FOR_ASSETS = () => PUBLIC_API;

  /* ---------------- assistant (rule-based stand-in for Gemini) ---------------- */
  const LANG = ["en", "ht", "fr", "es", "ko"];
  function assistantRun(cmd, g, p) {
    const text = (cmd.text || "").toLowerCase(); const scene = g.scene; const arts = Object.values(scene.nodes).filter(n => n.type === "artwork");
    const say = (status, reply, extra = {}) => Object.assign(cmd, { status, reply, final: true, completedAt: now(), ...extra });
    const target = () => { const sel = cmd.selectedNodeIds?.[0] && scene.nodes[cmd.selectedNodeIds[0]]; if (sel) return sel; return arts.find(n => n.name && text.includes(n.name.toLowerCase())) || (arts.length === 1 ? arts[0] : null); };
    const act = (ops, label) => { const r = commit(g, p, { requestId: `${cmd.requestId}-a`, baseRevision: g.revision, conflictMode: "merge", label, ops }, "ai"); return r; };
    let m;
    if (/^\s*(hi|hello|help)\b/.test(text) || text.includes("what can you do")) return say("answered", "I can move, resize and reframe your pictures, change the background colours, and add a text label. Try “make the picture bigger” or “add text Welcome”.", { intent: "help", suggestions: ["Move the picture to the left", "Make the background darker"] });
    if ((m = /add (?:a )?(?:text|label)\s+["“']?(.+?)["”']?$/.exec(cmd.text || ""))) { const r = act([{ op: "node.add", node: { type: "text", name: "Label", transform: { position: [0, 2.4, -3] }, props: { text: m[1].slice(0, 500) } } }], "Add text"); return say("applied", `Added the text “${m[1]}”.`, { intent: "node.add", actionId: r.actionId, revision: r.revision }); }
    if (/background|sky/.test(text)) {
      const hex = /#[0-9a-f]{6}/i.exec(text)?.[0];
      const env = hex ? { gradientTopColor: hex.toLowerCase() } : /dark|calm|night/.test(text) ? { gradientTopColor: "#0a0d1f", gradientBottomColor: "#050408" } : /bright|light|warm/.test(text) ? { gradientTopColor: "#f6b27a", gradientBottomColor: "#6a3b52" } : null;
      if (!env) return say("needs_clarification", "What should the background feel like?", { question: "Darker, brighter, or a specific colour like #3355ff?" });
      const r = act([{ op: "scene.setEnvironment", environment: env }], "Background"); return say("applied", "I changed the background.", { intent: "scene.setEnvironment", actionId: r.actionId, revision: r.revision });
    }
    const t = target();
    if (/\b(bigger|larger|smaller|shrink|enlarge)\b/.test(text)) {
      if (!t) return say("needs_clarification", "Which picture?", { question: "Select a picture, or say its name." });
      const k = /bigger|larger|enlarge/.test(text) ? 1.25 : 0.8, p0 = t.props;
      const r = act([{ op: "node.update", nodeId: t.id, set: { "props.width": +(p0.width * k).toFixed(3), "props.height": +(p0.height * k).toFixed(3) } }], "Resize"); return say("applied", `Made “${t.name || t.id}” ${k > 1 ? "bigger" : "smaller"}.`, { intent: "node.update", actionId: r.actionId, revision: r.revision });
    }
    if ((m = /\b(left|right|up|down)\b/.exec(text)) && /move|shift|nudge|slide/.test(text)) {
      if (!t) return say("needs_clarification", "Which picture?", { question: "Select a picture, or say its name." });
      const d = { left: [-0.5, 0, 0], right: [0.5, 0, 0], up: [0, 0.3, 0], down: [0, -0.3, 0] }[m[1]], pos = t.transform.position.map((v, i) => +(v + d[i]).toFixed(3));
      const r = act([{ op: "node.setTransform", nodeId: t.id, position: pos }], "Move"); return say("applied", `Moved “${t.name || t.id}” ${m[1]}.`, { intent: "node.setTransform", actionId: r.actionId, revision: r.revision });
    }
    if (/frame/.test(text) && t) { const style = /ornate/.test(text) ? "ornate" : /modern/.test(text) ? "modern" : /none|remove/.test(text) ? "none" : "classic"; const r = act([{ op: "artwork.setFrame", nodeId: t.id, frame: { style } }], "Frame"); return say("applied", `Set the frame to ${style}.`, { intent: "artwork.setFrame", actionId: r.actionId, revision: r.revision }); }
    return say("answered", "I'm a small stand-in for the real assistant. Try moving, resizing, framing, or changing the background.", { intent: "chat" });
  }
  function cmdView(c) { const { selectedNodeIds, ...rest } = c; return rest; }

  /* ---------------- HTTP ---------------- */
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:[A-Za-z]+/g, "([^/]+)") + "$"), fn });
  const ok = (res, code, body) => { if (body === undefined || body === null) { res.writeHead(code, { "content-type": "application/json" }); return res.end(code === 204 ? undefined : "null"); } res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const reqId = () => rid();

  route("POST", "/v1/auth/register", (q) => {
    const b = q.body || {};
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(b.username || "") || typeof b.password !== "string" || b.password.length < 8 || b.password.length > 200) throw new AppError("VALIDATION_FAILED", { field: !/^[A-Za-z0-9_.-]{3,30}$/.test(b.username || "") ? "username" : "password" });
    if (byName.has(b.username.toLowerCase())) throw new AppError("USERNAME_TAKEN");
    const u = { id: rid(), username: b.username, displayName: b.displayName || b.username, preferredLanguage: b.preferredLanguage || "en", pw: pwHash(b.password), createdAt: now() };
    users.set(u.id, u); byName.set(u.username.toLowerCase(), u.id);
    return [201, { user: userView(u), tokens: issue(u) }];
  });
  route("POST", "/v1/auth/login", q => {
    const b = q.body || {}; const u = users.get(byName.get(String(b.username || "").trim().toLowerCase()));
    if (!u || !pwOk(String(b.password || ""), u.pw)) throw new AppError("INVALID_CREDENTIALS");
    return [200, { user: userView(u), tokens: issue(u) }];
  });
  route("POST", "/v1/auth/refresh", q => {
    const r = refresh.get(sha(String(q.body?.refreshToken || ""))); if (!r || r.used || r.exp < Date.now()) throw new AppError("UNAUTHENTICATED");
    const s = sessions.get(r.sid); if (!s || s.revoked) throw new AppError("UNAUTHENTICATED");
    r.used = true; sessions.get(r.sid).revoked = true; return [200, { tokens: issue(users.get(s.userId)) }];
  });
  route("POST", "/v1/auth/logout", q => { const c = needUser(q.caller); if (q.body?.allSessions) { for (const s of sessions.values()) if (s.userId === c.userId) s.revoked = true; } else sessions.get(c.sessionId).revoked = true; return [204]; });
  route("GET", "/v1/auth/me", q => [200, userView(users.get(needUser(q.caller).userId))]);
  route("PATCH", "/v1/auth/me", q => { const u = users.get(needUser(q.caller).userId); if (q.body?.displayName) u.displayName = q.body.displayName; if (q.body?.preferredLanguage) u.preferredLanguage = q.body.preferredLanguage; return [200, userView(u)]; });

  route("POST", "/v1/galleries", q => {
    const { userId } = needUser(q.caller), b = q.body || {};
    if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 120) throw new AppError("VALIDATION_FAILED", { field: "title" });
    const g = { id: rid(), ownerId: userId, title: b.title, description: b.description || "", scene: b.template === "blank" ? emptyScene() : starterScene(b.title), revision: 0, sharingMode: "restricted", linkVersion: 1, viewToken: tok("gv", 18), editToken: tok("ge", 18), members: new Map(), events: [], undo: [], redo: [], requests: new Map(), createdAt: now(), updatedAt: now() };
    galleries.set(g.id, g); return [201, summary(g, "owner")];
  });
  route("GET", "/v1/galleries", q => {
    const { userId } = needUser(q.caller);
    const items = [...galleries.values()].filter(g => !g.deleted && (g.ownerId === userId || (g.members.get(userId) && (g.members.get(userId).source !== "link" || (g.sharingMode === "edit_link" && g.members.get(userId).linkVersion === g.linkVersion))))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(g => summary(g, g.ownerId === userId ? "owner" : g.members.get(userId).role));
    return [200, { items, nextCursor: null }];
  });
  route("GET", "/v1/galleries/:id", q => { const g = getG(q.p[0]), p = principal(q.req, q.url, q.caller, g.id), a = need(g, p, "view"); return [200, summary(g, a.role, p.readOnly)]; });
  route("PATCH", "/v1/galleries/:id", q => { const g = getG(q.p[0]), p = principal(q.req, q.url, needUser(q.caller) && q.caller, g.id), a = need(g, p, "edit"); if (q.body?.title) g.title = q.body.title; if (q.body?.description != null) g.description = q.body.description; g.updatedAt = now(); return [200, summary(g, a.role)]; });
  route("DELETE", "/v1/galleries/:id", q => { const g = getG(q.p[0]); needUser(q.caller); need(g, principal(q.req, q.url, q.caller, g.id), "manage"); g.deleted = true; recheckAll(g); return [204]; });
  route("GET", "/v1/galleries/:id/scene", q => { const g = getG(q.p[0]); need(g, principal(q.req, q.url, q.caller, g.id), "view"); return [200, { galleryId: g.id, revision: g.revision, schemaVersion: 1, scene: g.scene }]; });
  route("GET", "/v1/galleries/:id/capabilities", q => { const g = getG(q.p[0]), p = principal(q.req, q.url, q.caller, g.id), a = need(g, p, "view"); const c = caps(a.role, !!p.readOnly); return [200, { galleryId: g.id, role: a.role, ...c, canUseAssistant: c.canUseAssistant && process.env.MOCK_ASSISTANT !== "off" }]; });
  route("GET", "/v1/galleries/:id/access", q => { const g = getG(q.p[0]), p = principal(q.req, q.url, q.caller, g.id), a = resolveAccess(g, p); return [200, { galleryId: g.id, role: a.role, via: a.via || null, sharingMode: g.sharingMode, capabilities: caps(a.role, p.readOnly) }]; });

  route("POST", "/v1/galleries/:id/actions", q => { const { userId } = needUser(q.caller), g = getG(q.p[0]), p = { ...principal(q.req, q.url, q.caller, g.id), userId }; need(g, p, "edit"); return [200, commit(g, p, q.body)]; });
  route("POST", "/v1/galleries/:id/undo", q => { const { userId } = needUser(q.caller), g = getG(q.p[0]), p = { ...principal(q.req, q.url, q.caller, g.id), userId }; need(g, p, "edit"); return [200, doUndo(g, p, q.body, false)]; });
  route("POST", "/v1/galleries/:id/redo", q => { const { userId } = needUser(q.caller), g = getG(q.p[0]), p = { ...principal(q.req, q.url, q.caller, g.id), userId }; need(g, p, "edit"); return [200, doUndo(g, p, q.body, true)]; });
  route("GET", "/v1/galleries/:id/actions", q => { const g = getG(q.p[0]); need(g, principal(q.req, q.url, q.caller, g.id), "view"); return [200, { items: g.events.map(({ rawChanges, ...e }) => e).reverse().slice(0, 30) }]; });
  route("GET", "/v1/galleries/:id/events", q => {
    const g = getG(q.p[0]); need(g, principal(q.req, q.url, q.caller, g.id), "view");
    const after = Number(q.url.searchParams.get("after")); if (!Number.isInteger(after) || after < 0) throw new AppError("VALIDATION_FAILED", { field: "after" });
    const evs = g.events.filter(e => e.revision > after), complete = after >= g.revision - g.events.length;
    return [200, { currentRevision: g.revision, complete, events: evs.map(({ rawChanges, ...e }) => e) }];
  });

  route("POST", "/v1/galleries/:id/realtime-tickets", q => {
    const g = getG(q.p[0]), p = principal(q.req, q.url, q.caller, g.id), capability = q.body?.capability;
    if (capability !== "edit" && capability !== "view") throw new AppError("VALIDATION_FAILED", { field: "capability" });
    if (capability === "edit") needUser(q.caller); need(g, p, capability === "edit" ? "edit" : "view");
    const ticket = tok("wst"); const exp = Date.now() + 60e3;
    tickets.set(sha(ticket), { galleryId: g.id, userId: p.userId, linkToken: p.linkToken ?? null, capability, exp, used: false, vs: p.vs || null });
    return [201, { ticket, url: `${PUBLIC_API.replace(/^http/, "ws")}/v1/ws?ticket=${encodeURIComponent(ticket)}`, capability, expiresAt: new Date(exp).toISOString() }];
  });
  route("POST", "/v1/galleries/:id/viewer-sessions", q => {
    const g = getG(q.p[0]), p = principal(q.req, q.url, q.caller, g.id); need(g, p, "view");
    const kind = q.body?.kind ?? "viewer"; if (kind === "preview" && q.caller.kind !== "user") throw new AppError("UNAUTHENTICATED");
    const token = tok("vs"), code = kind === "preview" ? crypto.randomBytes(9).toString("base64url") : null;
    const v = { id: rid(), tokenHash: sha(token), galleryId: g.id, userId: p.userId, linkToken: p.linkToken ?? null, kind, createdBy: q.caller.kind === "user" ? q.caller.userId : null, exp: Date.now() + VIEWER_TTL * 1000, revoked: false, pairHash: code && sha(code), pairExp: Date.now() + PAIR_TTL * 1000, claimed: false };
    vsessions.set(v.id, v);
    const base = { viewerSessionId: v.id, galleryId: g.id, kind, expiresAt: new Date(v.exp).toISOString() };
    if (!code) return [201, { ...base, viewerToken: token }];
    const qr = `/v1/pairings/qr?code=${encodeURIComponent(code)}`;
    return [201, { ...base, viewerToken: null, pairingCode: code, pairingUrl: `${VIEWER}/p/${code}`, pairingExpiresAt: new Date(v.pairExp).toISOString(), qrPngPath: `${qr}&format=png`, qrSvgPath: `${qr}&format=svg` }];
  });
  route("GET", "/v1/galleries/:id/viewer-sessions", q => { const g = getG(q.p[0]); needUser(q.caller); need(g, principal(q.req, q.url, q.caller, g.id), "view"); return [200, { items: [...vsessions.values()].filter(v => v.galleryId === g.id && !v.revoked).map(v => ({ id: v.id, kind: v.kind, expiresAt: new Date(v.exp).toISOString(), claimed: v.claimed })) }]; });
  route("DELETE", "/v1/viewer-sessions/:sid", q => { const v = vsessions.get(q.p[0]); if (!v) throw new AppError("NOT_FOUND"); v.revoked = true; recheckAll(galleries.get(v.galleryId)); return [204]; });
  route("POST", "/v1/pairings/claim", q => {
    const code = String(q.body?.code || ""), v = [...vsessions.values()].find(x => x.pairHash === sha(code));
    if (!v || v.claimed || v.pairExp < Date.now() || v.revoked) throw new AppError("LINK_DISABLED", { reason: "pairing code expired or already used" });
    const token = tok("vs"); v.claimed = true; v.tokenHash = sha(token); return [200, { viewerToken: token, viewerSessionId: v.id, galleryId: v.galleryId, expiresAt: new Date(v.exp).toISOString() }];
  });
  route("GET", "/v1/pairings/qr", q => [200, { note: "QR rendering is done by the real backend; the front end draws its own QR code." }]);

  route("GET", "/v1/galleries/:id/sharing", q => { const g = getG(q.p[0]); need(g, principal(q.req, q.url, q.caller, g.id), "manage"); return [200, sharingInfo(g)]; });
  route("PUT", "/v1/galleries/:id/sharing", q => { const g = getG(q.p[0]); needUser(q.caller); need(g, principal(q.req, q.url, q.caller, g.id), "manage"); const m = q.body?.mode; if (!["restricted", "view_link", "edit_link"].includes(m)) throw new AppError("VALIDATION_FAILED", { field: "mode" }); g.sharingMode = m; recheckAll(g); return [200, sharingInfo(g)]; });
  route("POST", "/v1/galleries/:id/sharing/rotate", q => { const g = getG(q.p[0]); needUser(q.caller); need(g, principal(q.req, q.url, q.caller, g.id), "manage"); const l = q.body?.links; if (!["view", "edit", "both"].includes(l)) throw new AppError("VALIDATION_FAILED", { field: "links" }); if (l !== "edit") g.viewToken = tok("gv", 18); if (l !== "view") { g.editToken = tok("ge", 18); g.linkVersion++; } recheckAll(g); return [200, sharingInfo(g)]; });
  route("GET", "/v1/galleries/:id/members", q => { const g = getG(q.p[0]); needUser(q.caller); need(g, principal(q.req, q.url, q.caller, g.id), "manage"); const o = users.get(g.ownerId); return [200, { items: [{ userId: o.id, username: o.username, displayName: o.displayName, role: "owner", source: "owner", active: true, createdAt: g.createdAt }, ...[...g.members].map(([id, m]) => { const u = users.get(id); return { userId: id, username: u.username, displayName: u.displayName, role: m.role, source: m.source, active: true, createdAt: m.createdAt }; })] }]; });
  route("POST", "/v1/galleries/:id/members", q => { const g = getG(q.p[0]); needUser(q.caller); need(g, principal(q.req, q.url, q.caller, g.id), "manage"); const u = users.get(byName.get(String(q.body?.username || "").toLowerCase())); if (!u) throw new AppError("NOT_FOUND", { what: "user" }); g.members.set(u.id, { role: q.body.role, source: "direct", createdAt: now() }); recheckAll(g); return [200, { userId: u.id, username: u.username, displayName: u.displayName, role: q.body.role, source: "direct", active: true, createdAt: now() }]; });
  route("POST", "/v1/galleries/:id/join", q => { const g = getG(q.p[0]), { userId } = needUser(q.caller); if (g.sharingMode !== "edit_link" || g.editToken !== q.body?.link) throw new AppError("LINK_DISABLED"); if (g.ownerId !== userId && (!g.members.get(userId) || g.members.get(userId).source === "link")) g.members.set(userId, { role: "editor", source: "link", linkVersion: g.linkVersion, createdAt: now() }); const a = resolveAccess(g, { userId }); return [200, { galleryId: g.id, role: a.role, via: a.via }]; });

  route("GET", "/v1/links/resolve", q => {
    let u; try { u = new URL(q.url.searchParams.get("url") || ""); } catch { throw new AppError("VALIDATION_FAILED", { field: "url" }); }
    const path = u.pathname.replace(/\/+$/, ""); let m;
    if ((m = /\/(?:view|g)\/([0-9a-f-]{36})(\/join)?$/i.exec(path))) {
      const g = galleries.get(m[1].toLowerCase()); const link = u.searchParams.get("link") || null;
      if (!g || g.deleted) throw new AppError("NOT_FOUND", { what: "gallery" });
      const p = { userId: q.caller.kind === "user" ? q.caller.userId : q.caller.kind === "viewer" ? q.caller.vs.userId : null, linkToken: link }, a = resolveAccess(g, p);
      if (link && !a.role && (!p.userId || !resolveAccess(g, { userId: p.userId }).role)) throw new AppError("LINK_DISABLED");
      if (!a.role) return [200, { kind: "gallery", next: "sign_in", galleryId: g.id, linkToken: null, gallery: null, access: null }];
      return [200, { kind: "gallery", next: m[2] ? "join_as_editor" : "open", galleryId: g.id, linkToken: a.via === "link" ? link : null, gallery: { title: g.title, sharingMode: g.sharingMode }, access: { role: a.role, via: a.via, canEdit: caps(a.role).canEdit } }];
    }
    if ((m = /\/p\/([A-Za-z0-9_-]{6,64})$/.exec(path))) return [200, { kind: "pairing", next: "claim_pairing", galleryId: null, linkToken: null, gallery: null, access: null }];
    if (/\/invite\//.test(path)) return [200, { kind: "invitation", next: "accept_invitation", galleryId: null, linkToken: null, gallery: null, access: null }];
    throw new AppError("VALIDATION_FAILED", { field: "url", reason: "unrecognized link" });
  });

  /* assets */
  route("GET", "/v1/galleries/:id/assets", q => { const g = getG(q.p[0]); need(g, principal(q.req, q.url, q.caller, g.id), "view"); return [200, { items: [...assets.values()].filter(a => a.galleryId === g.id).map(assetPub), nextBefore: null }]; });
  route("POST", "/v1/assets/manifests", q => {
    const ids = q.body?.assetIds; if (!Array.isArray(ids) || ids.length > 100) throw new AppError("VALIDATION_FAILED", { field: "assetIds" });
    const items = [], missing = [];
    for (const id of ids) { const a = assets.get(id); let okAcc = false; if (a) { const g = galleries.get(a.galleryId); try { need(g, principal(q.req, q.url, q.caller, g.id), "view"); okAcc = true; } catch {} } if (okAcc) items.push(manifest(a)); else missing.push(id); }
    return [200, { items, missing }];
  });
  route("GET", "/v1/assets/:id", q => { const a = assets.get(q.p[0]); if (!a) throw new AppError("NOT_FOUND"); const g = galleries.get(a.galleryId); need(g, principal(q.req, q.url, q.caller, g.id), "view"); return [200, manifest(a)]; });
  route("DELETE", "/v1/assets/:id", q => { const a = assets.get(q.p[0]); if (!a) throw new AppError("NOT_FOUND"); const g = galleries.get(a.galleryId); needUser(q.caller); need(g, principal(q.req, q.url, q.caller, g.id), "edit"); assets.delete(a.id); return [204]; });
  route("GET", "/v1/assets/:id/variants/:file", q => {
    const a = assets.get(q.p[0]); if (!a) throw new AppError("NOT_FOUND"); const g = galleries.get(a.galleryId);
    if (!q.url.searchParams.get("sig")) need(g, principal(q.req, q.url, q.caller, g.id), "view");
    const m = /^(\w+)\.(\w+)$/.exec(q.p[1]), v = m && a.variants.find(x => x.name === m[1] && x.format === m[2]); if (!v) throw new AppError("NOT_FOUND");
    return [200, a.data, { "content-type": v.mimeType, "cache-control": "private, max-age=300" }];
  });

  /* assistant */
  const convOf = (id, userId) => { const c = convs.get(id); if (!c || c.userId !== userId) throw new AppError("NOT_FOUND"); return c; };
  route("POST", "/v1/galleries/:id/assistant/conversations", q => { if (process.env.MOCK_ASSISTANT === "off") throw new AppError("AI_UNAVAILABLE"); const { userId } = needUser(q.caller), g = getG(q.p[0]); need(g, principal(q.req, q.url, q.caller, g.id), "edit"); const lang = q.body?.language || "en"; if (!LANG.includes(lang)) throw new AppError("VALIDATION_FAILED", { field: "language" }); const c = { id: rid(), galleryId: g.id, userId, language: lang, createdAt: now(), updatedAt: now() }; convs.set(c.id, c); const { userId: _u, ...pub } = c; return [201, pub]; });
  route("GET", "/v1/galleries/:id/assistant/conversations", q => { const { userId } = needUser(q.caller); return [200, { items: [...convs.values()].filter(c => c.userId === userId && c.galleryId === q.p[0]).map(({ userId: _u, ...c }) => c) }]; });
  route("POST", "/v1/assistant/conversations/:cid/commands", q => {
    const { userId } = needUser(q.caller), c = convOf(q.p[0], userId), b = q.body || {};
    if (typeof b.requestId !== "string" || b.requestId.length < 8 || typeof b.text !== "string" || !b.text.trim()) throw new AppError("VALIDATION_FAILED", { field: "text" });
    const dup = [...commands.values()].find(x => x.conversationId === c.id && x.requestId === b.requestId); if (dup) return [200, cmdView(dup)];
    const cmd = { id: rid(), conversationId: c.id, galleryId: c.galleryId, requestId: b.requestId, status: "queued", final: false, inputKind: "text", text: b.text.trim(), transcript: null, language: b.language || c.language, intent: null, reply: null, question: null, suggestions: [], actionId: null, revision: null, error: null, speech: { status: b.audioEnabled === false ? "disabled" : "disabled", path: null, error: null }, createdAt: now(), completedAt: null, selectedNodeIds: b.selectedNodeIds || [], userId };
    commands.set(cmd.id, cmd);
    const g = galleries.get(c.galleryId), p = { userId, linkToken: null };
    setTimeout(() => { cmd.status = "processing"; setTimeout(() => { try { assistantRun(cmd, g, p); } catch (e) { Object.assign(cmd, { status: "failed", final: true, completedAt: now(), error: { code: e.code || "INTERNAL", message: ERR[e.code]?.[1] || String(e.message) } }); } for (const k of conns) if (k.galleryId === g.id && k.capability === "edit" && k.principal.userId === userId) wsSend(k, { type: "assistant", command: cmdView(cmd) }); }, 120); }, 40);
    return [202, cmdView(cmd)];
  });
  route("GET", "/v1/assistant/commands/:id", q => { const { userId } = needUser(q.caller), c = commands.get(q.p[0]); if (!c || c.userId !== userId) throw new AppError("NOT_FOUND"); return [200, cmdView(c)]; });
  route("POST", "/v1/assistant/commands/:id/cancel", q => { const { userId } = needUser(q.caller), c = commands.get(q.p[0]); if (!c || c.userId !== userId) throw new AppError("NOT_FOUND"); if (!c.final) Object.assign(c, { status: "cancelled", final: true, completedAt: now() }); return [200, cmdView(c)]; });
  route("GET", "/v1/assistant/commands/:id/speech", () => { throw new AppError("NOT_FOUND", { what: "speech" }); });

  // handled before dispatch (needs the raw multipart body); registered so the lookup finds it
  route("POST", "/v1/galleries/:id/assets", () => { throw new AppError("INTERNAL"); });

  route("GET", "/health", () => [200, { status: "ok" }]);
  route("GET", "/ready", () => [200, { status: "ready", mock: true }]);
  route("GET", "/openapi.json", () => [200, { openapi: "3.1.0", info: { title: "My World mock backend", version: "mock" }, paths: {} }]);
  route("GET", "/v1/capabilities", () => [200, { mock: true, operations: ["node.add", "node.update", "node.remove", "node.duplicate", "node.reparent", "node.setTransform", "node.setMaterial", "node.setVisibility", "node.setText", "artwork.place", "artwork.hangOnWall", "artwork.setFrame", "room.resize", "scene.setEnvironment", "scene.setViewerAnchor"] }]);

  const server = http.createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, x-gallery-link, x-request-id, accept-language", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-expose-headers": "x-request-id" };
    const requestId = reqId(); const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    const chunks = []; req.on("data", d => chunks.push(d));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const send = (code, body, headers = {}) => { res.writeHead(code, { ...cors, "x-request-id": requestId, ...headers }); res.end(body); };
      try {
        const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new AppError("NOT_FOUND", { path: url.pathname });
        const ct = req.headers["content-type"] || "";
        let body = null; if (raw.length && ct.includes("application/json")) { try { body = JSON.parse(raw.toString()); } catch { throw new AppError("VALIDATION_FAILED", { reason: "invalid JSON" }); } }
        const q = { req, url, body, raw, p: r.re.exec(url.pathname).slice(1).map(decodeURIComponent), caller: caller(req) };
        q.multipart = () => parseMultipart(req, raw);
        // asset upload needs the raw multipart body
        if (req.method === "POST" && /^\/v1\/galleries\/[^/]+\/assets$/.test(url.pathname)) return assetUpload(q, send);
        const out = r.fn(q), [code, payload, headers] = out;
        if (Buffer.isBuffer(payload)) return send(code, payload, headers);
        send(code, code === 204 ? undefined : JSON.stringify(payload), { "content-type": "application/json", ...(headers || {}) });
      } catch (e) {
        const [code, message] = ERR[e.code] || [e.code === "UNDO_CONFLICT" ? 409 : 500, e.code === "UNDO_CONFLICT" ? "Someone changed that since." : "Something went wrong."];
        if (!(e instanceof AppError)) console.error(e);
        send(code, JSON.stringify({ error: { code: e instanceof AppError ? e.code : "INTERNAL", message, details: e.details ?? null, requestId } }), { "content-type": "application/json" });
      }
    });
  });
  function assetUpload(q, send) {
    const g = getG(q.p[0]); needUser(q.caller); need(g, principal(q.req, q.url, q.caller, g.id), "edit");
    const { fields, files } = parseMultipart(q.req, q.raw), f = files.file; if (!f) throw new AppError("VALIDATION_FAILED", { field: "file" });
    if (f.data.length > 25 * 1024 * 1024) throw new AppError("PAYLOAD_TOO_LARGE");
    const info = sniff(f.data); if (!info) throw new AppError("UNSUPPORTED_MEDIA_TYPE", { allowed: ["image/jpeg", "image/png", "image/webp"] });
    const id = rid(), mk = (name, max) => { const k = Math.min(1, max / Math.max(info.width, info.height)); return { name, format: info.format, mimeType: info.mime, width: Math.round(info.width * k), height: Math.round(info.height * k), bytes: f.data.length }; };
    const a = { id, galleryId: g.id, kind: "image", originalFormat: info.format, width: info.width, height: info.height, aspectRatio: info.width / info.height, bytes: f.data.length, title: fields.title || f.filename.replace(/\.[^.]+$/, ""), description: fields.description || "", attribution: fields.attribution || "", uploadedBy: q.caller.userId, createdAt: now(), variants: [mk("original", 1e9), mk("thumb", 256), mk("medium", 1024), mk("large", 2048)], data: f.data };
    assets.set(id, a); send(201, JSON.stringify(manifest(a)), { "content-type": "application/json" });
  }
  server.on("upgrade", handleUpgrade);

  return {
    server, port: PORT, state: { users, galleries, assets },
    listen: (port = PORT, host = "0.0.0.0") => new Promise(r => server.listen(port, host, () => r(server))),
    close: () => new Promise(r => { for (const c of conns) try { c.socket.destroy(); } catch {} server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const m = createMock(); const srv = await m.listen();
  console.log(`\n  Mock backend listening on http://localhost:${srv.address().port}  (in memory; this is a stand-in, not the real backend)\n`);
}
