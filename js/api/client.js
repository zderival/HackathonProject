/* API: the browser's connection to the backend (everything under /v1, same address as this page).
   - signs in, keeps the short-lived access token fresh with the single-use refresh token, retries once after a 401
   - turns the backend's error envelope { error: { code, message, details, requestId } } into a normal Error
   - Live: the gallery WebSocket (ticket -> hello -> snapshot -> ops), with heartbeat, backoff and the close codes from
     backend/docs/websocket-protocol.md
   Only tokens are kept in the browser (never passwords or AI keys). */
const Api = (() => {
  const LS = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const SS = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} } };
  const AUTH = "mw.auth";
  const st = { tokens: null, viewerToken: "", lang: LS.get("mw.lang") || "en" };
  const subs = new Set(); const emit = ev => subs.forEach(f => { try { f(ev); } catch (e) { console.error(e); } });
  try { st.tokens = JSON.parse(LS.get(AUTH) || "null"); } catch {}

  class ApiError extends Error {
    constructor(status, env, fallback) { const e = (env && env.error) || {}; super(e.message || fallback || `Request failed (${status})`); this.name = "ApiError"; this.status = status; this.code = e.code || (status === 0 ? "NETWORK" : "ERROR"); this.details = e.details ?? null; this.requestId = e.requestId || null; }
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
  const saveTokens = t => { st.tokens = t; LS.set(AUTH, t ? JSON.stringify(t) : null); };

  let refreshing = null;
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const rt = st.tokens && st.tokens.refreshToken; if (!rt) throw new ApiError(401, null, "Signed out");
      const r = await fetch("/v1/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: rt }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { saveTokens(null); emit({ type: "signedout" }); throw new ApiError(r.status, j, "Your session ended. Sign in again."); }
      saveTokens(j.tokens); return j.tokens;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  const expSoon = () => st.tokens && st.tokens.accessExpiresAt && Date.parse(st.tokens.accessExpiresAt) - Date.now() < 20000;

  /* auth: "user" (default when signed in), "viewer" (phone), "none" */
  async function req(method, path, o = {}) {
    const auth = o.auth || (st.viewerToken ? "viewer" : st.tokens ? "user" : "none");
    const useViewer = auth === "viewer" && st.viewerToken;
    if (auth === "user" && st.tokens && expSoon() && st.tokens.refreshToken) { try { await refresh(); } catch {} }
    const go = async () => {
      const h = { accept: "application/json", "accept-language": st.lang, ...(o.headers || {}) };
      if (useViewer) h.authorization = "Bearer " + st.viewerToken; else if (auth === "user" && st.tokens) h.authorization = "Bearer " + st.tokens.accessToken;
      if (o.link) h["x-gallery-link"] = o.link;
      let body = o.form || undefined;
      if (o.body !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(o.body); }
      const qs = o.query ? "?" + new URLSearchParams(Object.entries(o.query).filter(([, v]) => v != null)).toString() : "";
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), o.timeout ?? 30000);
      try { return await fetch(path + qs, { method, headers: h, body, signal: ctl.signal }); }
      catch (e) { throw new ApiError(0, null, e.name === "AbortError" ? "The server took too long to answer." : "Can't reach the server. Check your connection."); }
      finally { clearTimeout(t); }
    };
    let r = await go();
    if (r.status === 401 && auth === "user" && st.tokens && st.tokens.refreshToken) { try { await refresh(); r = await go(); } catch (e) { if (e instanceof ApiError && e.status !== 0) throw e; throw e; } }
    if (o.raw) { if (!r.ok) { const j = await r.json().catch(() => null); throw new ApiError(r.status, j); } return r; }
    if (r.status === 204) return null;
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
      const err = new ApiError(r.status, j);
      if (r.status === 401 && auth === "viewer") emit({ type: "viewer-expired" });
      throw err;
    }
    return j;
  }
  const get = (p, o) => req("GET", p, o), post = (p, body, o) => req("POST", p, { ...o, body: body ?? {} }), put = (p, body, o) => req("PUT", p, { ...o, body }), patch = (p, body, o) => req("PATCH", p, { ...o, body }), del = (p, o) => req("DELETE", p, o);

  const api = {
    ApiError, uuid, subscribe: f => { subs.add(f); return () => subs.delete(f); },
    get signedIn() { return !!(st.tokens && st.tokens.accessToken); }, get isViewer() { return !!st.viewerToken; },
    setViewerToken(t) { st.viewerToken = t || ""; }, setLang(l) { st.lang = l; LS.set("mw.lang", l); },
    session: { get: k => SS.get(k), set: (k, v) => SS.set(k, v) },
    health: async () => { const c = new AbortController(), t = setTimeout(() => c.abort(), 3500); try { const r = await fetch("/health", { signal: c.signal, cache: "no-store" }); const j = await r.json().catch(() => null); return r.ok && j && j.status === "ok"; } catch { return false; } finally { clearTimeout(t); } },
    info: async () => { try { const r = await fetch("/__info", { cache: "no-store" }); return r.ok ? await r.json() : null; } catch { return null; } },

    /* auth */
    async register(username, password, displayName) { const j = await post("/v1/auth/register", { username, password, ...(displayName ? { displayName } : {}) }, { auth: "none" }); saveTokens(j.tokens); return j.user; },
    async login(username, password) { const j = await post("/v1/auth/login", { username, password }, { auth: "none" }); saveTokens(j.tokens); return j.user; },
    async logout() { try { if (st.tokens) await post("/v1/auth/logout", {}, { auth: "user" }); } catch {} saveTokens(null); },
    me: () => get("/v1/auth/me", { auth: "user" }),
    hasRefresh: () => !!(st.tokens && st.tokens.refreshToken),

    /* galleries and the scene */
    listGalleries: () => get("/v1/galleries", { auth: "user", query: { limit: 100 } }),
    createGallery: (title, template = "blank", description) => post("/v1/galleries", { title, template, ...(description ? { description } : {}) }, { auth: "user" }),
    getGallery: (id, o) => get(`/v1/galleries/${id}`, o),
    renameGallery: (id, title) => patch(`/v1/galleries/${id}`, { title }, { auth: "user" }),
    deleteGallery: id => del(`/v1/galleries/${id}`, { auth: "user" }),
    galleryCaps: id => get(`/v1/galleries/${id}/capabilities`, { auth: "user" }),
    getScene: (id, o) => get(`/v1/galleries/${id}/scene`, o),
    submit: (id, body) => post(`/v1/galleries/${id}/actions`, body, { auth: "user" }),
    undo: (id, requestId = uuid()) => post(`/v1/galleries/${id}/undo`, { requestId }, { auth: "user" }),
    redo: (id, requestId = uuid()) => post(`/v1/galleries/${id}/redo`, { requestId }, { auth: "user" }),
    events: (id, after, o) => get(`/v1/galleries/${id}/events`, { ...o, query: { after } }),

    /* assets (images: JPEG, PNG, WebP) */
    async uploadAsset(galleryId, blob, meta = {}) {
      const f = new FormData(); // text fields first, then the file, as the backend expects
      f.append("title", (meta.title || "").slice(0, 200)); f.append("description", (meta.description || "").slice(0, 2000)); f.append("attribution", (meta.attribution || "").slice(0, 300));
      f.append("file", blob, meta.filename || "upload");
      return req("POST", `/v1/galleries/${galleryId}/assets`, { auth: "user", form: f, timeout: 120000 });
    },
    manifests: (assetIds, o) => post("/v1/assets/manifests", { assetIds }, o),
    async fetchVariant(proxyPath, o = {}) { const r = await req("GET", proxyPath, { ...o, raw: true, timeout: 120000 }); return r.blob(); },

    /* sharing, phones, links */
    getSharing: id => get(`/v1/galleries/${id}/sharing`, { auth: "user" }),
    setSharing: (id, mode) => put(`/v1/galleries/${id}/sharing`, { mode }, { auth: "user" }),
    rotateLinks: (id, links = "both") => post(`/v1/galleries/${id}/sharing/rotate`, { links }, { auth: "user" }),
    createViewerSession: (id, o = {}) => post(`/v1/galleries/${id}/viewer-sessions`, { kind: o.kind || "viewer" }, { auth: o.auth, link: o.link }),
    claimPairing: code => post("/v1/pairings/claim", { code }, { auth: "none" }),
    resolveLink: (url, o) => get("/v1/links/resolve", { ...o, query: { url } }),
    joinWithEditLink: (id, link) => post(`/v1/galleries/${id}/join`, { link }, { auth: "user" }),
    acceptInvitation: token => post("/v1/invitations/accept", { token }, { auth: "user" }),
    realtimeTicket: (id, capability, o) => post(`/v1/galleries/${id}/realtime-tickets`, { capability }, o),

    /* assistant */
    createConversation: (galleryId, language) => post(`/v1/galleries/${galleryId}/assistant/conversations`, { language }, { auth: "user" }),
    sendCommand: (cid, body) => post(`/v1/assistant/conversations/${cid}/commands`, body, { auth: "user" }),
    async sendVoice(cid, blob, f) {
      const fd = new FormData(); // requestId and other text fields before the audio part
      Object.entries(f).forEach(([k, v]) => fd.append(k, typeof v === "string" ? v : JSON.stringify(v))); fd.append("audio", blob, "voice");
      return req("POST", `/v1/assistant/conversations/${cid}/voice-commands`, { auth: "user", form: fd, timeout: 60000 });
    },
    getCommand: id => get(`/v1/assistant/commands/${id}`, { auth: "user" }),
    cancelCommand: id => post(`/v1/assistant/commands/${id}/cancel`, {}, { auth: "user" }),
    speechAudio: id => req("GET", `/v1/assistant/commands/${id}/speech/audio`, { auth: "user", raw: true }).then(r => r.blob()),
  };

  /* ------------------------------------------------------------------ Live: the gallery WebSocket */
  class Live {
    /* opts: { galleryId, capability: "edit"|"view", auth: "user"|"viewer", link, on: { hello, snapshot, ops, ack, error, permissions, assistant, state } } */
    constructor(o) { this.o = o; this.on = o.on || {}; this.ws = null; this.closed = false; this.tries = 0; this.rev = 0; this.hb = 20000; this.lastSeen = 0; this.timers = []; this.connect(); }
    state(s, extra) { this.status = s; this.on.state && this.on.state(s, extra); }
    async connect() {
      if (this.closed) return; this.state(this.tries ? "reconnecting" : "connecting");
      let t;
      try { t = await api.realtimeTicket(this.o.galleryId, this.o.capability, { auth: this.o.auth, link: this.o.link }); }
      catch (e) {
        if (e.status === 404 || e.status === 403 || e.status === 410) { this.closed = true; this.state("denied", e); return; }
        return this.retry();
      }
      // The backend builds this URL from PUBLIC_API_URL (often "localhost"). Reuse only the path and query, so it works from a phone too.
      let u; try { u = new URL(t.url); } catch { u = new URL(t.url, location.href); }
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${u.pathname}${u.search}`);
      this.ws = ws; let opened = false;
      ws.onopen = () => { opened = true; this.lastSeen = Date.now(); };
      ws.onmessage = e => {
        this.lastSeen = Date.now(); let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "hello") { this.hb = Math.max(5000, m.heartbeatMs || 25000) * .8; this.tries = 0; this.caps = m; this.state("live"); this.ping(); }
        this.on[m.type] && this.on[m.type](m);
      };
      ws.onclose = e => {
        clearTimeout(this.pt); if (this.ws !== ws) return; this.ws = null;
        if (this.closed) return;
        if (e.code === 4403 || e.code === 4029) { this.closed = true; this.state(e.code === 4403 ? "revoked" : "full", e); return; }
        this.state("reconnecting", e); this.retry(e.code === 4008 ? 300 : 0);
      };
      ws.onerror = () => { if (!opened) { /* onclose follows */ } };
    }
    retry(min = 0) { if (this.closed) return; this.tries++; const d = Math.max(min, Math.min(10000, 400 * 2 ** Math.min(this.tries, 5)) * (.6 + Math.random() * .8)); clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), d); }
    ping() {
      clearTimeout(this.pt);
      this.pt = setTimeout(() => {
        if (!this.ws || this.ws.readyState !== 1) return;
        if (Date.now() - this.lastSeen > this.hb * 3) { try { this.ws.close(); } catch {} return; }
        this.send({ type: "ping", t: Date.now() }); this.ping();
      }, this.hb);
    }
    send(m) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; } return false; }
    resync(fromRevision) { return this.send(fromRevision == null ? { type: "resync" } : { type: "resync", fromRevision }); }
    reconnectNow() { if (this.closed) return; if (this.ws && this.ws.readyState === 1) return; clearTimeout(this.rt); this.connect(); }
    close() { this.closed = true; clearTimeout(this.pt); clearTimeout(this.rt); try { this.ws && this.ws.close(1000); } catch {} this.ws = null; }
  }
  api.Live = Live;
  return api;
})();
