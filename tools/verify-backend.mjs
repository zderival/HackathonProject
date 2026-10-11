#!/usr/bin/env node
/* My World: backend check.
   Makes the same calls the front end makes and prints PASS / FAIL for each, so you can see in one go whether your
   backend and My World agree. It needs nothing installed (Node 22+).

     node tools/verify-backend.mjs                          # checks http://localhost:8080
     node tools/verify-backend.mjs http://localhost:8080    # or any URL
     BACKEND_URL=https://api.example.com node tools/verify-backend.mjs
   The same script runs against the built-in stand-in (npm run mock), so you can compare the two. */
import fs from "node:fs"; import zlib from "node:zlib"; import path from "node:path"; import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, "..");
const SM = require(path.join(root, "js/api/scenemap.js"));
const VRData = new Function(fs.readFileSync(path.join(root, "js/vr/data.js"), "utf8") + "; return VRData;")();
SM.__data = VRData; SM.__text = { body: "x", font: "display", weight: 700, fs: 1, color: "#f5f1ea", align: "center", card: false, cardCol: "#1b1724", cardOp: .85, width: 1 };

const BASE = (process.argv[2] || process.env.BACKEND_URL || "http://localhost:8080").replace(/\/+$/, "");
const C = process.stdout.isTTY ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" } : { g: "", r: "", y: "", d: "", x: "" };
let pass = 0, fail = 0, skip = 0; const failed = [];
const ok = (c, m, extra) => { if (c) { pass++; console.log(`${C.g}PASS${C.x}  ${m}`); } else { fail++; failed.push(m); console.log(`${C.r}FAIL${C.x}  ${m}${extra ? C.d + "  → " + extra + C.x : ""}`); } return !!c; };
const skipped = (m, why) => { skip++; console.log(`${C.y}SKIP${C.x}  ${m}${C.d}  (${why})${C.x}`); };
const section = t => console.log(`\n${t}`);
const uuid = () => crypto.randomUUID();

async function call(method, p, { token, link, body, form, query } = {}) {
  const h = { accept: "application/json" }; if (token) h.authorization = "Bearer " + token; if (link) h["x-gallery-link"] = link;
  let b; if (body !== undefined) { h["content-type"] = "application/json"; b = JSON.stringify(body); } else if (form) b = form;
  const qs = query ? "?" + new URLSearchParams(query) : "";
  let res; try { res = await fetch(BASE + p + qs, { method, headers: h, body: b, signal: AbortSignal.timeout(30000) }); } catch (e) { return { status: 0, json: null, err: e.message }; }
  const ct = res.headers.get("content-type") || "", raw = ct.includes("json") ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
  return { status: res.status, json: ct.includes("json") ? raw : null, buf: ct.includes("json") ? null : raw, ct, headers: res.headers };
}
const code = r => r.json?.error?.code;
const why = r => r.status ? `HTTP ${r.status} ${code(r) || ""} ${r.json?.error?.message || ""}`.trim() : "no answer: " + r.err;

/* tiny test pictures, built here so nothing needs to be installed */
function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function png(w, h, rgb) {
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "ascii"); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = (rgb[1] + x) & 255; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const upload = (gid, token, buf, name, type = "image/png", fields = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append("file", new Blob([buf], { type }), name); return call("POST", `/v1/galleries/${gid}/assets`, { token, form: f }); };

const wsOpen = (url, ms = 8000) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url), msgs = [], waiters = []; let t = setTimeout(() => reject(new Error("no connection")), ms);
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } msgs.push(m); waiters.slice().forEach(w => w(m)); };
  ws.onopen = () => { clearTimeout(t); resolve({ ws, msgs, waitFor: (type, ms2 = 6000) => new Promise((res, rej) => { const f = msgs.find(m => m.type === type); if (f) return res(f); const to = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error("timeout waiting for " + type)); }, ms2); const w = m => { if (m.type === type) { clearTimeout(to); waiters.splice(waiters.indexOf(w), 1); res(m); } }; waiters.push(w); }) }); };
  ws.onerror = () => { clearTimeout(t); reject(new Error("websocket error")); };
});
async function ticketWs(gid, token, capability, link) {
  const t = await call("POST", `/v1/galleries/${gid}/realtime-tickets`, { token, link, body: { capability } });
  if (t.status !== 201 && t.status !== 200) return { t };
  const u = new URL(t.json.url, BASE); const wsBase = BASE.replace(/^http/, "ws"); // like the front end: keep only path and query
  return { t, conn: await wsOpen(wsBase + u.pathname + u.search) };
}

