/* ========================================================================= ROUTING + DOCK */
let route = "home";
function setRoute(r, push = true) {
  if (r === "search") { setRoute("home"); focusSearch(); return; }
  route = r;
  ["home", "profile", "settings", "world"].forEach(v => $("#" + v).classList.toggle("on", v === r));
  if (r === "world") { $("#timelapse").pause(); World.open(); } else if (typeof World !== "undefined") World.close();
  $("#search").style.visibility = r === "home" ? "" : "hidden";
  $$(".dock button").forEach(b => b.toggleAttribute("aria-current", b.dataset.go === r) || b.removeAttribute("aria-current"));
  $$(".dock button").forEach(b => { if (b.dataset.go === r) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  moveBlob($(".dock"), $(`.dock button[data-go="${r}"]`));
  if (r === "profile") { renderProfile(); setTab(curTab); }
  if (push && !artOpen && !VRStore.joinMode) history.replaceState(null, "", r === "home" ? location.pathname + location.search : "#" + r);
}
function moveBlob(container, btn) {
  if (!btn) return;
  const blob = container.querySelector(".blob");
  blob.style.width = btn.offsetWidth + "px";
  blob.style.transform = `translateX(${btn.offsetLeft - (container.classList.contains("dock") ? 6 : 0)}px)`;
  container.classList.remove("stretch"); void container.offsetWidth; container.classList.add("stretch");
}
$("#dock").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setRoute(b.dataset.go); });
$("#brandBtn").onclick = () => setRoute("home");
$("#meBtn").onclick = () => setRoute("profile");

// The search bar fades back in when we return home, and a hidden input silently ignores focus(),
// so keep trying for a moment (about 1s) until it takes.
function focusSearch() {
  let tries = 0;
  const t = setInterval(() => { qEl.focus(); if (document.activeElement === qEl || ++tries > 20) clearInterval(t); }, 50);
}
