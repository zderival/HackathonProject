/* SCENEMAP: translates between My World's dome and the backend's scene document, in both directions.

   The dome (what you edit)                      The backend scene (what is stored and shared)
   ───────────────────────                       ──────────────────────────────────────────────
   a picture: azimuth, height, distance, size    an "artwork" node at a position on a ring around the viewer,
   tilt, frame, caption, hidden                  rotated to face the centre; the image is an uploaded asset
   a text card                                   a "text" node (500 characters at most)
   the background (about 60 settings)            a "group" node  mw-bg   with the full settings in ext.bg
   the dome size                                 a "group" node  mw-dome with ext.myWorld.dome
   sky colours, fog, ambient light               scene.environment (so any other client sees a sensible sky)
   the camera                                    scene.viewerAnchor  [0, 1.6, 0]

   Each item node also keeps its exact My World numbers in ext.myWorld, so nothing is lost to rounding. If somebody
   else (another client, the assistant) moves the node, the position in the node wins and the numbers are re-derived.

   The backend only accepts operations, so this file also turns "what changed" into the smallest list of operations
   (diff), and applies the backend's change notifications to a local copy of the scene (applyWire).
   Videos are not part of the backend's asset model (images only), so they stay local to the device. */
const SceneMap = (() => {
  const DEG = Math.PI / 180, RAD = 180 / Math.PI;
  const DOME_ID = "mw-dome", BG_ID = "mw-bg";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (v, p = 4) => { const k = 10 ** p; return Math.round(v * k) / k; };
  const near = (a, b, e = 1e-3) => Math.abs((+a || 0) - (+b || 0)) <= e;
  const clone = x => JSON.parse(JSON.stringify(x));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const FRAME_OUT = { none: "none", thin: "thin", plate: "classic" }, FRAME_IN = { none: "none", thin: "thin", classic: "plate", modern: "plate", ornate: "plate" };
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const hex = (v, d) => (HEX.test(v) ? v.toLowerCase() : d);
  const data = () => (typeof VRData !== "undefined" ? VRData : SceneMap.__data);
  const textDefaults = () => (typeof VRStore !== "undefined" ? VRStore.TEXT_DEFAULTS : SceneMap.__text);

  /* -------- geometry -------- */
  const posOf = (az, h, d) => [rnd(Math.sin(az * DEG) * d), rnd(h), rnd(-Math.cos(az * DEG) * d)].map(v => clamp(v, -500, 500));
  // model matrix in the dome is T · Ry(yaw) · Rx(tilt), with yaw = -azimuth
  function quatOf(az, tiltDeg) {
    const y = -az * DEG / 2, x = tiltDeg * DEG / 2, cy = Math.cos(y), sy = Math.sin(y), cx = Math.cos(x), sx = Math.sin(x);
    return [cy * sx, cx * sy, -sy * sx, cy * cx].map(v => rnd(v, 6));
  }
  function anglesOf(q) { // inverse of quatOf: { yawDeg, tiltDeg }
    const [x, y, z, w] = q, r02 = 2 * (x * z + w * y), r22 = 1 - 2 * (x * x + y * y), r12 = 2 * (y * z - w * x), r11 = 1 - 2 * (x * x + z * z);
    return { yaw: Math.atan2(r02, r22) * RAD, tilt: Math.atan2(-r12, r11) * RAD };
  }
  const dims = (size, ar) => { const s = clamp(size, 0.01, 20), a = clamp(ar || 1, 0.05, 20); return a >= 1 ? [s, clamp(s / a, 0.01, 20)] : [clamp(s * a, 0.01, 20), s]; };
  const wrap180 = a => ((a + 540) % 360) - 180;

  /* -------- item <-> node -------- */
  const TEXT_KEYS = ["font", "weight", "fs", "color", "align", "card", "cardCol", "cardOp", "width"];
  function extOf(it) {
    const e = { v: 1, t: it.type === "text" ? "text" : "image", az: rnd(it.az, 3), h: rnd(it.h, 3), d: rnd(it.d, 3), size: rnd(it.size, 3), tilt: rnd(it.tilt || 0, 2), frame: it.frame || "none", caption: !!it.caption, ar: rnd(it.ar || 1, 4), o: it.o == null ? 1e6 : it.o };
    if (it.type === "text") { e.text = {}; TEXT_KEYS.forEach(k => { if (it.text && it.text[k] !== undefined) e.text[k] = it.text[k]; }); }
    return e;
  }
  const frameOf = f => ({ style: FRAME_OUT[f] || "none", color: "#f5f1ea", width: f === "none" || !f ? 0 : f === "thin" ? 0.02 : 0.06, depth: f === "none" || !f ? 0 : 0.03, matColor: "#ffffff", matWidth: f === "plate" ? 0.04 : 0 });
  function textProps(it) {
    const t = { ...textDefaults(), ...(it.text || {}) };
    return { text: String(t.body || "").slice(0, 500), fontSize: rnd(clamp(0.2 * (t.fs || 1), 0.01, 5), 3), color: hex(t.color, "#ffffff"), align: ["left", "center", "right"].includes(t.align) ? t.align : "center", maxWidth: rnd(clamp(it.size * (t.width || 1), 0.1, 50), 3), backgroundColor: t.card ? hex(t.cardCol, "#1b1724") : null, billboard: false };
  }
  function itemToNode(it) {
    const base = { id: it.id, parentId: null, name: String(it.name || "").slice(0, 120), visible: !it.hidden, locked: false, transform: { position: posOf(it.az, it.h, it.d), rotation: quatOf(it.az, it.tilt || 0), scale: [1, 1, 1] }, ext: { myWorld: extOf(it) } };
    if (it.type === "text") return { ...base, type: "text", props: textProps(it) };
    const [w, h] = dims(it.size, it.ar);
    return { ...base, type: "artwork", props: { assetId: it.assetId || null, width: rnd(w), height: rnd(h), fit: "stretch", title: String(it.name || "").slice(0, 200), description: "", attribution: "", frame: frameOf(it.frame) } };
  }
  function nodeToItem(n, prev) {
    const ex = n.ext && n.ext.myWorld && typeof n.ext.myWorld === "object" ? n.ext.myWorld : null, p = n.transform.position;
    let az, h, d;
    if (ex && ex.az != null && ex.h != null && ex.d != null && posOf(ex.az, ex.h, ex.d).every((v, i) => near(v, p[i], 2e-3))) { az = ex.az; h = ex.h; d = ex.d; }
    else { d = rnd(Math.hypot(p[0], p[2]), 3); az = d < 0.01 ? (ex ? ex.az : 0) : rnd(Math.atan2(p[0], -p[2]) * RAD, 3); h = rnd(p[1], 3); }
    const ang = anglesOf(n.transform.rotation);
    let tilt = rnd(clamp(ang.tilt, -30, 30), 2); if (ex && near(ex.tilt, tilt, 0.05)) tilt = ex.tilt;
    const it = { id: n.id, type: n.type === "text" ? "text" : "image", name: n.name || (n.props && n.props.title) || "", az: wrap180(az), h, d, tilt, hidden: !n.visible, caption: ex ? !!ex.caption : false, o: ex && ex.o != null ? ex.o : 1e6 };
    if (n.type === "text") {
      const pr = n.props, t = { ...textDefaults(), ...(ex && ex.text ? ex.text : {}) };
      if (!ex || !ex.text) { t.color = pr.color; t.align = pr.align; t.card = !!pr.backgroundColor; if (pr.backgroundColor) t.cardCol = pr.backgroundColor; t.fs = clamp(pr.fontSize / 0.2, 0.3, 3); }
      t.body = pr.text; it.text = t; it.size = ex && ex.size != null ? ex.size : rnd(clamp(pr.maxWidth / (t.width || 1), 0.3, 6), 2); it.ar = (prev && prev.ar) || (ex && ex.ar) || 2.4; it.frame = "none";
    } else {
      const pr = n.props, ar = pr.width / pr.height, size = ar >= 1 ? pr.width : pr.height;
      it.ar = ex && near(ex.ar, ar, 2e-3) ? ex.ar : rnd(ar, 4); it.size = ex && near(ex.size, size, 2e-3) ? ex.size : rnd(size, 3);
      const fr = FRAME_IN[pr.frame && pr.frame.style] || "none"; it.frame = ex && ex.frame && FRAME_OUT[ex.frame] === (pr.frame && pr.frame.style) ? ex.frame : fr;
      it.assetId = pr.assetId || "";
      if (it.assetId) it.mediaId = prev && prev.assetId === it.assetId && prev.mediaId ? prev.mediaId : "a_" + it.assetId;
    }
    return it;
  }

  /* -------- background <-> environment -------- */
  function envOf(bg) {
    return { backgroundColor: hex(bg.mid, "#0b0a12"), skybox: "gradient", gradientTopColor: hex(bg.top, "#1c2459"), gradientBottomColor: hex(bg.bot, "#1d1024"), ambientColor: hex(bg.sunCol, "#ffffff"), ambientIntensity: rnd(clamp(0.4 + 0.6 * (bg.bright ?? 1), 0, 10), 2), fog: { enabled: (bg.fog || 0) > 0.01, color: hex(bg.fogCol, "#4a2a3a"), near: 8, far: Math.round(clamp(60 - 40 * (bg.fog || 0), 10, 200)) } };
  }
  const bgForServer = bg => { const o = { ...bg }; delete o.pano; if (bg.pano && String(bg.pano).startsWith("a_")) o.panoAsset = String(bg.pano).slice(2); else if (!bg.panoAsset) o.panoAsset = ""; if (JSON.stringify(o).length > 3800) delete o.panoName; return o; };
  function bgOf(scene) {
    const D = data(), node = scene.nodes[BG_ID], stored = node && node.ext && node.ext.bg ? node.ext.bg : null;
    const bg = stored ? { ...D.DEFAULT_BG, ...stored } : D.presetBg("lastLight");
    const env = scene.environment, mine = envOf(bg);
    // somebody changed the sky from outside My World (another client, the assistant): their colours win
    if (env) {
      if (env.gradientTopColor && env.gradientTopColor.toLowerCase() !== mine.gradientTopColor) bg.top = env.gradientTopColor.toLowerCase();
      if (env.gradientBottomColor && env.gradientBottomColor.toLowerCase() !== mine.gradientBottomColor) bg.bot = env.gradientBottomColor.toLowerCase();
      if (env.backgroundColor && env.backgroundColor.toLowerCase() !== mine.backgroundColor) bg.mid = env.backgroundColor.toLowerCase();
      if (env.ambientColor && env.ambientColor.toLowerCase() !== mine.ambientColor) bg.sunCol = env.ambientColor.toLowerCase();
      if (env.fog && env.fog.color && env.fog.color.toLowerCase() !== mine.fog.color) bg.fogCol = env.fog.color.toLowerCase();
      if (env.fog && env.fog.enabled === false && mine.fog.enabled) bg.fog = 0;
    }
    bg.pano = bg.panoAsset ? "a_" + bg.panoAsset : ""; delete bg.panoAsset;
    return bg;
  }

  /* -------- scene -> model -------- */
  const isItemNode = n => !n.parentId && (n.type === "artwork" || n.type === "text") && !String(n.id).startsWith("mw-");
  function fromScene(scene, prev) {
    const prevById = new Map(((prev && prev.items) || []).map(i => [i.id, i]));
    const items = Object.values(scene.nodes).filter(isItemNode).map(n => nodeToItem(n, prevById.get(n.id)));
    items.sort((a, b) => (a.o - b.o) || (a.id < b.id ? -1 : 1));
    const dome = scene.nodes[DOME_ID] && scene.nodes[DOME_ID].ext && scene.nodes[DOME_ID].ext.myWorld ? +scene.nodes[DOME_ID].ext.myWorld.dome : 4.5;
    return { view: { dome: clamp(dome || 4.5, 3, 10) }, bg: bgOf(scene), items };
  }
  const hasDome = scene => !!(scene.nodes[DOME_ID] || scene.nodes[BG_ID]);
  const hasContent = scene => Object.values(scene.nodes).some(isItemNode);

  /* -------- model -> desired pieces, and the diff against the server's copy -------- */
  const pushable = it => it.type === "text" || (it.type === "image" && !!it.assetId);
  function groupNode(id, name, ext) { return { id, type: "group", name, parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true, locked: true, props: {}, ext }; }

  function diff(model, mirror) {
    const ch = [], nodes = mirror.nodes;
    // environment (sky colours, fog) derived from the background
    const wantEnv = envOf(model.bg), haveEnv = mirror.environment || {};
    Object.keys(wantEnv).forEach(k => {
      if (k === "fog") Object.keys(wantEnv.fog).forEach(fk => { if (!same(wantEnv.fog[fk], (haveEnv.fog || {})[fk])) ch.push({ kind: "scene.set", path: `environment.fog.${fk}`, value: wantEnv.fog[fk] }); });
      else if (!same(wantEnv[k], haveEnv[k])) ch.push({ kind: "scene.set", path: `environment.${k}`, value: wantEnv[k] });
    });
    // dome + background nodes
    const domeExt = { myWorld: { v: 1, dome: rnd(model.view.dome, 2) } }, bgExt = { bg: bgForServer(model.bg) };
    [[DOME_ID, "My World dome", domeExt, "myWorld"], [BG_ID, "My World background", bgExt, "bg"]].forEach(([id, name, ext, key]) => {
      if (!nodes[id]) ch.push({ kind: "node.add", node: groupNode(id, name, ext) });
      else if (!same(nodes[id].ext && nodes[id].ext[key], ext[key])) ch.push({ kind: "node.set", nodeId: id, path: `ext.${key}`, value: ext[key] });
    });
    // items: new ones are added once they can be shown to others (pictures need their uploaded asset); existing ones are diffed
    const ids = new Set(model.items.map(i => i.id));
    model.items.forEach(it => {
      const m = nodes[it.id];
      if (m) { if (isItemNode(m)) ch.push(...itemDiff(it, m)); }
      else if (pushable(it)) ch.push({ kind: "node.add", node: itemToNode(it) });
    });
    Object.values(nodes).forEach(n => { if (isItemNode(n) && !ids.has(n.id)) ch.push({ kind: "node.remove", nodeId: n.id }); });
    return ch;
  }
  function itemDiff(want, mnode) {
    const cur = nodeToItem(mnode, want), out = [], set = (path, value) => out.push({ kind: "node.set", nodeId: want.id, path, value });
    const posCh = !near(cur.az, want.az, 5e-3) || !near(cur.h, want.h) || !near(cur.d, want.d);
    const rotCh = !near(cur.az, want.az, 5e-3) || !near(cur.tilt, want.tilt || 0, 0.02);
    const dimCh = want.type === "image" && (!near(cur.size, want.size, 2e-3) || !near(cur.ar, want.ar, 2e-3));
    const frameCh = want.type === "image" && cur.frame !== (want.frame || "none");
    const nameCh = (cur.name || "") !== (want.name || "");
    const hidCh = !!cur.hidden !== !!want.hidden;
    const assetCh = want.type === "image" && (cur.assetId || "") !== (want.assetId || "");
    const capCh = !!cur.caption !== !!want.caption;
    const n = itemToNode(want);
    const textCh = want.type === "text" && ["text", "fontSize", "color", "align", "maxWidth", "backgroundColor"].some(k => !same(n.props[k], mnode.props[k]));
    if (posCh) set("transform.position", n.transform.position);
    if (rotCh) set("transform.rotation", n.transform.rotation);
    if (dimCh) { set("props.width", n.props.width); set("props.height", n.props.height); }
    if (frameCh) set("props.frame", n.props.frame);
    if (nameCh) { set("name", n.name); if (want.type === "image") set("props.title", n.props.title); }
    if (hidCh) set("visible", n.visible);
    if (assetCh) set("props.assetId", n.props.assetId);
    if (textCh) ["text", "fontSize", "color", "align", "maxWidth", "backgroundColor"].forEach(k => { if (!same(n.props[k], mnode.props[k])) set("props." + k, n.props[k]); });
    const any = posCh || rotCh || dimCh || frameCh || nameCh || hidCh || assetCh || capCh || textCh;
    const storedExt = mnode.ext && mnode.ext.myWorld;
    if (any || (storedExt && !same(extOf({ ...want, o: storedExt.o ?? want.o }), storedExt))) set("ext.myWorld", n.ext.myWorld);
    return out;
  }

  /* -------- wire changes <-> operations -------- */
  function toOps(changes) {
    const adds = [], sets = new Map(), rest = [], env = {};
    changes.forEach(c => {
      if (c.kind === "node.add") adds.push({ op: "node.add", node: c.node });
      else if (c.kind === "node.remove") rest.push({ op: "node.remove", nodeId: c.nodeId });
      else if (c.kind === "node.set") { if (!sets.has(c.nodeId)) sets.set(c.nodeId, {}); sets.get(c.nodeId)[c.path] = c.value; }
      else if (c.kind === "scene.set") { const p = c.path.split(".").slice(1); if (p[0] === "fog") (env.fog ||= {})[p[1]] = c.value; else env[p[0]] = c.value; }
    });
    const ops = [...adds, ...[...sets].map(([nodeId, set]) => ({ op: "node.update", nodeId, set }))];
    if (Object.keys(env).length) ops.push({ op: "scene.setEnvironment", environment: env });
    return [...ops, ...rest];
  }
  function setDeep(o, path, v) { const p = path.split("."); for (let i = 0; i < p.length - 1; i++) { if (o[p[i]] == null || typeof o[p[i]] !== "object") o[p[i]] = {}; o = o[p[i]]; } o[p[p.length - 1]] = clone(v); }
  function applyWire(scene, changes) {
    changes.forEach(c => {
      if (c.kind === "node.add") scene.nodes[c.node.id] = clone(c.node);
      else if (c.kind === "node.remove") { delete scene.nodes[c.nodeId]; Object.values(scene.nodes).forEach(n => { if (n.parentId === c.nodeId) delete scene.nodes[n.id]; }); }
      else if (c.kind === "node.set") { const n = scene.nodes[c.nodeId]; if (n) { if (c.path === "parentId") n.parentId = c.value; else setDeep(n, c.path, c.value); } }
      else if (c.kind === "scene.set") setDeep(scene, c.path, c.value);
    });
    return scene;
  }
  const emptyEnv = () => ({ backgroundColor: "#0b0a12", skybox: "gradient", gradientTopColor: "#1c2459", gradientBottomColor: "#1d1024", ambientColor: "#ffffff", ambientIntensity: 1, fog: { enabled: false, color: "#4a2a3a", near: 8, far: 60 } });

  return { DOME_ID, BG_ID, itemToNode, nodeToItem, fromScene, hasDome, hasContent, isItemNode, pushable, diff, toOps, applyWire, envOf, bgOf, posOf, quatOf, anglesOf, clone, same, emptyEnv, extOf };
})();
if (typeof module !== "undefined") module.exports = SceneMap;
