/* ========================================================================= SEARCH */
const qEl = $("#q"), searchEl = $("#search"), resList = $("#resList");
let resIdx = 0, resItems = [];
function runSearch() {
  const q = qEl.value.trim().toLowerCase();
  searchEl.classList.toggle("has-q", !!q);
  if (!q) { resItems = PIECES.map(p => p.id).slice(0, 6); }
  else {
    const terms = q.split(/\s+/);
    resItems = PIECES.map(p => piece(p.id)).map(p => {
      const hay = [p.t, p.k, p.d, p.desc || "", CATS.filter(c => c[0] !== "all" && c[2](p)).map(c => c[1]).join(" ")].join(" ").toLowerCase();
      if (!terms.every(t => hay.includes(t))) return null;
      return { id: p.id, s: (p.t.toLowerCase().startsWith(q) ? 3 : 0) + (p.t.toLowerCase().includes(q) ? 2 : 0) };
    }).filter(Boolean).sort((a, b) => b.s - a.s).map(x => x.id);
  }
  resIdx = 0;
  const hl = s => { let out = esc(s); if (q) q.split(/\s+/).forEach(t => { if (t) out = out.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<mark>$1</mark>"); }); return out; };
  resList.innerHTML = (q ? "" : `<div class="eyebrow" style="padding:8px 10px 6px">Recently added</div>`) +
    (resItems.length ? resItems.map((id, k) => { const p = piece(id); return `<button type="button" class="res" role="option" data-id="${id}" aria-selected="${k === 0}"><span class="th" style="--h:${p.hue}"><img src="${p.thumb}" alt="" onerror="this.remove()"></span><span><b>${hl(p.t)}</b><small>${hl(p.k)}</small></span><span class="d">${esc(p.d || "")}</span></button>`; }).join("")
      : `<div class="res-empty">Nothing matches “${esc(qEl.value)}”. Try “sky”, “character” or “08/26”.</div>`);
}
function openSearch() { searchEl.classList.add("open"); qEl.setAttribute("aria-expanded", "true"); runSearch(); }
function closeSearch() { searchEl.classList.remove("open"); qEl.setAttribute("aria-expanded", "false"); }
qEl.addEventListener("focus", openSearch);
qEl.addEventListener("input", runSearch);
qEl.addEventListener("keydown", e => {
  const opts = $$(".res");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!opts.length) return; resIdx = mod(resIdx + (e.key === "ArrowDown" ? 1 : -1), opts.length); opts.forEach((o, k) => o.setAttribute("aria-selected", k === resIdx)); opts[resIdx].scrollIntoView({ block: "nearest" }); }
  if (e.key === "Enter" && resItems.length) { e.preventDefault(); pickResult(resItems[resIdx], e.shiftKey); }
  if (e.key === "Escape") { qEl.blur(); closeSearch(); }
});
resList.addEventListener("pointerdown", e => e.preventDefault());
resList.addEventListener("click", e => { const b = e.target.closest(".res"); if (b) pickResult(+b.dataset.id); });
qEl.addEventListener("blur", () => setTimeout(closeSearch, 120));
$("#qClear").onclick = () => { qEl.value = ""; runSearch(); qEl.focus(); };
function pickResult(id, open) {
  closeSearch(); qEl.blur();
  if (!view.includes(id)) { curCat = "all"; renderChips(); view = PIECES.map(p => p.id); buildRing(); }
  setRoute("home");
  goTo(view.indexOf(id));
  setTimeout(() => openArt(id), open ? 0 : 650);
}
