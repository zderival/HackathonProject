/* ========================================================================= GLOBAL: keys, pointer shine, history */
document.addEventListener("keydown", e => {
  if (sheet.open) return;
  const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === "Escape" && artOpen) { closeArt(); return; }
  if (typing) return;
  if (route === "world") return;
  if (e.key === "/" ) { e.preventDefault(); setRoute("search"); return; }
  if (artOpen) { if (e.key === "ArrowLeft") artStep(-1); if (e.key === "ArrowRight") artStep(1); return; }
  if (route === "home") {
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
    if (e.key === "Enter" && document.activeElement === document.body && focusedIdx >= 0) openArt(view[focusedIdx]);
  }
});
// specular highlight tracks the pointer across whichever glass you're over
let shineEl = null;
document.addEventListener("pointermove", e => {
  const g = e.target.closest && e.target.closest(".glass");
  if (shineEl && shineEl !== g) shineEl.style.removeProperty("--shine");
  shineEl = g; if (!g) return;
  const r = g.getBoundingClientRect();
  g.style.setProperty("--mx", (e.clientX - r.left) + "px"); g.style.setProperty("--my", (e.clientY - r.top) + "px"); g.style.setProperty("--shine", 1);
}, { passive: true });
addEventListener("popstate", () => {
  const m = location.hash.match(/^#art\/(\d+)/);
  if (artOpen && !m) closeArt(true);
  else if (!artOpen && m) openArt(+m[1]);
  else if (!m) setRoute(location.hash.slice(1) || "home", false);
});
addEventListener("resize", () => { layoutRing(); sizeFlow(); moveBlob($(".dock"), $(`.dock button[aria-current="page"]`)); if (route === "profile") moveBlob($("#profTabs"), $(`#profTabs button[aria-selected="true"]`)); });
document.addEventListener("visibilitychange", () => { if (document.hidden) $("#timelapse").pause(); });

/* ========================================================================= BOOT */
bindSettings();
Studio.build();
renderIdentity();
renderChips();
buildRing();
applySettings();
sizeFlow();
requestAnimationFrame(frame);
(() => {
  const h = location.hash.slice(1), m = h.match(/^art\/(\d+)/);
  if (VRStore.viewerMode) setRoute("world", false); // pop-out window: just the dome, kept in sync with the editor
  else if (m && PIECES[+m[1]]) { history.replaceState(null, "", location.pathname); openArt(+m[1]); }
  else setRoute(["profile", "settings", "world"].includes(h) ? h : "home", false);
  requestAnimationFrame(() => moveBlob($(".dock"), $(`.dock button[aria-current="page"]`)));
})();
