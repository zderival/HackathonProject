/* ========================================================================= SETTINGS → CSS */
const ACCENTS = ["#f0a25c", "#ff7a93", "#b79cff", "#7cc4ff", "#7fe0b4", "#f5e27a"];
function applySettings() {
  const st = S.settings, r = document.documentElement.style;
  r.setProperty("--blur", st.blur + "px");
  r.setProperty("--accent", st.accent);
  r.setProperty("--glass-a", { clear: .04, frosted: .10, tinted: .14 }[st.tint]);
  document.body.classList.toggle("calm", st.calm);
  $("#space").classList.toggle("reflect", st.reflections);
  $$(".dock, .topbar .search-field, .cap-card").forEach(el => el.classList.toggle("tinted", st.tint === "tinted"));
  $$('[data-panel="viewers"], [data-tab="viewers"]').forEach(el => el.style.display = st.showViewers ? "" : "none");
  if (!st.showViewers && curTab === "viewers") setTab("works");
  $("#artEdit").style.display = st.owner ? "" : "none";
  $("#editBtn").style.display = st.owner ? "" : "none";
  $("#donatePanel").style.display = st.donations ? "" : "none";
  STEP = st.curve; layoutRing();
}
function bindSettings() {
  $$("[data-s]").forEach(el => {
    const k = el.dataset.s, v = S.settings[k];
    if (el.type === "checkbox") el.checked = v; else el.value = v;
    const out = $(`[data-o="${k}"]`);
    const paint = () => { if (el.type === "range") { el.style.setProperty("--p", ((el.value - el.min) / (el.max - el.min) * 100) + "%"); if (out) out.textContent = el.value + (k === "blur" ? "px" : k === "curve" ? "°" : "%"); } };
    paint();
    el.addEventListener("input", () => {
      S.settings[k] = el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : el.value.trim();
      paint(); applySettings(); save();
      if (k === "currency" || k === "donateLink") renderDonate();
    });
  });
  $$("[data-seg]").forEach(g => {
    const k = g.dataset.seg;
    const sync = () => g.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === S.settings[k]));
    g.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; S.settings[k] = b.dataset.v; sync(); applySettings(); save(); });
    sync();
  });
  const sw = $("#swatches");
  sw.innerHTML = ACCENTS.map(c => `<button type="button" style="--c:${c}" data-c="${c}" aria-label="Accent ${c}"></button>`).join("");
  const syncSw = () => sw.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.c === S.settings.accent));
  sw.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; S.settings.accent = b.dataset.c; syncSw(); applySettings(); save(); renderImpact(); });
  syncSw();
  $("#resetBtn").onclick = () => { if (!confirmReset()) return; try { localStorage.removeItem(KEY); } catch {} location.hash = ""; location.reload(); };
}
let resetArmed = 0;
function confirmReset() { if (Date.now() - resetArmed < 3000) return true; resetArmed = Date.now(); toast("Tap Reset again to clear saved data"); return false; }