(async () => {
  console.log(`\nMy World backend check  →  ${BASE}\n`);
  section("Is it up?");
  const h = await call("GET", "/health"); if (!ok(h.status === 200, "GET /health answers", why(h))) { console.log(`\n${C.r}The backend isn't reachable at ${BASE}.${C.x} Start it (npm run dev in the backend folder, or npm run mock here) and try again.\n`); process.exit(2); }
  const rd = await call("GET", "/ready"); ok(rd.status === 200, "GET /ready says it's ready (database and storage reachable)", why(rd));

  section("Accounts");
  const user = "mw_" + Math.random().toString(36).slice(2, 9), pw = "Pass-" + Math.random().toString(36).slice(2, 12) + "!9";
  const reg = await call("POST", "/v1/auth/register", { body: { username: user, password: pw, displayName: "Check" } });
  if (!ok(reg.status === 201 || reg.status === 200, "register a new account", why(reg))) { console.log("Can't continue without an account."); process.exit(1); }
  let tk = reg.json.tokens; ok(!!(tk?.accessToken && tk?.refreshToken), "register returns access + refresh tokens", JSON.stringify(Object.keys(reg.json || {})));
  const me = await call("GET", "/v1/auth/me", { token: tk.accessToken }); ok(me.status === 200 && (me.json?.username === user || me.json?.user?.username === user), "GET /auth/me knows the account", why(me));
  const lg = await call("POST", "/v1/auth/login", { body: { username: user, password: pw } }); ok(lg.status === 200 && !!lg.json?.tokens?.accessToken, "login with the same password", why(lg));
  const bad = await call("POST", "/v1/auth/login", { body: { username: user, password: "wrong-password-1" } }); ok(bad.status === 401, "a wrong password is refused (401)", why(bad));
  const old = tk.refreshToken, rf = await call("POST", "/v1/auth/refresh", { body: { refreshToken: old } });
  ok(rf.status === 200 && !!rf.json?.tokens?.accessToken || rf.status === 200 && !!rf.json?.accessToken, "refresh gives new tokens", why(rf));
  if (rf.status === 200) tk = rf.json.tokens || rf.json;
  const re2 = await call("POST", "/v1/auth/refresh", { body: { refreshToken: old } }); ok(re2.status === 401, "the old refresh token can't be used twice (rotation)", why(re2));
  const noauth = await call("GET", "/v1/galleries"); ok(noauth.status === 401, "listing worlds without signing in is refused", why(noauth));
  let T = tk.accessToken;

  section("Worlds");
  const cg = await call("POST", "/v1/galleries", { token: T, body: { title: "Check world", template: "blank" } });
  if (!ok(cg.status === 201 || cg.status === 200, "create a world from the blank template", why(cg))) process.exit(1);
  const gid = cg.json.id || cg.json.gallery?.id; ok(!!gid, "the new world has an id");
  const ls = await call("GET", "/v1/galleries", { token: T, query: { limit: 100 } }); ok(ls.status === 200 && (ls.json?.items || []).some(g => g.id === gid), "it shows up in the list of worlds", why(ls));
  const g1 = await call("GET", `/v1/galleries/${gid}`, { token: T }); ok(g1.status === 200 && g1.json?.capabilities?.canEdit === true, "the owner can edit it (capabilities.canEdit)", why(g1));
  const rn = await call("PATCH", `/v1/galleries/${gid}`, { token: T, body: { title: "Renamed check" } }); ok(rn.status === 200 && rn.json?.title === "Renamed check", "rename the world", why(rn));
  const sc = await call("GET", `/v1/galleries/${gid}/scene`, { token: T }); ok(sc.status === 200 && sc.json?.scene?.schemaVersion === 1 && Number.isInteger(sc.json?.revision), "GET /scene returns { revision, scene.schemaVersion: 1 }", why(sc));
  let rev = sc.json?.revision ?? 0, mirror = sc.json?.scene;

  section("Pictures");
  const p1 = await upload(gid, T, png(96, 64, [200, 40, 60]), "sunrise.png", "image/png", { title: "Sunrise" });
  ok(p1.status === 201 || p1.status === 200, "upload a PNG (text fields first, then the file)", why(p1));
  const a1 = p1.json?.id || p1.json?.assetId || p1.json?.asset?.id; ok(!!a1, "the answer carries an asset id", JSON.stringify(Object.keys(p1.json || {})));
  const p2 = await upload(gid, T, png(40, 80, [20, 90, 200]), "tall.png", "image/png"); const a2 = p2.json?.id || p2.json?.assetId; ok(!!a2, "upload a second PNG", why(p2));
  const px = await upload(gid, T, Buffer.from("this is not a picture"), "notes.txt", "text/plain"); ok(px.status >= 400 && px.status < 500, "a text file is refused with a 4xx", why(px));
  const mf = await call("POST", "/v1/assets/manifests", { token: T, body: { assetIds: [a1, a2].filter(Boolean) } });
  const items = mf.json?.items || mf.json?.manifests || (Array.isArray(mf.json) ? mf.json : []);
  ok(mf.status === 200 && items.length === 2, "manifests lists both pictures", why(mf) + " " + JSON.stringify(Object.keys(mf.json || {})));
  const variant = items[0]?.variants?.find?.(v => /medium|large|thumb/.test(v.name || v.variant || "")) || items[0]?.variants?.[0];
  const proxy = variant?.proxyPath || variant?.path || variant?.url;
  if (proxy) { const vr = await call("GET", proxy.replace(/^https?:\/\/[^/]+/, ""), { token: T }); ok(vr.status === 200 && /^image\//.test(vr.ct), "a picture variant downloads with the signed-in token", why(vr) + " " + vr.ct); }
  else skipped("download a picture variant", "manifest has no proxyPath/variants; see " + JSON.stringify(items[0] || {}).slice(0, 120));

  section("Editing the scene");
  const SIZE = 1.25;
  const model = { view: { dome: 4.5 }, bg: VRData.presetBg("glum"), items: [
    { id: "i1", type: "image", name: "Sunrise", az: -34, h: 1.55, d: 3.3, size: SIZE, tilt: 3, frame: "thin", caption: true, hidden: false, ar: 1.5, assetId: a1, o: 1 },
    { id: "i2", type: "image", name: "Tall", az: 120.5, h: 1.7, d: 3.1, size: 1.1, tilt: 0, frame: "plate", caption: false, hidden: true, ar: .5, assetId: a2, o: 2 },
    { id: "t1", type: "text", name: "", az: 10, h: 2, d: 3.3, size: 1.6, tilt: 0, frame: "none", caption: false, hidden: false, ar: 2.4, text: { ...SM.__text, body: "Hello dome", card: true }, o: 3 }] };
  const ops = SM.toOps(SM.diff(model, mirror));
  const act = await call("POST", `/v1/galleries/${gid}/actions`, { token: T, body: { requestId: uuid(), baseRevision: rev, conflictMode: "merge", label: "Check", ops } });
  ok(act.status === 200 || act.status === 201, `submit ${ops.length} operations (node.add …) to /actions`, why(act) + " " + JSON.stringify(act.json?.error?.details || "").slice(0, 300));
  const newRev = act.json?.revision; ok(Number.isInteger(newRev) && newRev > rev, "the answer has a higher revision", JSON.stringify(Object.keys(act.json || {})));
  const sc2 = await call("GET", `/v1/galleries/${gid}/scene`, { token: T }); const back = SM.fromScene(sc2.json.scene, model);
  const b1 = back.items.find(i => i.id === "i1"), b2 = back.items.find(i => i.id === "i2"), bt = back.items.find(i => i.id === "t1");
  ok(back.items.length === 3, "all 3 things come back from the scene", back.items.length + " items");
  ok(b1 && b1.az === -34 && b1.h === 1.55 && b1.size === SIZE && b1.tilt === 3 && b1.frame === "thin" && b1.ar === 1.5, "a picture keeps its exact position, size, tilt, frame", JSON.stringify(b1));
  ok(b2 && b2.hidden === true && b2.frame === "plate" && b2.assetId === a2, "a hidden, plate-framed picture round-trips", JSON.stringify(b2));
  ok(bt && bt.text?.body === "Hello dome" && bt.text.card === true, "text round-trips", JSON.stringify(bt));
  ok(back.bg?.preset === "glum", "the background preset round-trips");
  const art = Object.values(sc2.json.scene.nodes).find(n => n.type === "artwork"); ok(!!art && Array.isArray(art.transform?.position), "the server sees a real artwork node with a 3D position", JSON.stringify(art || {}).slice(0, 200));
  mirror = sc2.json.scene; rev = sc2.json.revision;

  const m2 = JSON.parse(JSON.stringify(model)); m2.items[0].az = 50; m2.items[0].size = 1.4;
  const ops2 = SM.toOps(SM.diff(m2, mirror)); ok(ops2.length > 0 && ops2.length < 6, "moving one picture sends a small change (" + ops2.length + " operations)");
  const a3 = await call("POST", `/v1/galleries/${gid}/actions`, { token: T, body: { requestId: uuid(), baseRevision: rev, conflictMode: "merge", label: "Move", ops: ops2 } }); ok(a3.status === 200 || a3.status === 201, "submit the move", why(a3));
  // a1 above moved i1 and the world is now at rev+1; a second change that still says "based on rev" has gone stale
  const stale = await call("POST", `/v1/galleries/${gid}/actions`, { token: T, body: { requestId: uuid(), baseRevision: rev, conflictMode: "strict", label: "Stale", ops: SM.toOps(SM.diff({ ...model, items: model.items.map(i => i.id === "i2" ? { ...i, az: 70 } : i) }, mirror)) } });
  ok(stale.status === 409 && code(stale) === "REVISION_CONFLICT", "a strict change on an old revision is refused with REVISION_CONFLICT (409)", why(stale));
  const m4 = { ...model, items: model.items.map(i => i.id === "i2" ? { ...i, az: 70 } : i) };
  const merged = await call("POST", `/v1/galleries/${gid}/actions`, { token: T, body: { requestId: uuid(), baseRevision: rev, conflictMode: "merge", label: "Merge", ops: SM.toOps(SM.diff(m4, mirror)) } });
  ok(merged.status === 200 || merged.status === 201, "a change to a different picture on an old revision merges (conflictMode merge)", why(merged));
  const hist = await call("GET", `/v1/galleries/${gid}/events`, { token: T, query: { after: 0 } }); ok(hist.status === 200 && Array.isArray(hist.json?.items || hist.json?.events), "GET /events?after=0 replays the history", why(hist) + " " + JSON.stringify(Object.keys(hist.json || {})));
  const un = await call("POST", `/v1/galleries/${gid}/undo`, { token: T, body: { requestId: uuid() } }); ok(un.status === 200 || un.status === 201, "undo", why(un));
  const rdo = await call("POST", `/v1/galleries/${gid}/redo`, { token: T, body: { requestId: uuid() } }); ok(rdo.status === 200 || rdo.status === 201, "redo", why(rdo));

  section("Live updates (WebSocket)");
  try {
    const { t, conn } = await ticketWs(gid, T, "edit");
    if (!conn) ok(false, "get a realtime ticket", why(t));
    else {
      ok(true, "get a one-time realtime ticket and open the socket");
      const hello = await conn.waitFor("hello"); ok(!!hello && (hello.canEdit === true || hello.capability === "edit"), "the socket says hello with edit permission", JSON.stringify(hello));
      const snap = await conn.waitFor("snapshot"); ok(Number.isInteger(snap.revision) && !!snap.scene, "then sends a snapshot { revision, scene }", JSON.stringify(Object.keys(snap)));
      const sc3 = await call("GET", `/v1/galleries/${gid}/scene`, { token: T }); const cur = sc3.json.revision;
      const m3 = JSON.parse(JSON.stringify(m2)); m3.items[1].az = 75;
      const sub = await call("POST", `/v1/galleries/${gid}/actions`, { token: T, body: { requestId: uuid(), baseRevision: cur, conflictMode: "merge", label: "Live", ops: SM.toOps(SM.diff(m3, sc3.json.scene)) } });
      const opsMsg = await conn.waitFor("ops", 6000).catch(() => null); ok(!!opsMsg && opsMsg.revision === sub.json?.revision, "a change made over HTTP arrives on the socket (type ops, next revision)", JSON.stringify(opsMsg || {}).slice(0, 200));
      conn.ws.send(JSON.stringify({ type: "ping" })); const pong = await conn.waitFor("pong", 4000).catch(() => null); ok(!!pong, "ping gets a pong");
      conn.ws.close();
      const again = await call("POST", `/v1/galleries/${gid}/realtime-tickets`, { token: T, body: { capability: "edit" } });
      if (again.status < 300) { const u = new URL(again.json.url, BASE), ws2 = await wsOpen(BASE.replace(/^http/, "ws") + u.pathname + u.search); ws2.ws.close(); const reuse = await wsOpen(BASE.replace(/^http/, "ws") + u.pathname + u.search).then(c => c.waitFor("hello", 2500).then(() => false).catch(() => true).finally(() => c.ws.close()), () => true); ok(reuse, "a ticket works only once"); }
    }
  } catch (e) { ok(false, "WebSocket flow", e.message); }

  section("Sharing and the phone QR code");
  const s0 = await call("GET", `/v1/galleries/${gid}/sharing`, { token: T }); ok(s0.status === 200 && s0.json?.sharingMode === "restricted", "new worlds are private (restricted)", why(s0) + " " + JSON.stringify(s0.json || {}).slice(0, 150));
  const pv = await call("POST", `/v1/galleries/${gid}/viewer-sessions`, { token: T, body: { kind: "preview" } });
  ok(pv.status === 201 || pv.status === 200, "the owner makes a one-time phone pairing", why(pv));
  const pc = pv.json?.pairingCode, pu = pv.json?.pairingUrl; ok(!!pc && !!pu, "it has pairingCode and pairingUrl (the QR holds this URL)", JSON.stringify(Object.keys(pv.json || {})));
  if (pu) { let okUrl = false; try { const u = new URL(pu); okUrl = /^\/p\/[A-Za-z0-9_-]{6,64}\/?$/.test(u.pathname); console.log(`${C.d}      pairingUrl host: ${u.origin}  (set VIEWER_BASE_URL in the backend; the front end swaps in the address your phone can reach)${C.x}`); } catch {} ok(okUrl, "pairingUrl ends in /p/<code>, which the front end serves"); }
  const cl = await call("POST", "/v1/pairings/claim", { body: { code: pc } });
  ok(cl.status === 200 && !!cl.json?.viewerToken && cl.json?.galleryId === gid, "the phone claims the code and gets a view-only token", why(cl));
  const VT = cl.json?.viewerToken;
  const cl2 = await call("POST", "/v1/pairings/claim", { body: { code: pc } }); ok(cl2.status >= 400, "the same code can't be claimed twice", why(cl2));
  const vsc = await call("GET", `/v1/galleries/${gid}/scene`, { token: VT }); ok(vsc.status === 200 && Object.keys(vsc.json?.scene?.nodes || {}).length > 0, "that token reads the whole scene (the phone sees every picture)", why(vsc));
  const vg = await call("GET", `/v1/galleries/${gid}`, { token: VT }); ok(vg.status === 200 && vg.json?.capabilities?.canEdit === false, "and says the phone can't edit", why(vg));
  const vedit = await call("POST", `/v1/galleries/${gid}/actions`, { token: VT, body: { requestId: uuid(), baseRevision: vsc.json?.revision ?? 0, conflictMode: "merge", label: "Nope", ops: [] } }); ok(vedit.status === 401 || vedit.status === 403, "the phone token can't change anything", why(vedit));
  if (a1 && proxy) { const mv = await call("POST", "/v1/assets/manifests", { token: VT, body: { assetIds: [a1] } }); const vv = mv.json?.items?.[0]?.variants?.find?.(v => /medium|large|thumb/.test(v.name || "")) || mv.json?.items?.[0]?.variants?.[0]; const vp = vv?.proxyPath || vv?.path; const pic = vp ? await call("GET", vp.replace(/^https?:\/\/[^/]+/, ""), { token: VT }) : null; ok(!!pic && pic.status === 200 && /^image\//.test(pic.ct), "the phone token downloads the pictures", pic ? why(pic) : "no manifest"); }
  try { const { t, conn } = await ticketWs(gid, VT, "view"); if (!conn) ok(false, "the phone opens a live socket with its token", why(t)); else { const sn = await conn.waitFor("snapshot"); ok(!!sn.scene, "the phone gets a live snapshot over WebSocket"); conn.ws.close(); } } catch (e) { ok(false, "phone WebSocket", e.message); }

  const sv = await call("PUT", `/v1/galleries/${gid}/sharing`, { token: T, body: { mode: "view_link" } }); ok(sv.status === 200, "turn on 'anyone with the link can look'", why(sv));
  const s1 = await call("GET", `/v1/galleries/${gid}/sharing`, { token: T }); const viewUrl = s1.json?.viewUrl; ok(!!viewUrl && /\/view\/[0-9a-f-]{36}\?link=/.test(viewUrl), "there is a viewUrl like /view/<id>?link=<token>", String(viewUrl));
  const tokenOf = u => { try { return new URL(u).searchParams.get("link"); } catch { return null; } }, LK = tokenOf(viewUrl);
  const rs = await call("GET", "/v1/links/resolve", { query: { url: viewUrl } }); ok(rs.status === 200 && rs.json?.galleryId === gid, "/links/resolve understands that link", why(rs) + " " + JSON.stringify(rs.json || {}).slice(0, 160));
  const lvs = await call("POST", `/v1/galleries/${gid}/viewer-sessions`, { link: LK, body: { kind: "viewer" } }); ok((lvs.status === 201 || lvs.status === 200) && !!lvs.json?.viewerToken, "the link buys a view-only session", why(lvs));
  const lsc = await call("GET", `/v1/galleries/${gid}/scene`, { link: LK }); ok(lsc.status === 200, "the X-Gallery-Link header reads the scene", why(lsc));
  const rot = await call("POST", `/v1/galleries/${gid}/sharing/rotate`, { token: T, body: { links: "both" } }); ok(rot.status === 200 || rot.status === 201, "make a new link (the old one stops)", why(rot));
  const lsc2 = await call("GET", `/v1/galleries/${gid}/scene`, { link: LK }); ok(lsc2.status >= 400, "the old link no longer works", why(lsc2));
  const off = await call("PUT", `/v1/galleries/${gid}/sharing`, { token: T, body: { mode: "restricted" } }); ok(off.status === 200, "stop sharing", why(off));

  section("Assistant (needs GEMINI_API_KEY in the backend)");
  const cv = await call("POST", `/v1/galleries/${gid}/assistant/conversations`, { token: T, body: { language: "en" } });
  if (cv.status === 201 || cv.status === 200) {
    ok(true, "start an assistant conversation");
    const cid = cv.json?.id || cv.json?.conversationId, cm = await call("POST", `/v1/assistant/conversations/${cid}/commands`, { token: T, body: { requestId: uuid(), text: "Make the first picture a little bigger", language: "en", baseRevision: (await call("GET", `/v1/galleries/${gid}/scene`, { token: T })).json.revision } });
    ok(cm.status === 202 || cm.status === 200 || cm.status === 201, "send it a command", why(cm) + " " + JSON.stringify(cm.json?.error?.details || "").slice(0, 160));
    let cmd = cm.json; for (let i = 0; i < 40 && cmd && !cmd.final && cm.json?.id; i++) { await new Promise(r => setTimeout(r, 1000)); cmd = (await call("GET", `/v1/assistant/commands/${cm.json.id}`, { token: T })).json; }
    ok(!!cmd?.final, "it finishes (" + (cmd?.status || "?") + ")", JSON.stringify(cmd || {}).slice(0, 200));
    if (cmd?.status === "failed") console.log(`${C.d}      failed with: ${JSON.stringify(cmd.error)}  (usually a missing or wrong GEMINI_API_KEY)${C.x}`);
  } else if (cv.status === 503 || cv.status === 501 || code(cv) === "AI_UNAVAILABLE") skipped("assistant", "the backend says the assistant isn't configured");
  else ok(false, "start an assistant conversation", why(cv));

  section("Clean up");
  const dg = await call("DELETE", `/v1/galleries/${gid}`, { token: T }); ok(dg.status === 200 || dg.status === 204, "delete the check world", why(dg));
  const gone = await call("GET", `/v1/galleries/${gid}`, { token: T }); ok(gone.status === 404 || gone.status === 410, "it's gone", why(gone));

  console.log(`\n${fail ? C.r : C.g}${pass} passed, ${fail} failed${skip ? ", " + skip + " skipped" : ""}${C.x}`);
  if (fail) { console.log("\nTo look at:"); failed.forEach(f => console.log("  - " + f)); }
  console.log("");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("\nThe check itself crashed:", e); process.exit(1); });
