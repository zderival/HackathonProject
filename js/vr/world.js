/* =========================================================================
   WORLD: your own dome. Plain WebGL2 + WebXR, no libraries.
   - A small dome you stand in the middle of. You can look around; there is no walking.
   - Your pictures, videos and text hang inside it exactly as you uploaded them (no filters, no crops).
   - A video plays while it is in the middle of your view and pauses when you look away.
   - The background (sky, floor, dome shell, ribbons, particles, props) is fully adjustable.
   - Everything updates live: edits show instantly here and in the pop-out viewer window.
   ========================================================================= */
const World = (() => {
  const { TAU, M, norm, lerp, hex } = VRMath;
  const { VS, SKY_VS, SKY_FS, FLOOR_FS, SHELL_FS, TEX_FS, PLATE_FS, SOLID_FS, RIB_VS, RIB_FS, MOTE_VS, MOTE_FS, RETICLE_FS } = VRShaders;
  const { FONTS } = VRData;
  const GEO = VRGeometry, Scene = VRStore;
  const EYE = 1.6, DEG = Math.PI / 180, clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const UI = { sound: true, dot: true, visitor: Scene.viewerMode };
  try { Object.assign(UI, JSON.parse(localStorage.getItem("mya.world.ui") || "{}"), { visitor: Scene.viewerMode }); } catch {}
  const saveUI = () => { try { localStorage.setItem("mya.world.ui", JSON.stringify({ sound: UI.sound, dot: UI.dot })); } catch {} };
  const editing = () => !UI.visitor && !Scene.viewerMode;
  if (Scene.viewerMode) document.documentElement.classList.add("viewer");

  /* ---------------- GL plumbing ---------------- */
  let gl, canvas, P = {}, G = {}, built = false, running = false, last = 0, tBg = 0, maxTex = 4096;
  function compile(g, vs, fs) {
    const mk = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s); if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) + "\n" + src.split("\n").slice(0, 3).join(" ")); return s; };
    const p = g.createProgram(); g.attachShader(p, mk(g.VERTEX_SHADER, vs)); g.attachShader(p, mk(g.FRAGMENT_SHADER, fs)); g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p));
    const cache = {}; p.u = n => (n in cache ? cache[n] : (cache[n] = g.getUniformLocation(p, n)));
    return p;
  }
  function mesh(g, attrs, mode, index) {
    const vao = g.createVertexArray(); g.bindVertexArray(vao);
    let count = 0;
    attrs.forEach(([loc, size, data]) => { if (!data) return; const b = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, b); g.bufferData(g.ARRAY_BUFFER, new Float32Array(data), g.STATIC_DRAW); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, size, g.FLOAT, false, 0, 0); if (loc === 0) count = data.length / size; });
    if (index) { const b = g.createBuffer(); g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, b); g.bufferData(g.ELEMENT_ARRAY_BUFFER, new Uint16Array(index), g.STATIC_DRAW); count = index.length; }
    g.bindVertexArray(null);
    return { vao, count, mode: mode ?? g.TRIANGLES, indexed: !!index };
  }
  function draw(m, n) { gl.bindVertexArray(m.vao); m.indexed ? gl.drawElements(m.mode, n ?? m.count, gl.UNSIGNED_SHORT, 0) : gl.drawArrays(m.mode, 0, n ?? m.count); }
  function texture(g, src, mip = true, repeatS = false) {
    const t = g.createTexture(); g.bindTexture(g.TEXTURE_2D, t);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, repeatS ? g.REPEAT : g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, mip ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    const ext = g.getExtension("EXT_texture_filter_anisotropic"); if (ext && mip) g.texParameterf(g.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    t.mip = mip; if (src) upload(g, t, src); else g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array([20, 18, 28, 255]));
    return t;
  }
  function upload(g, t, src) {
    g.bindTexture(g.TEXTURE_2D, t); g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
    try { g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src); if (t.mip) g.generateMipmap(g.TEXTURE_2D); return true; }
    catch (e) { return false; } finally { g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false); }
  }
  // Only if a picture is bigger than the graphics card can hold do we have to shrink it; otherwise it goes up untouched.
  function fitTex(img, w, h) {
    if (w <= maxTex && h <= maxTex) return img;
    const k = maxTex / Math.max(w, h), c = document.createElement("canvas"); c.width = Math.floor(w * k); c.height = Math.floor(h * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); return c;
  }

  /* ---------------- background: smoothed copy of the settings so changes glide ---------------- */
  const COLS = ["top", "mid", "bot", "sunCol", "cloudCol", "nebCol", "aurA", "aurB", "shellCol", "floor", "glow", "rib1", "rib2", "rib3", "partCol", "decorCol", "tint", "fogCol"];
  const NUMS = ["horizon", "sunSize", "clouds", "cloudSpeed", "stars", "twinkle", "neb", "nebScale", "aurora", "panoOp", "panoRot", "panoZoom", "panoX", "panoY", "shellOp", "floorGlow", "floorScale", "rim", "ribK", "ribSpeed", "partSize", "partSpeed", "decorK", "bright", "contrast", "sat", "hue", "tintK", "fog", "motion", "sunAz", "sunEl", "sunK"];
  let C = null, T = {}, Rs = 4.5, panoId = "", panoTex = null, panoOk = false;
  const decorK = { islands: 0, mushrooms: 0, shards: 0, planet: 0, crystals: 0, orbs: 0 };
  function bgTarget() {
    const b = Scene.bg;
    COLS.forEach(k => { T[k] = hex(/^#[0-9a-f]{6}$/i.test(b[k]) ? b[k] : "#000000"); });
    NUMS.forEach(k => { const v = k === "sunK" ? (b.sunOn ? b.sunK : 0) : b[k]; T[k] = Number.isFinite(+v) ? +v : 0; });
    if (!C) { C = {}; COLS.forEach(k => C[k] = T[k].slice()); NUMS.forEach(k => C[k] = T[k]); }
    if (b.pano !== panoId) loadPano(b.pano);
  }
  function stepBg(dt) {
    const k = 1 - Math.pow(.0005, dt);
    COLS.forEach(c => { for (let i = 0; i < 3; i++) C[c][i] = lerp(C[c][i], T[c][i], k); });
    NUMS.forEach(n => { C[n] = Math.abs(C[n] - T[n]) < 1e-4 ? T[n] : lerp(C[n], T[n], k); });
    Rs = lerp(Rs, Scene.view.dome, 1 - Math.pow(.002, dt));
    const want = Scene.bg.decor;
    for (const d in decorK) decorK[d] = lerp(decorK[d], want === d ? 1 : 0, 1 - Math.pow(.05, dt));
  }
  async function loadPano(id, tries = 0) {
    panoId = id; panoOk = false;
    if (!id) return;
    const cloud = id.startsWith("a_") && typeof Cloud !== "undefined"; // a background picture that lives on the backend
    const blob = await (cloud ? Cloud.fetchMedia(id) : Scene.MediaDB.get(id)); if (panoId !== id) return;
    if (!blob) { if (!cloud && tries < 20) setTimeout(() => panoId === id && loadPano(id, tries + 1), 600); return; }
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { if (panoId !== id) return; if (panoTex) gl.deleteTexture(panoTex); panoTex = texture(gl, null, true, true); panoOk = upload(gl, panoTex, fitTex(img, img.naturalWidth, img.naturalHeight)); if (!panoOk) toast("This image couldn't be used as a background."); URL.revokeObjectURL(url); };
    img.onerror = () => { toast("This image couldn't be read as a background."); URL.revokeObjectURL(url); };
    img.src = url;
  }

  /* ---------------- decor (props around the edge), stored relative to the dome so it scales with it ---------------- */
  const decor = {};
  function buildDecor() {
    const ic = GEO.icosa(), oc = GEO.octa(), hemi = GEO.sphere(8, 16, Math.PI / 2), sph = GEO.sphere(18, 32), tube = GEO.tube(10), ann = GEO.annulus(1.35, 2.1, 96);
    G.ico = mesh(gl, [[0, 3, ic.p], [2, 3, ic.n]]); G.oct = mesh(gl, [[0, 3, oc.p], [2, 3, oc.n]]);
    G.hemi = mesh(gl, [[0, 3, hemi.p], [2, 3, hemi.n]], null, hemi.idx); G.sph = mesh(gl, [[0, 3, sph.p], [2, 3, sph.n]], null, sph.idx);
    G.tube = mesh(gl, [[0, 3, tube.p], [2, 3, tube.n]]); G.ann = mesh(gl, [[0, 3, ann.p], [2, 3, ann.n]]);
    seed = 21; const A = () => rnd() * TAU;
    decor.islands = Array.from({ length: 12 }, () => ({ a: A(), rf: 1.2 + rnd() * .9, y: .25 + rnd() * 1.1, s: .7 + rnd() * 1.6, sy: .45 + rnd() * .4, rot: A(), ph: rnd() * 6 }));
    decor.mushrooms = Array.from({ length: 34 }, () => ({ a: A(), rf: .8 + rnd() * .17, s: .5 + rnd() * 1, hue: rnd(), ph: rnd() * 6, lean: (rnd() - .5) * .3 }));
    decor.shards = Array.from({ length: 24 }, () => ({ a: A(), rf: .85 + rnd() * .6, y: .1 + rnd() * 1, s: .3 + rnd() * 1, sp: (rnd() - .5) * .8, ph: rnd() * 6 }));
    decor.crystals = Array.from({ length: 16 }, () => ({ a: A(), rf: .9 + rnd() * .07, hgt: .12 + rnd() * .28, w: .04 + rnd() * .05, ph: rnd() * 6 }));
    decor.orbs = Array.from({ length: 16 }, () => ({ a: A(), rf: .35 + rnd() * .65, y: .2 + rnd() * .9, s: .03 + rnd() * .06, ph: rnd() * 6 }));
  }

  /* ---------------- media items ---------------- */
  const rt = new Map(), blobURLs = new Map();
  let selId = null; const selCbs = new Set();
  const FONT_CSS = k => (FONTS.find(f => f.v === k) || FONTS[0]).css;
  const fontsAsked = new Set();

  function fallbackArt(name, w = 640, h = 400) {
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#2a2438"); g.addColorStop(1, "#14111c"); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = "rgba(255,255,255,.85)"; x.textAlign = "center"; x.font = `600 ${Math.round(w / 16)}px "Figtree", system-ui`; x.fillText(name || "Picture", w / 2, h / 2, w - 40);
    x.fillStyle = "rgba(255,255,255,.45)"; x.font = `400 ${Math.round(w / 32)}px "DM Mono", monospace`; x.fillText("loads when the page is hosted", w / 2, h / 2 + w / 14, w - 40);
    return c;
  }
  async function blobURL(id) {
    if (blobURLs.has(id)) return blobURLs.get(id);
    // pictures stored on the backend: downloaded with this device's own permission (creator sign-in or the phone's viewer token)
    if (id.startsWith("a_") && typeof Cloud !== "undefined") { const b = await Cloud.fetchMedia(id); if (!b) return null; const u = URL.createObjectURL(b); blobURLs.set(id, u); return u; }
    for (let i = 0; i < 8; i++) { const b = await Scene.MediaDB.get(id); if (b) { const u = URL.createObjectURL(b); blobURLs.set(id, u); return u; } await new Promise(r => setTimeout(r, 250)); }
    return null;
  }
  const sizeOf = r => { const s = r.d.size, ar = r.ar || 1; return ar >= 1 ? [s, s / ar] : [s * ar, s]; };

  function renderText(r) {
    const t = { ...Scene.TEXT_DEFAULTS, ...(r.d.text || {}) }, W = 1024, pad = t.card ? 56 : 24, fs = Math.round(64 * clamp(t.fs || 1, .3, 3));
    const fam = FONT_CSS(t.font);
    if (document.fonts && !fontsAsked.has(fam + t.weight)) { fontsAsked.add(fam + t.weight); document.fonts.load(`${t.weight} ${fs}px ${fam}`).then(() => rt.get(r.id) && renderText(r)).catch(() => {}); }
    const c = document.createElement("canvas"), x = c.getContext("2d");
    x.font = `${t.weight} ${fs}px ${fam}`;
    const lines = []; String(t.body || "").split("\n").forEach(par => {
      let line = ""; par.split(/\s+/).forEach(w => { const test = line ? line + " " + w : w; if (x.measureText(test).width > W - pad * 2 && line) { lines.push(line); line = w; } else line = test; }); lines.push(line);
    });
    const lh = Math.round(fs * 1.28), H = Math.max(lines.length * lh + pad * 2, 96);
    c.width = W; c.height = H;
    if (t.card) { x.globalAlpha = clamp(t.cardOp, 0, 1); x.fillStyle = t.cardCol; x.beginPath(); x.roundRect(0, 0, W, H, 44); x.fill(); x.globalAlpha = 1; }
    x.font = `${t.weight} ${fs}px ${fam}`; x.fillStyle = t.color; x.textBaseline = "middle"; x.textAlign = t.align;
    const px = t.align === "left" ? pad : t.align === "right" ? W - pad : W / 2;
    lines.forEach((l, i) => x.fillText(l, px, pad + lh * (i + .5)));
    r.ar = W / H; r.el = c; upload(gl, r.tex, c); r.ready = true; place(r);
  }
  function renderCaption(r) {
    const d = r.d;
    if (!d.caption || !d.name) { r.cap = null; return; }
    const c = document.createElement("canvas"); c.width = 1024; c.height = 144; const x = c.getContext("2d");
    x.textAlign = "center"; x.fillStyle = "#f5f1ea"; x.font = `700 56px "Bricolage Grotesque", system-ui`; x.fillText(d.name, 512, 80, 980);
    if (!r.capTex) r.capTex = texture(gl, null, true); upload(gl, r.capTex, c); r.cap = r.capTex; r.capSig = d.name;
  }

  function mkRT(d) {
    const r = { d, id: d.id, ar: d.ar || 1, x: 0, y: 0, z: 0, yaw: 0, tilt: 0, w: 1, h: 1, vis: 0, sel: 0, hov: 0, tex: texture(gl, null, d.type !== "video"), ready: false, blocked: false, lookT: 0, away: 0, snap: true, sig: "" };
    place(r, true); applyItem(r); return r;
  }
  function place(r, snap) {
    const d = r.d, [w, h] = sizeOf(r); r.w = w; r.h = h;
    const az = d.az * DEG, dist = clamp(d.d, .6, Rs * 2);
    r.tg = { x: Math.sin(az) * dist, y: d.h, z: -Math.cos(az) * dist, yaw: -az, tilt: (d.tilt || 0) * DEG };
    if (snap) { r.x = r.tg.x; r.y = r.tg.y; r.z = r.tg.z; r.yaw = r.tg.yaw; r.tilt = r.tg.tilt; }
  }
  function applyItem(r) {
    const d = r.d, sig = d.type + "|" + (d.mediaId || d.src || "");
    if (sig !== r.sig) { r.sig = sig; loadMedia(r); }
    if (d.type === "text") { const ts = JSON.stringify(d.text); if (ts !== r.tsig) { r.tsig = ts; renderText(r); } }
    if ((d.caption && d.name ? d.name : "") !== (r.cap ? r.capSig : "")) renderCaption(r);
    if (r.el && r.el.tagName === "VIDEO") r.el.loop = d.loop !== false;
    place(r); applySound();
  }
  async function loadMedia(r) {
    const d = r.d, token = r.token = (r.token || 0) + 1;
    r.ready = false; r.blocked = false; r.vis = Math.min(r.vis, .2);
    if (r.el && r.el.tagName === "VIDEO") { r.el.pause(); r.el.removeAttribute("src"); r.el.load(); }
    if (d.type === "text") return;
    const url = d.mediaId ? await blobURL(d.mediaId) : d.src;
    if (token !== r.token) return;
    if (!url) { setFallback(r, "Missing file"); return; }
    if (d.type === "image") {
      const img = new Image(); img.decoding = "async";
      img.onload = () => {
        if (token !== r.token) return;
        r.ar = img.naturalWidth / img.naturalHeight || 1;
        if (upload(gl, r.tex, fitTex(img, img.naturalWidth, img.naturalHeight))) { r.el = img; r.ready = true; } else setFallback(r, d.name);
        place(r);
      };
      img.onerror = () => token === r.token && setFallback(r, d.name);
      img.src = url;
    } else if (d.type === "video") {
      const v = document.createElement("video"); v.loop = d.loop !== false; v.muted = true; v.playsInline = true; v.preload = "auto"; v.setAttribute("playsinline", "");
      if (!d.mediaId && d.src2 && !v.canPlayType("video/webm")) v.src = d.src2; else v.src = url;
      v.addEventListener("loadedmetadata", () => { if (token !== r.token) return; if (v.videoWidth) { r.ar = v.videoWidth / v.videoHeight; place(r); } try { v.currentTime = .05; } catch {} });
      v.addEventListener("loadeddata", () => { if (token !== r.token) return; r.fresh = true; r.ready = true; });
      v.addEventListener("seeked", () => { r.fresh = true; });
      v.addEventListener("error", () => { if (token !== r.token) return; r.blocked = true; toast("A video couldn't be played: " + (d.name || "untitled")); });
      if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) { const cb = () => { r.fresh = true; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); r.rvfc = true; }
      r.el = v; v.load();
    }
  }
  function setFallback(r, name) {
    const c = fallbackArt(name); r.ar = c.width / c.height; upload(gl, r.tex, c); r.el = c; r.ready = true; r.placeholder = true; place(r);
    if (location.protocol === "file:" && !setFallback.warned) { setFallback.warned = true; setTimeout(() => toast("Your own uploads work from a file, but the sample pieces need the page hosted (any web server)."), 700); }
  }
  function disposeRT(r) {
    r.token = -1; if (r.el && r.el.tagName === "VIDEO") { r.el.pause(); r.el.removeAttribute("src"); r.el.load(); }
    gl.deleteTexture(r.tex); r.capTex && gl.deleteTexture(r.capTex);
  }
  function syncItems() {
    const ids = new Set(Scene.items.map(i => i.id));
    rt.forEach((r, id) => { if (!ids.has(id)) { disposeRT(r); rt.delete(id); if (selId === id) select(null); } });
    Scene.items.forEach(d => { let r = rt.get(d.id); if (!r) rt.set(d.id, mkRT(d)); else { r.d = d; applyItem(r); } });
    const e = $("#wEmpty"); if (e) e.hidden = !!Scene.items.length || !editing();
    // dome got smaller: keep everything inside it
    rt.forEach(r => place(r));
  }
  function onScene(ev) {
    if (!built) return;
    if (ev.type === "item") { const r = rt.get(ev.id); if (r) { r.d = Scene.item(ev.id) || r.d; if (ev.patch && ("az" in ev.patch || "h" in ev.patch) && drag) r.snap = true; applyItem(r); } }
    else if (ev.type === "items" || ev.type === "reset" || ev.type === "view") syncItems();
    if (ev.type === "bg" || ev.type === "reset") bgTarget();
    syncHUD();
  }

  /* ---------------- video: play when looked at, pause when looked away ---------------- */
  let soundBlocked = false, soundHinted = false;
  function applySound() {
    rt.forEach(r => { if (r.el && r.el.tagName === "VIDEO") r.el.muted = !UI.sound || soundBlocked || !!r.d.mute; });
  }
  function playVideo(r) {
    r.pending = true; const v = r.el; v.muted = !UI.sound || soundBlocked || !!r.d.mute;
    v.play().then(() => { r.pending = false; }).catch(() => {
      if (!v.muted) { v.muted = true; soundBlocked = true; v.play().then(() => { r.pending = false; if (!soundHinted) { soundHinted = true; toast("Tap anywhere on the page to turn video sound on."); } }).catch(() => { r.pending = false; }); }
      else r.pending = false;
    });
  }
  addEventListener("pointerdown", () => { if (soundBlocked) { soundBlocked = false; applySound(); } }, true);
  addEventListener("keydown", () => { if (soundBlocked) { soundBlocked = false; applySound(); } }, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) rt.forEach(r => r.el && r.el.tagName === "VIDEO" && r.el.pause()); });

  function gazeRay() {
    if (xr && xr.lastView) { const m = xr.lastView; return { o: [m[12], m[13], m[14]], d: norm([-m[8], -m[9], -m[10]]) }; }
    const c = camMatrix(); return { o: [c[12], c[13], c[14]], d: norm([-c[8], -c[9], -c[10]]) };
  }
  let gazeAmt = 0, gazeId = null;
  function updateGaze(dt) {
    const ray = gazeRay(); let best = null;
    rt.forEach(r => {
      if (r.d.hidden || !r.ready) return;
      const grow = r.el && r.el.tagName === "VIDEO" && !r.el.paused ? 1.14 : 1; // a bit more forgiving once it is playing, so it doesn't flicker at the edge
      const h = hitQuad(M.mul(itemModel(r), M.S(r.w * grow, r.h * grow)), ray);
      if (h && (!best || h.t < best.t)) best = { t: h.t, r };
    });
    const target = best && best.r.el && best.r.el.tagName === "VIDEO" && !best.r.blocked ? best.r : null;
    gazeId = target ? target.id : null;
    const now = performance.now(); // wall-clock, so a slow device still pauses on time
    rt.forEach(r => {
      if (!r.el || r.el.tagName !== "VIDEO") return;
      if (r === target && running && !document.hidden) { r.lastSeen = now; r.seenSince ??= now; if (now - r.seenSince > 80 && r.el.paused && !r.pending && r.el.readyState >= 2) playVideo(r); }
      else { r.seenSince = null; if (!r.el.paused && now - (r.lastSeen || 0) > 250) r.el.pause(); }
    });
    gazeAmt = lerp(gazeAmt, target && !target.el.paused ? 1 : 0, 1 - Math.pow(.003, dt));
  }

  /* ---------------- camera: you can look; you cannot walk ---------------- */
  const rig = { yaw: 0, pitch: 0, yawT: null };
  let gyro = null, goggles = false, xr = null, xrRef = null, xrBase = null, xrSupported = false, fov = 70 * DEG;
  function camMatrix() {
    const base = M.chain(M.T(0, EYE, 0), M.Ry(rig.yaw));
    return gyro && gyro.q ? M.mul(base, M.Q(gyro.q)) : M.mul(base, M.Rx(rig.pitch));
  }
  const effFov = asp => Math.min(115 * DEG, Math.max(fov, 2 * Math.atan(Math.tan(80 * Math.PI / 360) / asp)));
  function rayFromCam(nx, ny, aspect) {
    const c = camMatrix(), t = Math.tan(effFov(aspect) / 2);
    return { o: [c[12], c[13], c[14]], d: norm(M.dir(c, [nx * t * aspect, ny * t, -1])) };
  }
  function hitQuad(model, ray) {
    const inv = M.inv(model), o = M.pt(inv, ray.o), d = M.dir(inv, ray.d);
    if (Math.abs(d[2]) < 1e-6) return null; const t = -o[2] / d[2]; if (t <= 0) return null;
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t; if (Math.abs(x) > .5 || Math.abs(y) > .5) return null;
    return { t, u: x + .5, v: y + .5 };
  }
  const itemModel = r => M.chain(M.T(r.x, r.y, r.z), M.Ry(r.yaw), M.Rx(r.tilt));
  function pickItem(ray) {
    let best = null;
    rt.forEach(r => { if (r.d.hidden || !r.ready) return; const h = hitQuad(M.mul(itemModel(r), M.S(r.w, r.h)), ray); if (h && (!best || h.t < best.t)) best = { t: h.t, r }; });
    return best;
  }
  function select(id) { if (selId === id) return; selId = id; selCbs.forEach(f => f(id)); }
  let drag = null, pointerRay = null;
  function bindInput() {
    const ndc = e => { const r = canvas.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1), r.width / r.height]; };
    const rayAt = e => { const [nx, ny, a] = ndc(e); return rayFromCam(nx, ny, a); };
    canvas.addEventListener("pointerdown", e => {
      if (goggles || xr) return; rig.yawT = null;
      const hit = editing() ? pickItem(rayAt(e)) : null;
      if (hit) { select(hit.r.id); drag = { mode: "item", r: hit.r, x: e.clientX, y: e.clientY, moved: 0 }; hit.r.snap = true; }
      else drag = { mode: "cam", x: e.clientX, y: e.clientY, yaw: rig.yaw, pitch: rig.pitch, moved: 0 };
      canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing";
    });
    canvas.addEventListener("pointermove", e => {
      if (goggles || xr) return;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
        if (drag.mode === "cam") { rig.yaw = drag.yaw + dx * .0045; if (!gyro) rig.pitch = clamp(drag.pitch + dy * .0045, -1.2, 1.2); }
        else if (drag.moved > 3) {
          const ray = rayAt(e), hl = Math.hypot(ray.d[0], ray.d[2]); if (hl < .05) return;
          const dist = drag.r.d.d / hl;
          Scene.update(drag.r.id, { az: Math.round(Math.atan2(ray.d[0], -ray.d[2]) / DEG * 10) / 10, h: Math.round(clamp(ray.o[1] + ray.d[1] * dist, .2, Rs * .95) * 100) / 100 });
        }
        return;
      }
      pointerRay = rayAt(e);
    });
    const up = () => { if (!drag) return; const d = drag; drag = null; canvas.style.cursor = "grab"; if (d.mode === "cam" && d.moved < 6 && editing()) select(null); if (d.r) d.r.snap = false; };
    canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", () => { drag = null; });
    canvas.addEventListener("pointerleave", () => { pointerRay = null; });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const hit = editing() && selId ? pickItem(rayAt(e)) : null;
      if (hit && hit.r.id === selId) Scene.update(selId, { size: Math.round(clamp(hit.r.d.size * Math.exp(-e.deltaY * .0012), .2, Math.min(6, Rs * 1.3)) * 100) / 100 });
      else fov = clamp(fov + e.deltaY * .0008, 35 * DEG, 90 * DEG);
    }, { passive: false });
    addEventListener("keydown", e => {
      if (route !== "world" || !editing() || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (e.key === "Escape") { select(null); return; }
      const r = selId && Scene.item(selId); if (!r) return;
      const big = e.shiftKey ? 5 : 1;
      if (e.key === "ArrowLeft") Scene.update(selId, { az: clamp(r.az - big, -180, 180) });
      else if (e.key === "ArrowRight") Scene.update(selId, { az: clamp(r.az + big, -180, 180) });
      else if (e.key === "ArrowUp") Scene.update(selId, { h: clamp(Math.round((r.h + .05 * big) * 100) / 100, .2, Rs * .95) });
      else if (e.key === "ArrowDown") Scene.update(selId, { h: clamp(Math.round((r.h - .05 * big) * 100) / 100, .2, Rs * .95) });
      else if (e.key === "+" || e.key === "=") Scene.update(selId, { size: clamp(+(r.size * 1.05).toFixed(2), .2, 6) });
      else if (e.key === "-" || e.key === "_") Scene.update(selId, { size: clamp(+(r.size / 1.05).toFixed(2), .2, 6) });
      else return;
      e.preventDefault();
    });
    // drop or paste files anywhere on the world
    const w = $("#world");
    w.addEventListener("dragover", e => { if (Scene.viewerMode) return; e.preventDefault(); w.classList.add("drop"); });
    w.addEventListener("dragleave", e => { if (e.target === w || !w.contains(e.relatedTarget)) w.classList.remove("drop"); });
    w.addEventListener("drop", e => { e.preventDefault(); w.classList.remove("drop"); addFiles(e.dataTransfer.files); });
    addEventListener("paste", e => { if (route === "world" && editing() && e.clipboardData && e.clipboardData.files.length) addFiles(e.clipboardData.files); });
    new ResizeObserver(resize).observe($("#worldStage"));
  }
  async function addFiles(files) {
    if (Scene.viewerMode || !files || !files.length) return;
    const added = await Scene.addFiles(files);
    if (added.length) { select(added[0].id); turnTo(added[0]); toast(added.length > 1 ? `${added.length} items added` : "Added to your dome"); }
  }
  function turnTo(d) { if (!xr) { rig.yawT = -d.az * DEG; rig.pitch = 0; } }
  function resize() {
    if (!canvas) return; const dpr = Math.min(devicePixelRatio || 1, goggles ? 2 : 1.5);
    canvas.width = Math.max(2, Math.round(canvas.clientWidth * dpr)); canvas.height = Math.max(2, Math.round(canvas.clientHeight * dpr));
  }

  /* ---------------- phone in goggles: gyro head tracking ---------------- */
  function quatFromOrientation(al, be, ga, orient) {
    const d = Math.PI / 180, x = be * d, y = al * d, z = -ga * d;
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    let q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
    const qm = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
    q = qm(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    const o = -orient * d; q = qm(q, [0, 0, Math.sin(o / 2), Math.cos(o / 2)]);
    return q;
  }
  const onOrient = e => { if (e.alpha == null) return; gyro.alpha0 ??= e.alpha; const orient = (screen.orientation && screen.orientation.angle) || window.orientation || 0; gyro.q = quatFromOrientation(e.alpha - gyro.alpha0, e.beta, e.gamma, orient); };
  function firstReading(ms) {
    return new Promise(res => {
      const t = setTimeout(() => { removeEventListener("deviceorientation", h); res(false); }, ms);
      const h = e => { if (e.alpha != null || e.beta != null) { clearTimeout(t); removeEventListener("deviceorientation", h); res(true); } };
      addEventListener("deviceorientation", h);
    });
  }
  // Must be called from a tap. Resolves false (with a plain-language toast) when the phone won't share its motion.
  async function enableGyro() {
    if (gyro) return true;
    if (typeof DeviceOrientationEvent === "undefined") { toast("This device has no motion sensors. Drag to look around."); return false; }
    try { if (DeviceOrientationEvent.requestPermission) { if ((await DeviceOrientationEvent.requestPermission()) !== "granted") { toast("Motion was not allowed. You can still drag to look around."); return false; } } }
    catch { toast("Motion was not allowed. You can still drag to look around."); return false; }
    gyro = { q: null }; addEventListener("deviceorientation", onOrient);
    if (!(await firstReading(1800))) {
      disableGyro();
      toast(window.isSecureContext ? "No motion came from this device. Drag to look around." : "Phones only share motion with secure (https) pages. Ask for the https link; dragging works meanwhile.");
      return false;
    }
    keepAwake(true); return true;
  }
  function disableGyro() { removeEventListener("deviceorientation", onOrient); gyro = null; keepAwake(false); }
  let wake = null;
  async function keepAwake(on) { try { if (on) { if (!wake && navigator.wakeLock) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } } else if (wake) { await wake.release(); wake = null; } } catch {} }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && gyro) keepAwake(true); });

  /* Motion look: tilt/turn the phone to look around (normal full-screen view). Drag still nudges the heading. */
  let motion = false;
  async function setMotion(on) {
    on = !!on; if (on === motion) return motion;
    if (on) { if (!(await enableGyro())) { syncHUD(); return false; } motion = true; toast("Move your phone to look around."); }
    else { motion = false; if (!goggles) { disableGyro(); rig.pitch = 0; } }
    syncHUD(); return motion;
  }
  async function setGoggles(on) {
    goggles = on; document.body.classList.toggle("goggles", on);
    if (on) {
      const ok = await enableGyro();
      try { await document.documentElement.requestFullscreen?.(); } catch {}
      try { await screen.orientation?.lock?.("landscape"); } catch {}
      if (ok) toast("Slide your phone into the headset. Look at a video to play it.");
    } else { if (!motion) { disableGyro(); rig.pitch = 0; } try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {} }
    setTimeout(resize, 300); syncHUD();
  }

  /* ---------------- WebXR (headsets). Head tracking only; turning in place is a snap-turn on the right stick. ---------------- */
  async function checkXR() { try { xrSupported = !!(navigator.xr && await navigator.xr.isSessionSupported("immersive-vr")); } catch { xrSupported = false; } syncHUD(); }
  function updateXRRef() {
    if (!xr || !xrBase) return;
    xrRef = xrBase.getOffsetReferenceSpace(new XRRigidTransform({ x: 0, y: 0, z: 0 }, { x: 0, y: Math.sin(-rig.yaw / 2), z: 0, w: Math.cos(-rig.yaw / 2) }));
  }
  async function enterVR() {
    if (!navigator.xr) { toast("Open this page in your headset's browser to enter VR"); return; }
    try {
      const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor"] });
      await gl.makeXRCompatible();
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl, { antialias: true }) });
      try { xrBase = await session.requestReferenceSpace("local-floor"); } catch { xrBase = (await session.requestReferenceSpace("local")).getOffsetReferenceSpace(new XRRigidTransform({ x: 0, y: -EYE, z: 0 })); }
      xr = { session, snap: {} }; rig.yaw = 0; updateXRRef();
      session.addEventListener("end", () => { xr = null; xrRef = xrBase = null; resize(); loopWindow(); syncHUD(); });
      cancelAnimationFrame(rafId); session.requestAnimationFrame(loopXR); syncHUD();
    } catch (err) { toast("Couldn't start VR: " + (err.message || err)); }
  }

  /* ---------------- render ---------------- */
  const U = (p, n) => p.u(n);
  function grade(p) { gl.uniform4f(U(p, "uGrade"), C.bright, C.contrast, C.sat, C.tintK); gl.uniform3fv(U(p, "uTint"), C.tint); gl.uniform1f(U(p, "uHue"), C.hue * DEG); }
  const FLOOR_STYLES = { rings: 0, grid: 1, checker: 2, spokes: 3, water: 4, plain: 5 }, SHELLS = { glass: 1, lattice: 2, rings: 3 }, PARTS = { dust: 0, fireflies: 1, snow: 2, embers: 3 };
  function drawScene(Pm, Vm, camPos, t, isXR, camM) {
    const b = Scene.bg, R = Rs, sunA = C.sunAz * DEG, sunE = C.sunEl * DEG;
    const sun = [Math.sin(sunA) * Math.cos(sunE), Math.sin(sunE), -Math.cos(sunA) * Math.cos(sunE)];
    gl.depthMask(false); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    // sky
    gl.useProgram(P.sky); gl.uniformMatrix4fv(U(P.sky, "uP"), false, Pm); gl.uniformMatrix4fv(U(P.sky, "uV"), false, Vm); grade(P.sky);
    [["uTop", "top"], ["uMid", "mid"], ["uBot", "bot"], ["uSunCol", "sunCol"], ["uNebCol", "nebCol"], ["uCloudCol", "cloudCol"], ["uAurA", "aurA"], ["uAurB", "aurB"]].forEach(([u, k]) => gl.uniform3fv(U(P.sky, u), C[k]));
    gl.uniform3fv(U(P.sky, "uSun"), sun);
    gl.uniform1f(U(P.sky, "uHorizon"), C.horizon); gl.uniform1f(U(P.sky, "uSunK"), C.sunK); gl.uniform1f(U(P.sky, "uSunSize"), C.sunSize);
    gl.uniform1f(U(P.sky, "uClouds"), C.clouds); gl.uniform1f(U(P.sky, "uStars"), C.stars); gl.uniform1f(U(P.sky, "uTwinkle"), C.twinkle);
    gl.uniform1f(U(P.sky, "uNeb"), C.neb); gl.uniform1f(U(P.sky, "uNebS"), C.nebScale); gl.uniform1f(U(P.sky, "uAur"), C.aurora);
    gl.uniform1f(U(P.sky, "uTime"), t); gl.uniform1f(U(P.sky, "uCTime"), t * C.cloudSpeed);
    const usePano = b.skyMode === "panorama" && panoOk && panoTex;
    gl.uniform1f(U(P.sky, "uUsePano"), usePano ? 1 : 0); gl.uniform4f(U(P.sky, "uPanoA"), C.panoOp, C.panoRot * DEG, Math.max(C.panoZoom, .1), 0); gl.uniform2f(U(P.sky, "uPanoOff"), C.panoX, C.panoY);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, usePano ? panoTex : G.blank); gl.uniform1i(U(P.sky, "uPano"), 0);
    draw(G.sky);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
    const std = (p, model) => { gl.useProgram(p); gl.uniformMatrix4fv(U(p, "uP"), false, Pm); gl.uniformMatrix4fv(U(p, "uV"), false, Vm); gl.uniformMatrix4fv(U(p, "uM"), false, model); };
    // floor
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (b.floorOn) {
      std(P.floor, M.S(R * 1.3, 1, R * 1.3)); grade(P.floor);
      gl.uniform3fv(U(P.floor, "uFloor"), C.floor); gl.uniform3fv(U(P.floor, "uGlow"), C.glow); gl.uniform3fv(U(P.floor, "uMid"), C.mid);
      gl.uniform1f(U(P.floor, "uTime"), t); gl.uniform1f(U(P.floor, "uR"), R); gl.uniform1f(U(P.floor, "uGlowK"), C.floorGlow); gl.uniform1f(U(P.floor, "uPat"), C.floorScale); gl.uniform1f(U(P.floor, "uRim"), C.rim);
      gl.uniform1i(U(P.floor, "uStyle"), FLOOR_STYLES[b.floorStyle] ?? 0); draw(G.floor);
    }
    // dome shell
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (SHELLS[b.shell]) {
      gl.depthMask(false); std(P.shell, M.S(R, R, R)); grade(P.shell);
      gl.uniform3fv(U(P.shell, "uCam"), camPos); gl.uniform3fv(U(P.shell, "uCol"), C.shellCol); gl.uniform1f(U(P.shell, "uR"), R); gl.uniform1f(U(P.shell, "uOp"), C.shellOp); gl.uniform1i(U(P.shell, "uStyle"), SHELLS[b.shell]);
      draw(G.hemiShell); gl.depthMask(true);
    }
    gl.disable(gl.BLEND);
    // props
    const K = R / 8 * C.decorK, dc = C.decorCol, fogK = C.fog * .14;
    const solid = (m, model, col, emit, amb = .35) => { std(P.solid, model); grade(P.solid); gl.uniform3fv(U(P.solid, "uCol"), col); gl.uniform3fv(U(P.solid, "uEmit"), emit); gl.uniform3fv(U(P.solid, "uLight"), C.sunCol); gl.uniform3fv(U(P.solid, "uLightDir"), sun); gl.uniform3fv(U(P.solid, "uFog"), C.fogCol); gl.uniform3fv(U(P.solid, "uCam"), camPos); gl.uniform1f(U(P.solid, "uAmb"), amb); gl.uniform1f(U(P.solid, "uFogK"), fogK); draw(m); };
    const pol = (d, rf) => [Math.cos(d.a) * rf * R, Math.sin(d.a) * rf * R];
    let k = decorK.islands;
    if (k > .01) decor.islands.forEach(d => { const [x, z] = pol(d, d.rf), s = d.s * K * k, y = d.y * R + Math.sin(t * .4 + d.ph) * .25 * K * 4 + (1 - k) * -10; solid(G.ico, M.chain(M.T(x, y, z), M.Ry(d.rot + t * .02), M.S(s, s * d.sy, s)), dc.map(c => c * .7), dc.map(c => c * .06)); solid(G.hemi, M.chain(M.T(x, y + s * d.sy * .55, z), M.S(s * .8, s * .12, s * .8)), [.35, .55, .3], [.02, .03, .01], .5); });
    k = decorK.mushrooms;
    if (k > .01) decor.mushrooms.forEach(d => { const [x, z] = pol(d, d.rf), s = d.s * K * k * 1.3, pulse = .7 + .3 * Math.sin(t * 1.4 + d.ph), base = M.chain(M.T(x, 0, z), M.Rz(d.lean));
      solid(G.tube, M.mul(base, M.S(s * .12, s * 1.1, s * .12)), [.75, .8, .7], [.08, .12, .1], .5);
      solid(G.hemi, M.chain(base, M.T(0, s * 1.05, 0), M.S(s * .55, s * .42, s * .55)), [.1, .5, .45], d.hue > .7 ? [.5 * pulse, .25 * pulse, .9 * pulse] : [.15 * pulse, .9 * pulse, .7 * pulse], .3); });
    k = decorK.shards;
    if (k > .01) decor.shards.forEach(d => { const [x, z] = pol(d, d.rf); solid(G.oct, M.chain(M.T(x, d.y * R + Math.sin(t * .5 + d.ph) * .2, z), M.Ry(t * d.sp + d.ph), M.Rx(t * d.sp * .6), M.S(d.s * K * .5 * k, d.s * K * 1.3 * k, d.s * K * .5 * k)), [.55, .05, .1], [.35, .02, .06], .2); });
    k = decorK.crystals;
    if (k > .01) decor.crystals.forEach(d => { const [x, z] = pol(d, d.rf), hh = d.hgt * R * C.decorK * k, ww = d.w * R * C.decorK * k, pulse = .75 + .25 * Math.sin(t * 1.2 + d.ph); solid(G.oct, M.chain(M.T(x, hh, z), M.Ry(d.ph), M.S(ww, hh, ww)), dc.map(c => c * .45), dc.map(c => c * .55 * pulse), .3); });
    k = decorK.orbs;
    if (k > .01) decor.orbs.forEach(d => { const [x, z] = pol(d, d.rf), s = d.s * R * C.decorK * k, pulse = .8 + .2 * Math.sin(t * 1.5 + d.ph); solid(G.sph, M.chain(M.T(x, d.y * R + Math.sin(t * .6 + d.ph) * .12, z), M.S(s, s, s)), dc.map(c => c * .2), dc.map(c => c * 1.1 * pulse), .2); });
    k = decorK.planet;
    if (k > .01) { const pm = M.chain(M.T(-38, 22, -70), M.Ry(t * .01), M.S(16 * k, 16 * k, 16 * k)); solid(G.sph, pm, [.25, .3, .7], [.04, .03, .12], .15); solid(G.ann, M.chain(M.T(-38, 22, -70), M.Rz(.35), M.Rx(.2), M.S(16 * k, 16 * k, 16 * k)), [.6, .55, .9], [.15, .12, .3], .5); }

    // your media: drawn exactly as uploaded
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const accent = hex(S.settings.accent), cp = camPos;
    const list = [...rt.values()].filter(r => !r.d.hidden && r.ready).sort((a, b2) => ((b2.x - cp[0]) ** 2 + (b2.z - cp[2]) ** 2) - ((a.x - cp[0]) ** 2 + (a.z - cp[2]) ** 2));
    list.forEach(r => {
      const fm = itemModel(r), mode = { none: 0, thin: 1, plate: 2 }[r.d.frame] || 0, selv = editing() ? Math.max(r.sel, r.hov * .55) : 0;
      if (mode || selv > .01) { gl.depthMask(false); const pw = r.w + .5, ph = r.h + .5; std(P.plate, M.chain(fm, M.T(0, 0, -.012), M.S(pw, ph))); gl.uniform2f(U(P.plate, "uSize"), pw, ph); gl.uniform2f(U(P.plate, "uArt"), r.w, r.h); gl.uniform1f(U(P.plate, "uMode"), mode); gl.uniform1f(U(P.plate, "uSel"), selv); gl.uniform1f(U(P.plate, "uAlpha"), r.vis); gl.uniform3fv(U(P.plate, "uCol"), accent); draw(G.quad); gl.depthMask(true); }
      std(P.tex, M.mul(fm, M.S(r.w, r.h))); gl.uniform1f(U(P.tex, "uAlpha"), r.vis); gl.bindTexture(gl.TEXTURE_2D, r.tex); gl.uniform1i(U(P.tex, "uTex"), 0); draw(G.quad);
      if (r.cap) { std(P.tex, M.chain(fm, M.T(0, -r.h / 2 - .14, 0), M.S(Math.max(r.w, .9), Math.max(r.w, .9) * 144 / 1024))); gl.uniform1f(U(P.tex, "uAlpha"), r.vis * .9); gl.bindTexture(gl.TEXTURE_2D, r.cap); draw(G.quad); }
    });

    // additive light: ribbons + particles
    gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
    const tr = S.settings.calm ? 0 : t;
    if (b.ribOn) {
      gl.useProgram(P.rib); gl.uniformMatrix4fv(U(P.rib, "uP"), false, Pm); gl.uniformMatrix4fv(U(P.rib, "uV"), false, Vm); grade(P.rib); gl.uniform1f(U(P.rib, "uTime"), tr * C.ribSpeed);
      const cols = [C.rib1, C.rib2, C.rib3];
      [[.98, .5, .1, 0], [1.08, .85, .16, 2.1], [.9, .28, .07, 4.2]].slice(0, clamp(b.ribLayers | 0, 1, 3)).forEach(([rf, yf, af, ph], i) => { gl.uniform1f(U(P.rib, "uR"), R * rf); gl.uniform1f(U(P.rib, "uY"), R * yf); gl.uniform1f(U(P.rib, "uAmp"), R * af); gl.uniform1f(U(P.rib, "uPh"), ph); gl.uniform1f(U(P.rib, "uWave"), R * .12); gl.uniform3fv(U(P.rib, "uCol"), cols[i]); gl.uniform1f(U(P.rib, "uK"), .3 * C.ribK); draw(G.rib); });
    }
    if (b.partOn) {
      gl.useProgram(P.mote); gl.uniformMatrix4fv(U(P.mote, "uP"), false, Pm); gl.uniformMatrix4fv(U(P.mote, "uV"), false, Vm); grade(P.mote);
      gl.uniform1f(U(P.mote, "uTime"), tr * C.partSpeed); gl.uniform1f(U(P.mote, "uSize"), (isXR ? 5 : 3.4) * C.partSize); gl.uniform1f(U(P.mote, "uR"), R * 1.05); gl.uniform1f(U(P.mote, "uH"), R * .95);
      gl.uniform1i(U(P.mote, "uMode"), PARTS[b.partStyle] ?? 0); gl.uniform3fv(U(P.mote, "uCol"), C.partCol); gl.uniform1f(U(P.mote, "uK"), .8);
      draw(G.motes, clamp(b.partCount | 0, 0, 2000));
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // gaze dot
    if (UI.dot && !(isXR && !UI.dotXR)) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(P.ret); gl.uniformMatrix4fv(U(P.ret, "uP"), false, Pm); gl.uniformMatrix4fv(U(P.ret, "uV"), false, Vm);
      gl.uniformMatrix4fv(U(P.ret, "uM"), false, M.chain(camM, M.T(0, 0, -1.5), M.S(.09, .09))); gl.uniform1f(U(P.ret, "uProg"), gazeAmt); draw(G.quad);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.depthMask(true);
  }

  function update(dt) {
    bgTarget(); stepBg(dt);
    const e = 1 - Math.pow(1e-5, dt), ee = 1 - Math.pow(.0015, dt);
    rt.forEach(r => {
      // video frames -> texture. This is a straight copy of the frame; nothing is changed.
      const v = r.el && r.el.tagName === "VIDEO" ? r.el : null;
      if (v && !r.blocked && v.readyState >= 2 && (r.fresh || (!r.rvfc && !v.paused))) {
        r.fresh = false;
        if (!upload(gl, r.tex, v)) { v.pause(); r.blocked = true; r.ready = false; setFallback(r, r.d.name); toast("This browser won't draw a video opened straight from a file. Host the page, or upload your own video here."); }
        else if (!r.ready) r.ready = true;
      }
      r.vis = lerp(r.vis, r.ready ? 1 : 0, 1 - Math.pow(.002, dt));
      const sel = r.id === selId ? 1 : 0; r.sel = lerp(r.sel, sel, 1 - Math.pow(.001, dt));
      const tg = r.tg, k = r.snap ? 1 : e;
      r.x = lerp(r.x, tg.x, k); r.y = lerp(r.y, tg.y, k); r.z = lerp(r.z, tg.z, k); r.tilt = lerp(r.tilt, tg.tilt, ee);
      r.yaw += Math.atan2(Math.sin(tg.yaw - r.yaw), Math.cos(tg.yaw - r.yaw)) * ee;
    });
    // hover glow while editing
    rt.forEach(r => r.hov = 0);
    if (editing() && pointerRay && !drag && !goggles && !xr) { const h = pickItem(pointerRay); if (h) { h.r.hov = 1; canvas.style.cursor = "pointer"; } else canvas.style.cursor = "grab"; }
    if (rig.yawT != null) { const d = Math.atan2(Math.sin(rig.yawT - rig.yaw), Math.cos(rig.yawT - rig.yaw)); rig.yaw += d * Math.min(1, dt * 4); rig.pitch *= 1 - Math.min(1, dt * 4); if (Math.abs(d) < .002) rig.yawT = null; if (xr) updateXRRef(); }
    updateGaze(dt);
  }

  let rafId = 0;
  function loopWindow() { if (xr) return; rafId = requestAnimationFrame(tickWindow); }
  function tickWindow(now) {
    if (!running || xr) return;
    const dt = Math.min(.05, (now - (last || now)) / 1000); last = now;
    tBg += S.settings.calm ? 0 : dt * (C ? C.motion : 1);
    if (canvas.width !== Math.round(canvas.clientWidth * Math.min(devicePixelRatio || 1, goggles ? 2 : 1.5))) resize();
    update(dt);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(...C.bot, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const W = canvas.width, H = canvas.height, cm = camMatrix();
    if (goggles) {
      const ipd = .032, asp = (W / 2) / H;
      [-1, 1].forEach((s, i) => { const eye = M.mul(cm, M.T(s * ipd, 0, 0)); gl.viewport(i * W / 2, 0, W / 2, H); drawScene(M.persp(effFov(asp), asp, .05, 500), M.inv(eye), [eye[12], eye[13], eye[14]], tBg, false, eye); });
    } else { gl.viewport(0, 0, W, H); drawScene(M.persp(effFov(W / H), W / H, .05, 500), M.inv(cm), [cm[12], cm[13], cm[14]], tBg, false, cm); }
    loopWindow();
  }
  function loopXR(now, frame) {
    if (!xr) return;
    const session = frame.session; session.requestAnimationFrame(loopXR);
    const dt = Math.min(.05, (now - (last || now)) / 1000); last = now;
    tBg += S.settings.calm ? 0 : dt * C.motion;
    const pose = frame.getViewerPose(xrRef); if (!pose) return;
    xr.lastView = pose.transform.matrix;
    [...session.inputSources].forEach((src, i) => { // right stick = snap-turn in place (no walking)
      const gp = src.gamepad; if (!gp || !gp.axes || src.handedness !== "right") return;
      const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
      if (Math.abs(ax) > .7 && !xr.snap[i]) { rig.yaw -= Math.sign(ax) * Math.PI / 6; xr.snap[i] = true; updateXRRef(); }
      if (Math.abs(ax) < .3) xr.snap[i] = false;
    });
    update(dt);
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(...C.bot, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    pose.views.forEach(v => { const vp = layer.getViewport(v); gl.viewport(vp.x, vp.y, vp.width, vp.height); const p = v.transform.position; drawScene(v.projectionMatrix, v.transform.inverse.matrix, [p.x, p.y, p.z], tBg, true, pose.transform.matrix); });
  }

  /* ---------------- build ---------------- */
  function build() {
    canvas = document.createElement("canvas"); canvas.id = "worldCanvas"; $("#worldStage").append(canvas);
    gl = canvas.getContext("webgl2", { antialias: true, xrCompatible: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 isn't available in this browser.");
    maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    P.sky = compile(gl, SKY_VS, SKY_FS); P.floor = compile(gl, VS, FLOOR_FS); P.shell = compile(gl, VS, SHELL_FS); P.tex = compile(gl, VS, TEX_FS); P.plate = compile(gl, VS, PLATE_FS);
    P.solid = compile(gl, VS, SOLID_FS); P.rib = compile(gl, RIB_VS, RIB_FS); P.mote = compile(gl, MOTE_VS, MOTE_FS); P.ret = compile(gl, VS, RETICLE_FS);
    const q = GEO.quad(); G.quad = mesh(gl, [[0, 3, q.p], [1, 2, q.uv], [2, 3, q.n]]);
    const sk = GEO.sphere(32, 64); G.sky = mesh(gl, [[0, 3, sk.p]], null, sk.idx);
    const hs = GEO.sphere(24, 64, Math.PI / 2); G.hemiShell = mesh(gl, [[0, 3, hs.p], [2, 3, hs.n]], null, hs.idx);
    G.floor = mesh(gl, [[0, 3, [-1, 0, -1, 1, 0, 1, 1, 0, -1, -1, 0, -1, -1, 0, 1, 1, 0, 1]], [1, 2, [0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1]], [2, 3, [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]]]);
    const rb = []; const N = 220, STR = 12;
    for (let s = 0; s < STR; s++) for (let i = 0; i < N; i++) { const a = i / N * TAU, b = (i + 1) / N * TAU; rb.push(a, -1, s, b, -1, s, b, 1, s, a, -1, s, b, 1, s, a, 1, s); }
    G.rib = mesh(gl, [[0, 3, rb]]);
    seed = 5; const mp = [], ms = [];
    for (let i = 0; i < 2000; i++) { mp.push(Math.sqrt(rnd()) * .98, rnd(), rnd() * TAU); ms.push(rnd(), rnd()); }
    G.motes = mesh(gl, [[0, 3, mp], [1, 2, ms]], gl.POINTS);
    G.blank = texture(gl, null, false);
    buildDecor();
    built = true; Rs = Scene.view.dome;
    bgTarget(); syncItems();
    Scene.subscribe(onScene);
    document.fonts && document.fonts.ready.then(() => { rt.forEach(r => { if (r.d.type === "text") renderText(r); if (r.cap) renderCaption(r); if (r.placeholder) setFallback(r, r.d.name); }); });
    bindInput(); resize();
  }

  /* ---------------- on-screen buttons ---------------- */
  function buildHUD() {
    $("#wVR").onclick = enterVR;
    $("#wGog").onclick = () => setGoggles(!goggles);
    $("#wMotion").onclick = () => setMotion(!motion);
    $("#wExitGog").onclick = () => setGoggles(false);
    $("#wCenter").onclick = () => { if (xr) { const m = xr.lastView; if (m) rig.yawT = rig.yaw - Math.atan2(m[8], m[10]); } else { rig.yawT = 0; rig.pitch = 0; } if (gyro) gyro.alpha0 = null; };
    $("#wSound").onclick = () => { UI.sound = !UI.sound; soundBlocked = false; saveUI(); applySound(); syncHUD(); };
    $("#wVisitor").onclick = () => { UI.visitor = !UI.visitor; if (UI.visitor) select(null); document.body.classList.toggle("visitor", UI.visitor); onScene({ type: "items" }); syncHUD(); setTimeout(resize, 50); };
    $("#wPop").onclick = popOut;
  }
  function popOut() {
    const url = location.pathname + "?view=world";
    const w = window.open(url, "mya-live-view", "width=1180,height=720,noopener=no");
    if (!w) toast("Your browser blocked the pop-up. Allow pop-ups for this page and try again."); else toast("Live view opened. Move it to another screen and keep editing here.");
  }
  function syncHUD() {
    if (!built) return;
    $("#wVR").hidden = !xrSupported || !!xr;
    $("#wGog").textContent = goggles ? "Exit goggle mode" : "Phone goggle mode";
    const mb = $("#wMotion"); mb.hidden = !(Scene.viewerMode || (typeof DeviceOrientationEvent !== "undefined" && matchMedia("(pointer:coarse)").matches));
    mb.setAttribute("aria-pressed", motion); mb.querySelector("span").textContent = motion ? "Motion look: on" : "Motion look";
    $("#wExitGog").hidden = !goggles;
    $("#wSound").setAttribute("aria-pressed", UI.sound); $("#wSound").querySelector("span").textContent = UI.sound ? "Sound on" : "Sound off";
    $("#wVisitor").setAttribute("aria-pressed", UI.visitor); $("#wVisitor").querySelector("span").textContent = UI.visitor ? "Back to editing" : "Preview as visitor";
    const e = $("#wEmpty"); if (e) e.hidden = !!Scene.items.length || !editing();
  }

  /* ---------------- open / close ---------------- */
  function open() {
    try { if (!built) { buildHUD(); build(); checkXR(); } }
    catch (e) { $("#wLoad").hidden = false; $("#wLoad").innerHTML = `<b>This device can't draw the 3D world</b><small>${esc(e.message || e)}</small>`; console.error(e); return; }
    $("#wLoad").hidden = true; document.body.classList.toggle("visitor", UI.visitor || Scene.viewerMode);
    running = true; resize(); last = 0; syncHUD(); loopWindow();
    if (Scene.joinMode) initJoin(); else if (Scene.viewerMode) { Scene.hello(); }
  }

  /* ---------------- visitor landing (a phone that scanned the QR code) ---------------- */
  let joinWired = false;
  function initJoin() {
    const card = $("#wJoin"); if (!card || joinWired) return; joinWired = true;
    const live = $("#wLive span"), title = $("#wJoinTitle"), msg = $("#wJoinMsg"), note = $("#wJoinNote"), btns = card.querySelector(".w-join-btns");
    const want = (window.MW_BOOT && MW_BOOT.vr) || "", needsTap = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
    const MSG = {
      connecting: ["Joining the world…", "Connecting to the creator"],
      waiting: ["Almost there", "The creator hasn't put anything in this world yet. This page fills in by itself."],
      offline: ["Can't reach the world", "Check your connection. We keep trying."],
    };
    let started = false;
    const paint = st => {
      const j = st.join, m = j === "live" ? [st.title ? st.title : "A World", "Live: you'll see the creator's changes as they make them."] : (MSG[j] || [st.joinTitle || "Can't open this world", st.joinMsg || "Ask the creator for a new QR code."]);
      title.textContent = m[0]; msg.textContent = m[1];
      if (live) live.textContent = j === "live" ? "Live" : j === "waiting" ? "Waiting for the creator" : j === "offline" ? "Reconnecting…" : j === "connecting" ? "Connecting…" : "Not connected";
      $("#wLive").classList.toggle("off", j !== "live");
      const ended = !["connecting", "waiting", "offline", "live"].includes(j);
      if (btns) btns.hidden = ended; card.classList.toggle("ended", ended);
      if (j === "live" && !started && want === "goggles" && !needsTap && window.isSecureContext && !card.hidden) { started = true; card.hidden = true; setGoggles(true); } // Android: the QR code goes straight into goggle mode
    };
    Cloud.subscribe(paint); paint(Cloud.state);
    const sensors = typeof DeviceOrientationEvent !== "undefined";
    note.textContent = sensors ? (window.isSecureContext ? "" : "This page isn't secure (https), so your phone may refuse to share motion. Dragging always works.") : "This device has no motion sensors, so you'll look around by dragging.";
    $("#wJoinMotion").hidden = !sensors; $("#wJoinGog").hidden = false;
    const gog = $("#wJoinGog"), mot = $("#wJoinMotion"), drag = $("#wJoinDrag");
    gog.textContent = "Start goggle mode"; mot.textContent = "Look around with my phone"; drag.textContent = "Just drag to look";
    if (want === "goggles") { gog.className = "btn primary press"; mot.className = "btn glass press"; btns && btns.prepend(gog); }
    else if (want === "motion") { mot.className = "btn primary press"; gog.className = "btn glass press"; }
    card.hidden = false;
    mot.onclick = async () => { card.hidden = true; started = true; await setMotion(true); };
    gog.onclick = async () => { card.hidden = true; started = true; await setGoggles(true); };
    drag.onclick = () => { card.hidden = true; started = true; };
  }
  function close() {
    if (xr) return;
    running = false; cancelAnimationFrame(rafId);
    rt.forEach(r => r.el && r.el.tagName === "VIDEO" && r.el.pause());
    if (goggles) setGoggles(false);
  }
  const api = {
    open, close, select, get selected() { return selId; }, onSelect: f => { selCbs.add(f); return () => selCbs.delete(f); },
    turnTo, popOut, addFiles, blobURL, setMotion, get motion() { return motion; }, get ui() { return UI; }, setDot(v) { UI.dot = v; saveUI(); }, get dome() { return Rs; },
    thumbOf: id => { const r = rt.get(id); return r && r.el && (r.el.tagName === "IMG" || r.el.tagName === "CANVAS") ? r.el : null; },
    editing,
    _debug: () => ({ rt, rig, gazeId, get xr() { return xr; }, get gyro() { return gyro; }, get goggles() { return goggles; } }),
  };
  return api;
})();
