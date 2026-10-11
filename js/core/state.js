/* STATE
   Saved settings, profile edits, likes and comments live in localStorage under one key. */
const KEY = "mya.gallery.v2";
const DEFAULTS = {
  profile: { name: "My World", handle: "@mya.art", bio: "Skies, lighting studies, characters and background paintings. Painting since 2021.", location: "", site: "", avatar: "" },
  settings: { blur: 26, tint: "frosted", accent: "#f0a25c", followHue: true, ambient: true, intensity: 60, autoRotate: true, curve: 22, reflections: true, calm: false, showViewers: true, allowComments: true, owner: true, donations: true, donateLink: "", currency: "$" },
  following: false, likes: {}, comments: { profile: [], art: {} }, cLikes: {}, edits: {}, me: { name: "" },
};
let S;
try { S = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { S = null; }
S = deepMerge(structuredClone(DEFAULTS), S || {});
if (S.profile.name === "MyA") S.profile.name = "My World"; // old default name
if (matchMedia("(prefers-reduced-motion: reduce)").matches && !S._rmSeen) { S.settings.calm = true; S._rmSeen = true; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }
function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object") deepMerge(a[k], b[k]); else a[k] = b[k]; } return a; }
