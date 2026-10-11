/* CLOUD: keeps the dome and the backend in step.

   Creator (editor window)
     sign in → pick or create a world → the dome loads from the backend's scene
     every edit  → small list of operations → POST /v1/galleries/{id}/actions (merge mode, one request id per attempt)
     everything others do (another editor, the assistant, undo) arrives over the WebSocket and is applied item by item
   Phone / visitor (opened from the QR code: /view/<id>?link=…  or  /p/<code>)
     link → /v1/links/resolve → viewer session (or pairing claim) → read-only WebSocket → the same dome, live
   Pictures are uploaded as assets and downloaded with the device's own permission (no public bucket needed).

   `mirror` is our copy of the server's scene and `rev` its revision. The dome (VRStore) is what the person sees.
   Anything that differs between the two is a pending local edit; anything the server changes is merged under it. */
const Cloud = (() => {
  const boot = window.MW_BOOT || {};
  const web = location.protocol === "http:" || location.protocol === "https:";
  const isJoin = !!boot.join, SM = SceneMap;
  const LS = { get: k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } }, set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} } };
  const st = { checked: false, available: false, busy: "", user: null, galleries: [], gallery: null, live: "off", sync: "idle", detail: "", err: "", readOnly: false, rev: 0, sharing: null, pair: null, info: null, join: "connecting", joinMsg: "", joinTitle: "", title: "", assistant: false, authErr: "" };
  const subs = new Set(), emit = () => subs.forEach(f => { try { f(st); } catch (e) { console.error(e); } });
  const clone = SM.clone, say = m => { if (typeof toast === "function") toast(m); };
  const emptyScene = () => ({ schemaVersion: 1, environment: SM.emptyEnv(), viewerAnchor: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1], roomId: null }, nodes: {}, ext: {} });

  let mirror = emptyScene(), rev = 0, live = null, gid = "";
  const modelNow = () => ({ view: VRStore.state.view, bg: VRStore.state.bg, items: VRStore.state.items });
  const canEdit = () => !!st.gallery && !st.readOnly && !isJoin;

  /* ------------------------------------------------------------ dome <- scene */
  function applyToModel(scene) {
    const m = SM.fromScene(scene, VRStore.state);
    // things that only exist on this device (videos, a picture still uploading) stay where they are
    const localOnly = VRStore.state.items.filter(i => !scene.nodes[i.id] && !SM.pushable(i) && (i.type === "video" || uploading.has(i.id)));
    m.items = [...m.items, ...localOnly];
    const changed = VRStore.sync(m);
    st.title = (st.gallery && st.gallery.title) || st.title;
    prefetch(m);
    return changed;
  }
  // merge a new server state under any edits the person has made that the server hasn't seen yet
  function advance(change) {
    const pendingEdits = isJoin ? [] : SM.diff(modelNow(), mirror);
    change();
    const target = pendingEdits.length ? SM.applyWire(clone(mirror), pendingEdits) : mirror;
    applyToModel(target);
    st.rev = rev; emit();
  }
  function onSnapshot(m) {
    if (m.revision === rev && m.reason === "initial" && Object.keys(mirror.nodes).length) return;
    advance(() => { mirror = clone(m.scene); rev = m.revision; });
    if (isJoin) setJoinLive();
  }
  function onOps(m) {
    if (m.revision <= rev) return; // our own change (already applied from the HTTP answer) or a duplicate
    if (m.revision !== rev + 1) { if (live) live.resync(rev); return; } // gap: the server replays what we missed
    advance(() => { SM.applyWire(mirror, m.changes); rev = m.revision; });
    if (isJoin) setJoinLive();
  }
  async function catchUp() {
    const sc = await Api.getScene(gid);
    advance(() => { mirror = clone(sc.scene); rev = sc.revision; });
  }

  /* ------------------------------------------------------------ live connection */
  function connectLive(capability, auth) {
    if (live) live.close();
    live = new Api.Live({
      galleryId: gid, capability, auth, link: boot.link || undefined,
      on: {
        state: (s, e) => {
          st.live = s;
          if (isJoin) {
            if (s === "live") { /* snapshot follows */ } else if (s === "reconnecting" || s === "connecting") { if (st.join === "live" || st.join === "waiting") st.join = "offline"; }
            else if (s === "denied" || s === "revoked") joinEnd("denied", "This world isn't shared any more", "The creator turned off this link or code. Ask them for a new QR code.");
            else if (s === "full") joinEnd("denied", "This world is full right now", "Too many people are looking at it. Try again in a minute.");
          } else if (s === "revoked") { st.err = "Your access to this world was removed."; st.readOnly = true; say(st.err); }
          emit();
        },
        hello: m => { st.caps = m; if (!isJoin) { st.readOnly = !m.canEdit && capability === "edit" ? true : st.readOnly; } emit(); },
        snapshot: onSnapshot, ops: onOps,
        permissions: m => { if (!isJoin) { st.readOnly = !m.canEdit; st.gallery && (st.gallery.role = m.role); say(m.canEdit ? "You can edit this world again." : "You can look at this world but not change it."); emit(); } },
        error: m => { if (m.code === "REVISION_CONFLICT") return; if (m.fatal) { st.err = m.message || "Connection problem"; emit(); } },
        assistant: m => onAssistant(m.command),
      },
    });
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && live) live.reconnectNow(); });
  addEventListener("online", () => { if (live) live.reconnectNow(); if (canEdit()) schedulePush(200); });

  /* ------------------------------------------------------------ edits → backend */
  let pushT = 0, pushing = false, again = false, failN = 0;
  function assignOrder() { let max = 0; VRStore.state.items.forEach(i => { if (i.o != null && i.o < 1e6) max = Math.max(max, i.o); }); VRStore.state.items.forEach(i => { if (i.o == null || i.o >= 1e6) i.o = ++max; }); }
  function schedulePush(delay = 280) {
    if (!st.gallery || isJoin) return;
    if (st.readOnly) { clearTimeout(pushT); pushT = setTimeout(() => { applyToModel(mirror); say("This world is view-only for you, so that change was undone."); }, 60); return; }
    st.sync = "saving"; emit(); clearTimeout(pushT); pushT = setTimeout(push, delay);
  }
  function committed(r) {
    if (r.revision === rev + 1) { SM.applyWire(mirror, r.changes); rev = r.revision; st.rev = rev; return true; }
    return r.revision <= rev; // already applied from the WebSocket
  }
  async function push() {
    if (pushing) { again = true; return; }
    if (!st.gallery) return;
    pushing = true; clearTimeout(pushT);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        assignOrder();
        const ch = SM.diff(modelNow(), mirror);
        if (!ch.length) break;
        const ops = SM.toOps(ch); let conflict = false;
        for (let i = 0; i < ops.length && !conflict; i += 200) {
          try {
            const r = await Api.submit(gid, { requestId: Api.uuid(), baseRevision: rev, conflictMode: "merge", label: "Edit in My World", ops: ops.slice(i, i + 200) });
            if (!committed(r)) await catchUp();
          } catch (e) {
            if (e.code === "REVISION_CONFLICT") { await catchUp(); conflict = true; } else throw e;
          }
        }
        if (attempt === 4) throw Object.assign(new Error("Other people kept changing the same things. Try again."), { soft: true });
      }
      st.sync = "saved"; st.err = ""; failN = 0;
    } catch (e) {
      failN++;
      if (e.status === 403) { st.readOnly = true; st.sync = "error"; st.err = "You don't have permission to change this world."; say(st.err); applyToModel(mirror); }
      else if (e.status === 422 || e.code === "SCENE_INVALID") { st.sync = "error"; st.err = "The server refused a change: " + ((e.details && (e.details.reason || e.details.message)) || e.message); say(st.err); console.warn("scene rejected", e.details); }
      else { st.sync = "error"; st.err = e.message || "Couldn't reach the server."; if (!e.soft && failN < 8) setTimeout(() => schedulePush(0), Math.min(30000, 1500 * 2 ** failN)); }
    }
    pushing = false; emit();
    if (again) { again = false; schedulePush(60); }
  }
  function onStore(ev) {
    if (!st.gallery || isJoin || ev.remote) return;
    if (ev.type === "items" || ev.type === "reset") VRStore.state.items.forEach(queueUpload);
    if (ev.type === "bg" && ev.patch && ev.patch.pano && !String(ev.patch.pano).startsWith("a_")) uploadPano(ev.patch.pano);
    if (ev.type === "item" && ev.patch && ev.patch.mediaId) queueUpload(VRStore.item(ev.id));
    schedulePush();
  }

  /* ------------------------------------------------------------ pictures */
  const upQ = []; let upBusy = 0, skipped = 0, skipT = 0; const uploading = new Set(), panoUp = new Set();
  function queueUpload(it) {
    if (!it || it.type !== "image" || it.assetId || (!it.mediaId && !it.src) || String(it.mediaId || "").startsWith("a_") || uploading.has(it.id) || !canEdit()) return;
    uploading.add(it.id); upQ.push(it.id); pumpUploads();
  }
  async function pumpUploads() {
    while (upBusy < 2 && upQ.length) {
      const id = upQ.shift(); upBusy++;
      (async () => {
        const it = VRStore.item(id); if (!it || it.assetId) return;
        const total = upQ.length + upBusy; st.detail = total > 1 ? `Uploading pictures (${total} left)…` : "Uploading a picture…"; st.sync = "saving"; emit();
        try {
          let blob = it.mediaId ? await VRStore.MediaDB.get(it.mediaId) : null;
          if (!blob && it.src) { // one of the sample pieces: use its picture if the file is there
            try { const r = await fetch(it.src); const b = r.ok ? await r.blob() : null; if (b && /^image\/(jpeg|png|webp)$/.test(b.type)) blob = b; } catch {}
            if (!blob) { skipped++; clearTimeout(skipT); skipT = setTimeout(() => { say(`${skipped} sample piece${skipped > 1 ? "s" : ""} without a picture file ${skipped > 1 ? "were" : "was"} left out of this world.`); skipped = 0; }, 600); VRStore.remove(id); return; }
          }
          if (!blob) throw new Error("The picture isn't on this device any more.");
          let meta, lastErr;
          for (let t = 0; t < 3 && !meta; t++) { try { meta = await Api.uploadAsset(gid, blob, { title: it.name || "", filename: (it.name || "picture") + extFor(blob.type) }); } catch (e) { lastErr = e; if (e.status && e.status < 500 && e.status !== 0) break; await new Promise(r => setTimeout(r, 800 * (t + 1))); } }
          if (!meta) throw lastErr || new Error("Upload failed");
          await VRStore.MediaDB.put("a_" + meta.id, blob);
          if (VRStore.item(id)) VRStore.update(id, { assetId: meta.id, ar: meta.aspectRatio || it.ar }); // → the picture appears for everyone
        } catch (e) {
          const it2 = VRStore.item(id);
          if (it2) { VRStore.remove(id); say(e.status === 415 ? "Only JPEG, PNG and WebP pictures can be shared. That one was taken out." : e.status === 413 ? "That picture is too big for the server. It was taken out." : `Couldn't upload “${it.name || "a picture"}”: ${e.message}`); }
        } finally { uploading.delete(id); upBusy--; if (!upQ.length && !upBusy) { st.detail = ""; emit(); schedulePush(50); } pumpUploads(); }
      })();
    }
  }
  const extFor = mime => ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[mime] || "");
  async function uploadPano(localId) {
    if (!canEdit() || panoUp.has(localId)) return; panoUp.add(localId);
    try {
      const blob = await VRStore.MediaDB.get(localId); if (!blob) return;
      const meta = await Api.uploadAsset(gid, blob, { title: VRStore.bg.panoName || "Background", filename: (VRStore.bg.panoName || "background") + extFor(blob.type) });
      await VRStore.MediaDB.put("a_" + meta.id, blob);
      if (VRStore.bg.pano === localId) VRStore.setBg({ pano: "a_" + meta.id, preset: VRStore.bg.preset });
    } catch (e) { say(e.status === 415 ? "Backgrounds must be JPEG, PNG or WebP pictures." : "Couldn't upload that background: " + e.message); }
    finally { panoUp.delete(localId); }
  }
  // what the world asks for when it needs the file behind an "a_<assetId>" id
  const mediaP = new Map(), manifestC = new Map(); let dlBusy = 0; const dlQ = [];
  function fetchMedia(id) {
    if (mediaP.has(id)) return mediaP.get(id);
    const p = (async () => {
      const local = await VRStore.MediaDB.get(id); if (local) return local; // another window of this browser already has it
      const assetId = id.slice(2);
      for (let t = 0; t < 4; t++) {
        try {
          await new Promise(res => { const go = () => { if (dlBusy < 4) { dlBusy++; res(); } else dlQ.push(go); }; go(); });
          try {
            let man = manifestC.get(assetId);
            if (!man) { const r = await Api.manifests([assetId]); man = r.items && r.items[0]; if (!man) return null; manifestC.set(assetId, man); }
            const vs = man.variants || [], pick = (n, f) => vs.find(v => v.name === n && (!f || v.format === f));
            const v = (pick("original") && pick("original").bytes <= 6e6 ? pick("original") : null) || pick("large", "webp") || pick("large") || pick("medium") || pick("original") || vs[0];
            if (!v) return null;
            const blob = await Api.fetchVariant(v.proxyPath);
            const typed = blob.type && blob.type !== "application/octet-stream" ? blob : new Blob([blob], { type: v.mimeType });
            await VRStore.MediaDB.put(id, typed); return typed;
          } finally { dlBusy--; const n = dlQ.shift(); n && n(); }
        } catch (e) { if (e.status === 404 || e.status === 403) return null; await new Promise(r => setTimeout(r, 700 * (t + 1))); }
      }
      return null;
    })().then(b => { if (!b) mediaP.delete(id); return b; });
    mediaP.set(id, p); return p;
  }
  function prefetch(m) { m.items.forEach(i => { if (i.mediaId && String(i.mediaId).startsWith("a_")) fetchMedia(i.mediaId); }); if (m.bg.pano && String(m.bg.pano).startsWith("a_")) fetchMedia(m.bg.pano); }
  function rejects(file, isV, isI) {
    if (!canEdit()) return "";
    if (isV) return "Videos can't be shared through the backend yet (it stores pictures only). Add a picture or text instead.";
    if (isI && !/^image\/(jpeg|png|webp)$/.test(file.type)) return `“${file.name}” is ${file.type.replace("image/", "").toUpperCase()}. The backend takes JPEG, PNG and WebP pictures.`;
    return "";
  }

  /* ------------------------------------------------------------ account + worlds (creator) */
  async function loadGalleries() { try { st.galleries = (await Api.listGalleries()).items || []; } catch (e) { if (e.status === 401) await dropSession(); } emit(); }
  async function dropSession() { st.user = null; st.galleries = []; await closeGallery(true); emit(); }
  async function afterAuth(user) {
    st.user = user; st.authErr = ""; await loadGalleries();
    if (boot.kind === "invite") { try { const r = await Api.acceptInvitation(boot.token); say("You joined the world."); history.replaceState(null, "", "/"); await loadGalleries(); return openGallery(r.galleryId); } catch (e) { say(e.message); } }
    if (boot.kind === "editor" && boot.editJoin && boot.link) { try { await Api.joinWithEditLink(boot.galleryId, boot.link); history.replaceState(null, "", "/"); await loadGalleries(); return openGallery(boot.galleryId); } catch (e) { say(e.message); } }
    const want = (boot.kind === "editor" && boot.galleryId) || LS.get("mw.gallery");
    if (want && (st.galleries.some(g => g.id === want) || boot.kind === "editor")) { try { await openGallery(want); } catch (e) { LS.set("mw.gallery", ""); st.err = e.message; } }
  }
  async function signIn(username, password, register, displayName) {
    st.busy = "auth"; st.authErr = ""; emit();
    try { const u = register ? await Api.register(username, password, displayName) : await Api.login(username, password); await afterAuth(u); }
    catch (e) { st.authErr = e.code === "INVALID_CREDENTIALS" ? "That username and password don't match." : e.code === "USERNAME_TAKEN" ? "That username is taken. Try another, or sign in." : e.code === "VALIDATION_FAILED" ? "Use 3–30 letters, numbers, . _ - for the username and at least 8 characters for the password." : e.message; }
    st.busy = ""; emit();
  }
  async function signOut() { await closeGallery(true); await Api.logout(); LS.set("mw.gallery", ""); location.href = "/"; }
  async function closeGallery(quiet) {
    clearTimeout(pushT); if (live) { live.close(); live = null; }
    if (st.gallery && !quiet) VRStore.setPersist(true);
    st.gallery = null; st.live = "off"; st.sync = "idle"; st.sharing = null; st.pair = null; conv = null; mirror = emptyScene(); rev = 0; gid = "";
  }
  async function openGallery(id, o = {}) {
    st.busy = "open"; emit();
    try {
      await closeGallery(true);
      const [g, sc] = await Promise.all([Api.getGallery(id), Api.getScene(id)]);
      // the world summary says editors may use the assistant; this asks whether the server's assistant is actually switched on
      try { const c = await Api.galleryCaps(id); g.capabilities = { ...g.capabilities, canUseAssistant: !!c.canUseAssistant }; } catch {}
      gid = id; st.gallery = g; st.readOnly = !g.capabilities.canEdit; mirror = clone(sc.scene); rev = sc.revision; st.rev = rev;
      LS.set("mw.gallery", id); VRStore.setPersist(false);
      if (o.adopt) { /* keep the dome on screen: it becomes this world */ VRStore.state.items.forEach(queueUpload); }
      else if (SM.hasDome(mirror) || SM.hasContent(mirror)) applyToModel(mirror);
      else { VRStore.sync({ view: { dome: 4.5 }, bg: VRData.presetBg("lastLight"), items: VRStore.state.items.filter(i => !SM.pushable(i) && i.type === "video") }); }
      connectLive(g.capabilities.canEdit ? "edit" : "view", "user");
      if (g.capabilities.canManage) { loadSharing().catch(() => {}); }
      st.sync = "saved"; if (o.adopt) schedulePush(50);
    } finally { st.busy = ""; emit(); }
  }
  async function createGallery(title, fromThisDome) {
    st.busy = "open"; emit();
    try { const g = await Api.createGallery(title || "My World", "blank"); await loadGalleries(); await openGallery(g.id, { adopt: !!fromThisDome }); }
    catch (e) { say(e.message); } finally { st.busy = ""; emit(); }
  }
  async function deleteGallery(id) { try { await Api.deleteGallery(id); if (gid === id) { await closeGallery(); LS.set("mw.gallery", ""); } await loadGalleries(); } catch (e) { say(e.message); } }

  /* ------------------------------------------------------------ sharing: the QR code */
  async function loadSharing() { st.sharing = await Api.getSharing(gid); emit(); return st.sharing; }
  async function setShareMode(mode) { try { st.sharing = await Api.setSharing(gid, mode); st.gallery.sharingMode = mode; } catch (e) { say(e.message); } emit(); }
  async function rotate() { try { st.sharing = await Api.rotateLinks(gid, "both"); st.pair = null; say("Old links and QR codes stopped working. This is the new one."); } catch (e) { say(e.message); } emit(); }
  async function newPairing() {
    try { const r = await Api.createViewerSession(gid, { kind: "preview", auth: "user" }); st.pair = { code: r.pairingCode, url: r.pairingUrl, expiresAt: Date.parse(r.pairingExpiresAt), sessionId: r.viewerSessionId }; }
    catch (e) { say(e.message); }
    emit();
  }
  // the address a phone should open: this page's own address, or your Wi-Fi address when you're on "localhost"
  function phoneOrigin() {
    const custom = LS.get("mw.public") || (st.info && st.info.publicUrl);
    if (custom) return custom.replace(/\/+$/, "");
    if (/^(localhost|127\.|\[::1\])/.test(location.hostname) && st.info && st.info.lan && st.info.lan.length) return `${location.protocol}//${st.info.lan[0]}:${st.info.port || location.port || (location.protocol === "https:" ? 443 : 80)}`;
    return location.origin;
  }
  function setPublic(v) { v = String(v || "").trim(); if (v && !/^https?:\/\/[^\s/]+/i.test(v)) return false; LS.set("mw.public", v.replace(/\/+$/, "")); emit(); return true; }
  function phoneURL(kind, mode) {
    let path = "";
    if (kind === "pair") { if (!st.pair) return ""; path = `/p/${encodeURIComponent(st.pair.code)}`; }
    else { if (!st.sharing || !st.sharing.viewUrl) return ""; const u = new URL(st.sharing.viewUrl, location.href); path = u.pathname + u.search; } // the backend's own link, re-pointed at an address the phone can reach
    return phoneOrigin() + path + (mode && mode !== "look" ? (path.includes("?") ? "&" : "?") + "vr=" + mode : "");
  }
  const phoneNeedsHttps = () => !/^https:/i.test(phoneOrigin()) && !/^http:\/\/(localhost|127\.)/i.test(phoneOrigin());

  /* ------------------------------------------------------------ phone / visitor */
  function joinEnd(kind, title, msg) { st.join = kind; st.joinTitle = title; st.joinMsg = msg; emit(); }
  function setJoinLive() {
    st.join = SM.hasContent(mirror) || SM.hasDome(mirror) ? "live" : "waiting";
    emit();
  }
  async function joinFlow() {
    st.join = "connecting"; emit();
    try {
      if (!st.available) return joinEnd("offline", "Can't reach the world", "The server isn't answering. We keep trying."), retryJoin();
      let galleryId;
      if (boot.kind === "pairing") {
        const key = "mw.vs." + boot.code; let c = null; try { c = JSON.parse(Api.session.get(key) || "null"); } catch {}
        if (!c) { const r = await Api.claimPairing(boot.code); c = { t: r.viewerToken, g: r.galleryId }; Api.session.set(key, JSON.stringify(c)); }
        Api.setViewerToken(c.t); galleryId = c.g;
      } else {
        const res = await Api.resolveLink(location.origin + location.pathname + (boot.link ? "?link=" + encodeURIComponent(boot.link) : ""));
        if (res.next === "sign_in") return joinEnd("signin", "This world is private", "Ask the creator for a QR code or a share link made for phones.");
        if (res.next !== "open") return joinEnd("denied", "Can't open this link", "Ask the creator for a new QR code.");
        galleryId = res.galleryId;
        const vs = await Api.createViewerSession(galleryId, { kind: "viewer", link: res.linkToken || boot.link || undefined });
        Api.setViewerToken(vs.viewerToken);
      }
      gid = galleryId;
      try { const g = await Api.getGallery(gid); st.title = g.title; } catch {}
      connectLive("view", "viewer");
    } catch (e) {
      if (e.code === "LINK_DISABLED") joinEnd("denied", "This link or code has been used or turned off", "QR pairing codes work once and expire after a few minutes. Ask the creator to show a new one.");
      else if (e.status === 404) joinEnd("denied", "That world isn't there", "The creator may have deleted it, or the link is wrong.");
      else if (e.status === 0 || e.status >= 500) { joinEnd("offline", "Can't reach the world", e.message); retryJoin(); }
      else joinEnd("denied", "Can't open this world", e.message);
    }
  }
  let rj = 0; function retryJoin() { clearTimeout(rj); rj = setTimeout(async () => { st.available = await Api.health(); joinFlow(); }, 4000); }
  Api.subscribe(ev => { if (ev.type === "viewer-expired" && isJoin) { Api.session.set("mw.vs." + boot.code, null); joinFlow(); } if (ev.type === "signedout" && !isJoin) { st.user = null; closeGallery(true); emit(); } });

  /* ------------------------------------------------------------ assistant */
  let conv = null; const waiters = new Map();
  function onAssistant(cmd) { const w = waiters.get(cmd.id); if (w && cmd.final) { waiters.delete(cmd.id); w(cmd); } }
  async function conversation(language) {
    if (conv && conv.language === language && conv.galleryId === gid) return conv;
    conv = await Api.createConversation(gid, language); return conv;
  }
  async function waitFor(cmd) {
    if (cmd.final) return cmd;
    return new Promise(resolve => {
      let done = false; const fin = c => { if (!done) { done = true; resolve(c); } };
      waiters.set(cmd.id, fin);
      (async () => { for (let i = 0; i < 90 && !done; i++) { await new Promise(r => setTimeout(r, i < 5 ? 600 : 1500)); if (done) return; try { const c = await Api.getCommand(cmd.id); if (c.final) { waiters.delete(cmd.id); return fin(c); } } catch (e) { if (e.status === 404) return fin({ ...cmd, status: "failed", final: true, error: { code: "NOT_FOUND", message: e.message } }); } } fin({ ...cmd, status: "failed", final: true, error: { code: "TIMEOUT", message: "The assistant took too long." } }); })();
    });
  }
  async function ask({ text, language, muted, selected }) {
    const c = await conversation(language);
    const cmd = await Api.sendCommand(c.id, { requestId: Api.uuid(), text, language, audioEnabled: !muted, ...(selected ? { selectedNodeIds: [selected] } : {}) });
    return waitFor(cmd);
  }
  async function askVoice({ blob, language, muted, selected, durationMs }) {
    const c = await conversation(language);
    const cmd = await Api.sendVoice(c.id, blob, { requestId: Api.uuid(), language, audioEnabled: muted ? "false" : "true", ...(selected ? { selectedNodeIds: [selected] } : {}), ...(durationMs ? { durationMs: String(Math.round(durationMs)) } : {}) });
    return waitFor(cmd);
  }
  async function undo() { const r = await Api.undo(gid); if (r.revision > rev) { try { await catchUp(); } catch {} } return r; }
  const assistantReady = () => !!st.gallery && !st.readOnly && !!(st.gallery.capabilities && st.gallery.capabilities.canUseAssistant);

  /* ------------------------------------------------------------ start */
  const ready = (async () => {
    if (!web) { st.checked = true; emit(); return st; }
    st.available = await Api.health(); st.checked = true; st.info = await Api.info(); emit();
    if (isJoin) { joinFlow(); return st; }
    if (VRStore.viewerMode) return st; // the pop-out window follows the editor window directly
    VRStore.subscribe(onStore);
    if (st.available && (Api.hasRefresh() || Api.signedIn)) { try { await afterAuth(await Api.me()); } catch (e) { if (e.status === 401) st.user = null; else st.err = e.message; } }
    emit(); return st;
  })();
  // if the server wasn't up when the page loaded, keep looking for it
  setInterval(async () => { if (!st.available && web && !isJoin) { st.available = await Api.health(); if (st.available) { st.info = await Api.info(); emit(); } } }, 6000);

  return {
    state: st, ready, subscribe: f => { subs.add(f); return () => subs.delete(f); },
    signIn, signOut, openGallery, createGallery, deleteGallery, closeGallery: () => closeGallery(false).then(emit), loadGalleries, renameGallery: async (t) => { try { st.gallery = { ...st.gallery, ...(await Api.renameGallery(gid, t)) }; await loadGalleries(); } catch (e) { say(e.message); } emit(); },
    loadSharing, setShareMode, rotate, newPairing, phoneURL, phoneOrigin, setPublic, phoneNeedsHttps,
    fetchMedia, rejects, ask, askVoice, undo, assistantReady, push: schedulePush, flush: push,
    get connected() { return !!st.gallery; }, get editing() { return canEdit(); },
    _debug: () => ({ mirror, rev, gid, live, st }),
  };
})();
