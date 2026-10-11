/* VR STORE
   Everything the creator edits lives here: the list of media, the background, and the dome size.
   - Your files are saved byte-for-byte in IndexedDB (never re-encoded, resized or filtered).
   - The scene description (positions, sizes, text, colors) is small JSON in localStorage.
   - Every change is broadcast, so a second window (the pop-out viewer) updates while you edit. */
const VRStore = (() => {
  const { DEFAULT_BG, presetBg } = VRData;
  const KEY = "mya.scene.v1", CHANNEL = "mya-world-live";
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------------- media files (IndexedDB, with an in-memory fallback) ---------------- */
  const MediaDB = (() => {
    const mem = new Map(); let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error("no indexedDB"));
      const r = indexedDB.open("mya-world", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("media");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("media", mode); const rq = fn(t.objectStore("media")); t.oncomplete = () => res(rq && rq.result); t.onerror = t.onabort = () => rej(t.error); }); };
    return {
      async put(id, blob) { mem.set(id, blob); try { await tx("readwrite", s => s.put(blob, id)); return true; } catch { return false; } },
      async get(id) { if (mem.has(id)) return mem.get(id); try { const b = await tx("readonly", s => s.get(id)); if (b) mem.set(id, b); return b || null; } catch { return null; } },
      async del(id) { mem.delete(id); try { await tx("readwrite", s => s.delete(id)); } catch {} },
    };
  })();

  /* ---------------- scene ---------------- */
  const newItem = (o = {}) => ({ id: uid(), type: "image", name: "", az: 0, h: 1.6, d: 3.3, size: 1.3, tilt: 0, frame: "none", caption: false, hidden: false, ...o });
  function seed() {
    const items = []; const pick = [3, 7, 1, 5, 10, 12];
    // six gallery pieces, evenly spread in front of you (no video: the creator adds their own)
    pick.forEach((pi, i) => { const p = piece(pi); items.push(newItem({ type: "image", name: p.t, src: p.thumb, ar: p.ar, az: Math.round((i - (pick.length - 1) / 2) * 34), h: 1.55 + (i % 3) * .1, d: 3.3, size: 1.25 })); });
    return { v: 1, rev: 1, view: { dome: 4.5 }, bg: presetBg("lastLight"), items };
  }
  function normalize(s) {
    if (!s || typeof s !== "object") return seed();
    s.view = { dome: clamp(+(s.view && s.view.dome) || 4.5, 3, 10) };
    s.bg = { ...DEFAULT_BG, ...(s.bg || {}) };
    s.items = (Array.isArray(s.items) ? s.items : []).filter(i => i && typeof i === "object")
      .filter(i => !/(^|\/)media\/timelapse\./.test(String(i.src || "")) && !/(^|\/)media\/timelapse\./.test(String(i.src2 || ""))) // the old sample video was removed
      .map(i => ({ ...newItem(), ...i }));
    return s;
  }
  function load() { try { const raw = localStorage.getItem(KEY); return raw ? normalize(JSON.parse(raw)) : null; } catch { return null; } }

  const qs = new URLSearchParams(location.search), boot = window.MW_BOOT || {};
  // joinMode = a visitor (usually a phone that scanned the QR code) following the creator's world live through the backend
  const joinMode = !!boot.join;
  const viewerMode = qs.get("view") === "world" || joinMode;
  const emptyScene = () => ({ v: 1, rev: 0, view: { dome: 4.5 }, bg: presetBg("lastLight"), items: [] });
  let state = joinMode ? emptyScene() : (load() || seed());
  const subs = new Set(), me = uid();
  let ch = null; try { ch = "BroadcastChannel" in window && !joinMode ? new BroadcastChannel(CHANNEL) : null; } catch {}

  const emit = ev => subs.forEach(f => { try { f(ev); } catch (e) { console.error(e); } });
  let saveT = 0, persistOn = true;
  function persist() {
    if (viewerMode || !persistOn) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { toastOnce("Couldn't save to this browser (storage is full or blocked)."); } }, 160);
  }
  let warned = false; const toastOnce = m => { if (!warned) { warned = true; if (typeof toast === "function") toast(m); } };
  const say = msg => { if (ch && !viewerMode) ch.postMessage({ ...msg, from: me }); };
  // Slider drags fire many times a second: send only the latest patch per frame.
  const pend = new Map(); let pendT = 0;
  function sayPatch(key, msg) { pend.set(key, msg); if (!pendT) pendT = setTimeout(() => { pendT = 0; pend.forEach(m => say(m)); pend.clear(); }, 24); }

  const find = id => state.items.find(i => i.id === id);

  function merge(target, patch) { Object.keys(patch).forEach(k => { target[k] = patch[k]; }); }

  const API = {
    viewerMode, joinMode,
    get state() { return state; }, get items() { return state.items; }, get bg() { return state.bg; }, get view() { return state.view; },
    item: find,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    MediaDB, newItem,

    async addFiles(files) {
      const added = [];
      for (const f of [...files]) {
        const isV = f.type.startsWith("video/"), isI = f.type.startsWith("image/");
        const isT = f.type.startsWith("text/") || /\.(txt|md)$/i.test(f.name);
        if (!isV && !isI && !isT) { toast(`“${f.name}” isn't a picture, video or text file`); continue; }
        const why = typeof Cloud !== "undefined" && Cloud.rejects ? Cloud.rejects(f, isV, isI) : ""; // connected worlds hold JPEG/PNG/WebP pictures and text
        if (why) { toast(why); continue; }
        const name = f.name.replace(/\.[^.]+$/, "").slice(0, 60);
        if (isT) { const body = (await f.text()).slice(0, 4000); added.push(API.addItem({ type: "text", name, text: { ...TEXT_DEFAULTS, body } })); continue; }
        const id = uid(), ok = await MediaDB.put(id, f);
        if (!ok) toast("Saved for this visit only: your browser wouldn't keep the file.");
        const probe = await probeMedia(f, isV);
        if (!probe) { toast(`Couldn't read “${f.name}”. Try a different format.`); MediaDB.del(id); continue; }
        added.push(API.addItem({ type: isV ? "video" : "image", name, mediaId: id, mime: f.type, ar: probe.ar, bytes: f.size }, true));
      }
      return added;
    },
    addItem(partial, mediaReady) {
      const d = Math.min(3.3, state.view.dome * .74), size = partial.size || 1.3, ar = partial.ar || 1;
      const halfDeg = (it2, dist) => Math.atan((ar2(it2) >= 1 ? it2.size : it2.size * ar2(it2)) / 2 / Math.max(dist, .5)) * 180 / Math.PI;
      const ar2 = x => x.ar || 1;
      const myHalf = halfDeg({ size, ar }, d);
      // pick the open spot closest to straight ahead, so new things never land on top of old ones
      let best = 0, bestGap = -1, found = false;
      const cands = [0]; for (let a = 8; a <= 172; a += 8) cands.push(a, -a);
      for (const c of cands) {
        let gap = 1e9; state.items.forEach(o => { const dd = Math.abs(((c - o.az + 540) % 360) - 180); gap = Math.min(gap, dd - halfDeg(o, o.d) - myHalf); });
        if (gap >= 3) { best = c; found = true; break; }
        if (gap > bestGap) { bestGap = gap; best = c; }
      }
      const it = newItem({ az: best, d, ...partial });
      state.items.push(it); state.rev++; persist();
      emit({ type: "items", added: it.id }); say({ type: "scene", scene: state, added: it.id, media: !!mediaReady });
      return it;
    },
    update(id, patch, o = {}) {
      const it = find(id); if (!it) return;
      merge(it, patch); persist();
      emit({ type: "item", id, patch, remote: false });
      sayPatch("i" + id, { type: "item", id, patch });
    },
    remove(id) {
      const i = state.items.findIndex(x => x.id === id); if (i < 0) return;
      const [it] = state.items.splice(i, 1); if (it.mediaId && !state.items.some(x => x.mediaId === it.mediaId)) MediaDB.del(it.mediaId);
      state.rev++; persist(); emit({ type: "items", removed: id }); say({ type: "scene", scene: state });
    },
    duplicate(id) { const it = find(id); if (!it) return null; const c = { ...JSON.parse(JSON.stringify(it)), id: uid(), name: it.name ? it.name + " copy" : "", az: clamp(it.az + 14, -179, 179) }; state.items.push(c); state.rev++; persist(); emit({ type: "items", added: c.id }); say({ type: "scene", scene: state }); return c; },
    setBg(patch) { merge(state.bg, patch); if (!("preset" in patch)) state.bg.preset = "custom"; persist(); emit({ type: "bg", patch }); sayPatch("bg", { type: "bg", bg: state.bg }); },
    applyPreset(k) { state.bg = { ...presetBg(k), pano: state.bg.pano, panoName: state.bg.panoName }; if ((VRData.PRESETS[k] || {}).skyMode == null) state.bg.skyMode = "procedural"; persist(); emit({ type: "bg", patch: state.bg, all: true }); say({ type: "bg", bg: state.bg }); },
    async setPano(file) {
      const id = uid(); await MediaDB.put(id, file);
      const old = state.bg.pano; state.bg.pano = id; state.bg.panoName = file.name; state.bg.skyMode = "panorama"; state.bg.preset = "custom";
      if (old) MediaDB.del(old);
      persist(); emit({ type: "bg", patch: { pano: id }, all: true }); say({ type: "bg", bg: state.bg, media: true });
    },
    clearPano() { const old = state.bg.pano; if (old) MediaDB.del(old); state.bg.pano = ""; state.bg.panoName = ""; state.bg.skyMode = "procedural"; persist(); emit({ type: "bg", patch: { pano: "" }, all: true }); say({ type: "bg", bg: state.bg }); },
    setDome(r) {
      r = clamp(r, 3, 10); const k = r / state.view.dome; state.view.dome = r;
      state.items.forEach(i => { i.d = clamp(i.d * k, .8, r - .3); i.h = Math.min(i.h, r * .95); });
      persist(); emit({ type: "view" }); say({ type: "scene", scene: state });
    },
    reset() { state.items.forEach(i => i.mediaId && MediaDB.del(i.mediaId)); if (state.bg.pano) MediaDB.del(state.bg.pano); state = seed(); persist(); emit({ type: "reset" }); say({ type: "scene", scene: state }); },
    clearAll() { state.items.forEach(i => i.mediaId && MediaDB.del(i.mediaId)); state.items = []; state.rev++; persist(); emit({ type: "items" }); say({ type: "scene", scene: state }); },
    flush() { clearTimeout(saveT); try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} },

    /* ---- incoming (other window) ---- */
    receive(m) {
      if (!m || m.from === me) return;
      if (m.type === "hello" && !viewerMode) { say({ type: "scene", scene: state, media: true }); return; }
      if (m.type === "scene") { state = normalize(m.scene); emit({ type: "reset", remote: true, media: !!m.media }); }
      else if (m.type === "item") { const it = find(m.id); if (it) { merge(it, m.patch); emit({ type: "item", id: m.id, patch: m.patch, remote: true }); } }
      else if (m.type === "bg") { state.bg = { ...DEFAULT_BG, ...m.bg }; emit({ type: "bg", patch: state.bg, all: true, remote: true }); }
    },
    hello() { if (ch) ch.postMessage({ type: "hello", from: me }); },
    // the sharing server sent a newer copy of the creator's world (join mode only)
    replace(scene) { state = normalize(scene); emit({ type: "reset", remote: true, media: true }); },
    setPersist(v) { persistOn = !!v; },
    // The backend's copy changed. Apply only what is different, item by item, so the dome moves smoothly, the selection
    // stays, and nothing reloads. Everything emitted here is flagged remote so it is never sent back.
    sync(model) {
      const m = normalize({ v: 1, rev: state.rev, view: model.view, bg: model.bg, items: model.items });
      let viewCh = false, bgCh = false, itemsCh = false;
      if (Math.abs(m.view.dome - state.view.dome) > 1e-6) { state.view.dome = m.view.dome; viewCh = true; }
      if (JSON.stringify(m.bg) !== JSON.stringify(state.bg)) { state.bg = m.bg; bgCh = true; }
      const have = new Map(state.items.map(i => [i.id, i])), want = new Set(m.items.map(i => i.id)), patches = [];
      for (const it of [...state.items]) if (!want.has(it.id)) { state.items.splice(state.items.indexOf(it), 1); itemsCh = true; }
      m.items.forEach((n, idx) => {
        const cur = have.get(n.id);
        if (!cur) { state.items.splice(Math.min(idx, state.items.length), 0, n); itemsCh = true; return; }
        const patch = {}; Object.keys(n).forEach(k => { if (JSON.stringify(n[k]) !== JSON.stringify(cur[k])) patch[k] = n[k]; });
        Object.keys(cur).forEach(k => { if (!(k in n) && k !== "mediaId" && k !== "src" && k !== "src2" && cur[k] !== undefined && ["assetId", "text"].includes(k)) patch[k] = undefined; });
        if (Object.keys(patch).length) { Object.assign(cur, patch); patches.push([cur.id, patch]); }
      });
      state.rev++;
      if (viewCh) emit({ type: "view", remote: true });
      if (bgCh) emit({ type: "bg", patch: state.bg, all: true, remote: true });
      if (itemsCh) emit({ type: "items", remote: true });
      patches.forEach(([id, patch]) => emit({ type: "item", id, patch, remote: true }));
      return viewCh || bgCh || itemsCh || patches.length > 0;
    },
    // a snapshot the editor hands to the sharing server
    snapshot() { return JSON.parse(JSON.stringify(state)); },
  };
  if (ch) ch.onmessage = e => API.receive(e.data);
  // fallback when BroadcastChannel is missing: follow localStorage changes made by the editor window
  addEventListener("storage", e => { if (e.key === KEY && e.newValue && viewerMode && !joinMode && !ch) { try { state = normalize(JSON.parse(e.newValue)); emit({ type: "reset", remote: true }); } catch {} } });

  /* ---------------- helpers ---------------- */
  const TEXT_DEFAULTS = { body: "Your words here", font: "display", weight: 700, fs: 1, color: "#f5f1ea", align: "center", card: false, cardCol: "#1b1724", cardOp: .85, width: 1 };
  API.TEXT_DEFAULTS = TEXT_DEFAULTS;

  function probeMedia(file, isV) {
    return new Promise(res => {
      const url = URL.createObjectURL(file);
      if (isV) { const v = document.createElement("video"); v.preload = "metadata"; v.muted = true; v.onloadedmetadata = () => { res(v.videoWidth ? { ar: v.videoWidth / v.videoHeight } : null); URL.revokeObjectURL(url); }; v.onerror = () => { res(null); URL.revokeObjectURL(url); }; v.src = url; }
      else { const im = new Image(); im.onload = () => { res({ ar: im.naturalWidth / im.naturalHeight || 1 }); URL.revokeObjectURL(url); }; im.onerror = () => { res(null); URL.revokeObjectURL(url); }; im.src = url; }
    });
  }

  /* ---------------- export / import (a plain .zip: scene.json + your original files) ---------------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return b => { let c = ~0; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }; })();
  const extOf = (mime, name) => ((name || "").match(/\.[a-z0-9]{2,5}$/i) || [""])[0] || ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" }[mime] || ".bin");
  async function exportZip() {
    const files = [], enc = new TextEncoder();
    const scene = JSON.parse(JSON.stringify(state)); const media = [];
    for (const it of scene.items) if (it.mediaId) { const b = await MediaDB.get(it.mediaId); if (b) { const p = `media/${it.mediaId}${extOf(it.mime, it.name)}`; files.push({ path: p, data: new Uint8Array(await b.arrayBuffer()) }); it.file = p; } }
    if (scene.bg.pano) { const b = await MediaDB.get(scene.bg.pano); if (b) { const p = `media/${scene.bg.pano}${extOf(b.type, scene.bg.panoName)}`; files.push({ path: p, data: new Uint8Array(await b.arrayBuffer()) }); scene.bg.panoFile = p; } }
    files.unshift({ path: "scene.json", data: enc.encode(JSON.stringify(scene, null, 2)) });
    return new Blob([zipStore(files)], { type: "application/zip" });
  }
  function zipStore(files) {
    const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
    files.forEach(f => {
      const name = enc.encode(f.path), crc = CRC(f.data), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
      h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      cen.push(c.buffer, name); off += 30 + name.length + f.data.length;
    });
    const cenSize = cen.reduce((a, b) => a + (b.byteLength ?? b.length), 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cenSize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...cen, end.buffer]);
  }
  async function readZip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder(), out = {};
    let e = buf.byteLength - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error("That doesn't look like a World export (.zip).");
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    for (let i = 0; i < n; i++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
      const lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true), start = lo + 30 + lnl + lxl; let data = u8.subarray(start, start + csize);
      if (method === 8) { const ds = new DecompressionStream("deflate-raw"); data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer()); }
      else if (method !== 0) throw new Error("Unsupported zip compression");
      out[name] = data;
    }
    return out;
  }
  async function importZip(file) {
    const files = await readZip(await file.arrayBuffer());
    if (!files["scene.json"]) throw new Error("scene.json is missing from that file.");
    const scene = normalize(JSON.parse(new TextDecoder().decode(files["scene.json"])));
    const mimeOf = p => ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" }[p.split(".").pop().toLowerCase()] || "");
    for (const it of scene.items) if (it.file && files[it.file]) { const id = uid(); await MediaDB.put(id, new Blob([files[it.file]], { type: it.mime || mimeOf(it.file) })); it.mediaId = id; delete it.file; }
    if (scene.bg.panoFile && files[scene.bg.panoFile]) { const id = uid(); await MediaDB.put(id, new Blob([files[scene.bg.panoFile]], { type: mimeOf(scene.bg.panoFile) })); scene.bg.pano = id; delete scene.bg.panoFile; }
    state = scene; state.rev++; persist(); emit({ type: "reset" }); say({ type: "scene", scene: state, media: true });
  }
  API.exportZip = exportZip; API.importZip = importZip;
  return API;
})();
