/* VR DATA
   Background presets and the schema that builds the background editor.
   To add a preset, add an entry to PRESETS (it only needs the keys that differ from DEFAULT_BG).
   To add a control, add a row to SCHEMA and read the same key in world.js. */
const VRData = (() => {
  const DEFAULT_BG = {
    preset: "lastLight",
    // sky
    skyMode: "procedural", top: "#1c2459", mid: "#f09a58", bot: "#1d1024", horizon: .55,
    sunOn: true, sunCol: "#ffd7a0", sunAz: 10, sunEl: 4, sunSize: 1, sunK: 1,
    clouds: 1, cloudSpeed: 1, cloudCol: "#ffcf9e",
    stars: .25, twinkle: .6, neb: 0, nebCol: "#ff9a6b", nebScale: 1,
    aurora: 0, aurA: "#59f0c8", aurB: "#7a5cff",
    // 360 / backdrop image
    pano: "", panoName: "", panoOp: 1, panoRot: 0, panoZoom: 1, panoX: 0, panoY: 0,
    // dome + floor
    shell: "glass", shellCol: "#ffd7a0", shellOp: .5,
    floorOn: true, floorStyle: "rings", floor: "#2b1828", glow: "#f0a25c", floorGlow: 1, floorScale: 1, rim: 1,
    // light ribbons
    ribOn: true, rib1: "#ffb36b", rib2: "#ff7a93", rib3: "#ffd9a0", ribK: 1, ribSpeed: 1, ribLayers: 3,
    // particles
    partOn: true, partStyle: "dust", partCol: "#ffd29a", partCount: 700, partSize: 1, partSpeed: 1,
    // props around the rim
    decor: "islands", decorK: 1, decorCol: "#8b6f9a",
    // overall look
    bright: 1, contrast: 1, sat: 1, hue: 0, tint: "#8ca576", tintK: 0, fog: .35, fogCol: "#4a2a3a", motion: 1,
  };

  const PRESETS = {
    lastLight: { name: "Last Light" },
    glum: { name: "Glumshroom", top: "#06161f", mid: "#1f6e66", bot: "#030d0c", sunCol: "#9fffe0", sunAz: -140, sunEl: 8, clouds: .45, cloudCol: "#9fffe0", stars: .6, neb: .35, nebCol: "#2fd1b0", shellCol: "#59f0c8", floor: "#0b2421", glow: "#59f0c8", rib1: "#59f0c8", rib2: "#7cc4ff", rib3: "#c4ff8a", partStyle: "fireflies", partCol: "#b8ff9e", decor: "mushrooms", fogCol: "#0e3330" },
    redRoom: { name: "Red Room", top: "#160206", mid: "#8e0f24", bot: "#0b0204", sunCol: "#ff5a6a", sunAz: 0, sunEl: 20, clouds: 0, stars: 0, neb: .7, nebCol: "#ff2a4a", shellCol: "#ff4d63", floor: "#200508", glow: "#ff4d63", rib1: "#ff4d63", rib2: "#ff9a6b", rib3: "#ff2a8a", partStyle: "embers", partCol: "#ff9aa6", decor: "shards", fogCol: "#3a0810" },
    cosmos: { name: "Cosmos", top: "#020310", mid: "#18256a", bot: "#02030c", sunCol: "#a8c8ff", sunAz: 40, sunEl: 15, clouds: 0, stars: 1, neb: 1, nebCol: "#6b4bff", shellCol: "#7cc4ff", floor: "#070b22", glow: "#7cc4ff", rib1: "#7cc4ff", rib2: "#b79cff", rib3: "#59f0e0", partCol: "#cfe0ff", decor: "planet", fogCol: "#0a1033" },
    dawn: { name: "Soft Dawn", top: "#5c6bb5", mid: "#ffc0b8", bot: "#3a2f4d", horizon: .7, sunCol: "#fff1d0", sunAz: 160, sunEl: 3, sunSize: 1.4, clouds: .8, cloudCol: "#ffe2dc", stars: 0, neb: 0, shellCol: "#ffffff", shellOp: .35, floor: "#3b3050", glow: "#ffd3c4", floorStyle: "water", rib1: "#ffd3c4", rib2: "#bfd4ff", rib3: "#ffeab8", partStyle: "dust", partCol: "#fff1e0", decor: "orbs", decorCol: "#fff0d8", fogCol: "#6b5a7c" },
    deepSea: { name: "Deep Sea", top: "#001a2c", mid: "#05566e", bot: "#00070d", sunOn: false, clouds: 0, stars: 0, neb: .5, nebCol: "#10c8c0", aurora: .3, aurA: "#38f0d0", aurB: "#2f7bff", shell: "rings", shellCol: "#38f0d0", floor: "#03222c", glow: "#38f0d0", floorStyle: "water", rib1: "#38f0d0", rib2: "#2f9bff", rib3: "#8affea", partStyle: "snow", partCol: "#a8fff0", partSpeed: .5, decor: "orbs", decorCol: "#7ff5e0", fogCol: "#02303d", fog: .5 },
    paper: { name: "Paper Studio", top: "#e9e4dc", mid: "#f6f2ea", bot: "#cfc8bc", horizon: .9, sunOn: false, clouds: 0, stars: 0, neb: 0, shell: "none", shellCol: "#ffffff", floor: "#dcd5c9", glow: "#ffffff", floorStyle: "grid", floorGlow: .35, floorScale: 1, rim: .5, ribOn: false, partOn: false, decor: "none", fog: 0, fogCol: "#e9e4dc", bright: 1, contrast: .95 },
    aurora: { name: "Aurora", top: "#02060f", mid: "#0b2a3a", bot: "#02060a", sunOn: false, clouds: 0, stars: .9, twinkle: 1, neb: .2, nebCol: "#3b7bff", aurora: 1, aurA: "#59f0a8", aurB: "#8a5cff", shell: "lattice", shellCol: "#9fffd8", shellOp: .35, floor: "#06141c", glow: "#59f0a8", floorStyle: "spokes", rib1: "#59f0a8", rib2: "#8a5cff", rib3: "#7cc4ff", partStyle: "fireflies", partCol: "#c8ffe8", decor: "crystals", decorCol: "#7cf0d0", fogCol: "#06202a" },
    void: { name: "Void", top: "#000000", mid: "#07070b", bot: "#000000", sunOn: false, clouds: 0, stars: 0, neb: 0, shell: "none", floor: "#050507", glow: "#ffffff", floorStyle: "plain", floorGlow: .25, rim: .5, ribOn: false, partOn: false, decor: "none", fog: 0, fogCol: "#000000" },
  };
  const PKEYS = Object.keys(PRESETS);
  const presetBg = k => ({ ...DEFAULT_BG, ...PRESETS[k], preset: k });
  const swatch = k => { const p = presetBg(k); return `linear-gradient(180deg,${p.top},${p.mid} 62%,${p.floor})`; };

  const OPT = (...a) => a.map(v => Array.isArray(v) ? { v: v[0], l: v[1] } : { v, l: v[0].toUpperCase() + v.slice(1) });
  /* every row becomes a control in the Background tab */
  const SCHEMA = [
    { id: "sky", title: "Sky", open: true, items: [
      { k: "skyMode", t: "select", l: "Sky type", o: OPT(["procedural", "Painted sky"], ["panorama", "My own image"]) },
      { k: "top", t: "color", l: "Top" }, { k: "mid", t: "color", l: "Horizon glow" }, { k: "bot", t: "color", l: "Below horizon" },
      { k: "horizon", t: "range", l: "Gradient reach", min: .2, max: 1.2, step: .01, show: v => v.skyMode !== "panorama" },
    ] },
    { id: "pano", title: "Your own image", items: [
      { k: "pano", t: "image", l: "Upload a 360° or wide image", note: "Used exactly as you upload it. A 2:1 panorama wraps the full dome." },
      { k: "panoOp", t: "range", l: "Opacity", min: 0, max: 1, step: .01 },
      { k: "panoRot", t: "range", l: "Turn", min: -180, max: 180, step: 1, u: "°" },
      { k: "panoZoom", t: "range", l: "Zoom", min: .5, max: 4, step: .01, u: "×" },
      { k: "panoX", t: "range", l: "Shift left / right", min: -1, max: 1, step: .01 },
      { k: "panoY", t: "range", l: "Shift up / down", min: -1, max: 1, step: .01 },
    ] },
    { id: "sun", title: "Sun & light", items: [
      { k: "sunOn", t: "toggle", l: "Show sun" },
      { k: "sunCol", t: "color", l: "Color" },
      { k: "sunAz", t: "range", l: "Direction", min: -180, max: 180, step: 1, u: "°" },
      { k: "sunEl", t: "range", l: "Height", min: -10, max: 80, step: 1, u: "°" },
      { k: "sunSize", t: "range", l: "Glow size", min: .3, max: 2.5, step: .01 },
      { k: "sunK", t: "range", l: "Strength", min: 0, max: 2, step: .01 },
    ] },
    { id: "air", title: "Clouds, stars & aurora", items: [
      { k: "clouds", t: "range", l: "Clouds", min: 0, max: 1, step: .01 },
      { k: "cloudCol", t: "color", l: "Cloud color" },
      { k: "cloudSpeed", t: "range", l: "Cloud drift", min: 0, max: 3, step: .01 },
      { k: "stars", t: "range", l: "Stars", min: 0, max: 1, step: .01 },
      { k: "twinkle", t: "range", l: "Twinkle", min: 0, max: 1, step: .01 },
      { k: "neb", t: "range", l: "Nebula", min: 0, max: 1, step: .01 },
      { k: "nebCol", t: "color", l: "Nebula color" },
      { k: "nebScale", t: "range", l: "Nebula size", min: .5, max: 3, step: .01 },
      { k: "aurora", t: "range", l: "Aurora", min: 0, max: 1, step: .01 },
      { k: "aurA", t: "color", l: "Aurora A" }, { k: "aurB", t: "color", l: "Aurora B" },
    ] },
    { id: "dome", title: "Dome & floor", items: [
      { k: "shell", t: "select", l: "Dome shell", o: OPT(["glass", "Soft glass"], ["lattice", "Lattice"], ["rings", "Rings"], ["none", "None"]) },
      { k: "shellCol", t: "color", l: "Shell color", show: v => v.shell !== "none" },
      { k: "shellOp", t: "range", l: "Shell strength", min: 0, max: 1, step: .01, show: v => v.shell !== "none" },
      { k: "floorOn", t: "toggle", l: "Show floor" },
      { k: "floorStyle", t: "select", l: "Floor pattern", o: OPT(["rings", "Glow rings"], ["grid", "Grid"], ["checker", "Checker"], ["spokes", "Spokes"], ["water", "Water"], ["plain", "Plain"]), show: v => v.floorOn },
      { k: "floor", t: "color", l: "Floor color", show: v => v.floorOn }, { k: "glow", t: "color", l: "Glow color", show: v => v.floorOn },
      { k: "floorGlow", t: "range", l: "Glow strength", min: 0, max: 2, step: .01, show: v => v.floorOn },
      { k: "floorScale", t: "range", l: "Pattern size", min: .3, max: 3, step: .01, show: v => v.floorOn },
      { k: "rim", t: "range", l: "Edge light", min: 0, max: 2, step: .01, show: v => v.floorOn },
    ] },
    { id: "rib", title: "Light ribbons", items: [
      { k: "ribOn", t: "toggle", l: "Show ribbons" },
      { k: "ribLayers", t: "range", l: "Layers", min: 1, max: 3, step: 1, show: v => v.ribOn },
      { k: "rib1", t: "color", l: "Color 1", show: v => v.ribOn }, { k: "rib2", t: "color", l: "Color 2", show: v => v.ribOn }, { k: "rib3", t: "color", l: "Color 3", show: v => v.ribOn },
      { k: "ribK", t: "range", l: "Brightness", min: 0, max: 2, step: .01, show: v => v.ribOn },
      { k: "ribSpeed", t: "range", l: "Flow speed", min: 0, max: 3, step: .01, show: v => v.ribOn },
    ] },
    { id: "part", title: "Particles", items: [
      { k: "partOn", t: "toggle", l: "Show particles" },
      { k: "partStyle", t: "select", l: "Style", o: OPT(["dust", "Floating dust"], ["fireflies", "Fireflies"], ["snow", "Snow"], ["embers", "Embers"]), show: v => v.partOn },
      { k: "partCol", t: "color", l: "Color", show: v => v.partOn },
      { k: "partCount", t: "range", l: "Amount", min: 100, max: 2000, step: 50, show: v => v.partOn },
      { k: "partSize", t: "range", l: "Size", min: .3, max: 3, step: .01, show: v => v.partOn },
      { k: "partSpeed", t: "range", l: "Speed", min: 0, max: 3, step: .01, show: v => v.partOn },
    ] },
    { id: "decor", title: "Props around the edge", items: [
      { k: "decor", t: "select", l: "Style", o: OPT(["none", "None"], ["islands", "Floating islands"], ["mushrooms", "Glow mushrooms"], ["shards", "Red shards"], ["crystals", "Crystals"], ["orbs", "Floating orbs"], ["planet", "Planet & ring"]) },
      { k: "decorCol", t: "color", l: "Color", show: v => ["islands", "crystals", "orbs"].includes(v.decor) },
      { k: "decorK", t: "range", l: "Size", min: .4, max: 2, step: .01, show: v => v.decor !== "none" },
    ] },
    { id: "look", title: "Overall look", items: [
      { k: "bright", t: "range", l: "Brightness", min: .4, max: 1.8, step: .01 },
      { k: "contrast", t: "range", l: "Contrast", min: .6, max: 1.6, step: .01 },
      { k: "sat", t: "range", l: "Color intensity", min: 0, max: 1.8, step: .01 },
      { k: "hue", t: "range", l: "Shift colors", min: -180, max: 180, step: 1, u: "°" },
      { k: "tint", t: "color", l: "Color wash" },
      { k: "tintK", t: "range", l: "Wash strength", min: 0, max: .7, step: .01 },
      { k: "fog", t: "range", l: "Haze", min: 0, max: 1, step: .01 },
      { k: "fogCol", t: "color", l: "Haze color" },
      { k: "motion", t: "range", l: "Motion", min: 0, max: 2, step: .01 },
    ] },
  ];

  const FONTS = [
    { v: "display", l: "Bricolage", css: '"Bricolage Grotesque", system-ui, sans-serif' },
    { v: "body", l: "Figtree", css: '"Figtree", system-ui, sans-serif' },
    { v: "mono", l: "DM Mono", css: '"DM Mono", ui-monospace, monospace' },
    { v: "serif", l: "Serif", css: 'Georgia, "Times New Roman", serif' },
    { v: "hand", l: "Handwritten", css: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive' },
  ];

  return { DEFAULT_BG, PRESETS, PKEYS, presetBg, swatch, SCHEMA, FONTS };
})();
