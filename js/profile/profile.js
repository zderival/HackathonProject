/* ========================================================================= PROFILE */
let curTab = "works", relFilter = "all", relSort = "impact";
function followerCount() { return SAMPLE.base.followers + (S.following ? 1 : 0); }
function renderIdentity() {
  const pr = S.profile;
  const av = pr.avatar ? `<img src="${pr.avatar}" alt="">` : esc(initials(pr.name));
  ["#brandAv", "#topAv", "#profAv", "#artAv"].forEach(s => { $(s).innerHTML = av; $(s).style.setProperty("--h", 30); });
  const words = pr.name.trim().split(/\s+/), last = words.pop();
  $("#profName").innerHTML = (words.length ? esc(words.join(" ")) + " " : "") + `<span>${esc(last)}</span>`;
  document.title = "My World";
  $("#profBio").textContent = pr.bio;
  const site = pr.site ? (() => { try { const u = new URL(/^https?:/.test(pr.site) ? pr.site : "https://" + pr.site); return `<a href="${esc(u.href)}" target="_blank" rel="noopener">${esc(u.host)}</a>`; } catch { return ""; } })() : "";
  $("#profMeta").innerHTML = [esc(pr.handle), pr.location ? "📍 " + esc(pr.location) : "", site, "Joined 2021"].filter(Boolean).map(x => `<span>${x}</span>`).join("");
  $("#artByName").textContent = pr.name;
  syncFollow();
}
function syncFollow() {
  ["#followBtn", "#artFollow"].forEach(s => { const b = $(s); b.textContent = S.following ? "Following" : "Follow"; b.classList.toggle("on", S.following); b.setAttribute("aria-pressed", S.following); });
  $("#artByFol").textContent = fmt(followerCount()) + " followers";
  renderStats();
}
function toggleFollow() { S.following = !S.following; save(); syncFollow(); toast(S.following ? `You're following ${S.profile.name}` : "Unfollowed"); }
$("#followBtn").onclick = toggleFollow; $("#artFollow").onclick = toggleFollow;

function renderStats() {
  const views = SAMPLE.base.views + SAMPLE.stats.reduce((a, s) => 0, 0);
  const impact = Object.values(SAMPLE.REL).reduce((a, r) => a + r.total, 0);
  $("#stats").innerHTML = [
    ["works", PIECES.length, "Works"], ["followers", followerCount(), "Followers"], ["followers", SAMPLE.base.following, "Following"],
    ["viewers", views, "Views"], ["relations", impact, "Impacted", "hl"],
  ].filter(s => S.settings.showViewers || s[0] !== "viewers").map(([tab, n, l, c]) => `<button type="button" class="stat ${c || ""}" data-tab="${tab}"><b>${fmt(n)}</b><small>${l}</small></button>`).join("");
  $("#nWorks").textContent = PIECES.length; $("#nRel").textContent = fmt(impact); $("#nFol").textContent = fmt(followerCount());
  $("#nView").textContent = fmt(views); $("#nCom").textContent = allProfComments().length;
}
$("#stats").addEventListener("click", e => { const b = e.target.closest(".stat"); if (b) { setTab(b.dataset.tab); $("#profTabs").scrollIntoView({ behavior: "smooth", block: "start" }); } });

function setTab(t) {
  curTab = t;
  $$("#profTabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t));
  $$(".tabpanel").forEach(p => p.hidden = p.dataset.panel !== t);
  requestAnimationFrame(() => moveBlob($("#profTabs"), $(`#profTabs button[data-tab="${t}"]`)));
  ({ works: renderWorks, relations: renderRelations, followers: renderFollowers, viewers: renderViewers, comments: renderProfComments })[t]();
}
$("#profTabs").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setTab(b.dataset.tab); });

function renderProfile() { renderIdentity(); renderStats(); }

function renderWorks() {
  $("#wall").innerHTML = PIECES.map(p0 => { const p = piece(p0.id); return `<button type="button" class="tile" style="--ar:${p.ar}" data-id="${p.id}" aria-label="Open ${esc(p.t)}">${imgHTML(p)}<span class="lbl glass">${esc(p.t)}${p.d ? ` <span style="font:400 11px var(--mono);color:var(--accent)">${esc(p.d)}</span>` : ""}</span></button>`; }).join("");
}
$("#wall").addEventListener("click", e => { const b = e.target.closest(".tile"); if (b) openArt(+b.dataset.id, PIECES.map(p => p.id)); });

function renderImpact() {
  const R2 = SAMPLE.REL, total = Object.values(R2).reduce((a, r) => a + r.total, 0);
  let off = 0; const C = 2 * Math.PI * 50;
  $("#impactSvg").innerHTML = `<circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="12"/>` +
    Object.values(R2).map(r => { const len = r.total / total * C; const s = `<circle cx="60" cy="60" r="50" fill="none" stroke="${r.c}" stroke-width="12" stroke-dasharray="${Math.max(0, len - 2)} ${C}" stroke-dashoffset="${-off}" stroke-linecap="round"/>`; off += len; return s; }).join("");
  countUp($("#impactTotal"), total);
  const max = Math.max(...Object.values(R2).map(r => r.total));
  $("#impactBars").innerHTML = Object.entries(R2).map(([k, r]) => `<div class="ibar" style="--c:${r.c}"><span><i></i>${r.label}</span><div class="track"><div class="fill" data-w="${r.total / max * 100}"></div></div><b>${r.total.toLocaleString()}</b></div>`).join("");
  requestAnimationFrame(() => requestAnimationFrame(() => $$("#impactBars .fill").forEach(f => f.style.width = f.dataset.w + "%")));
}
function countUp(el, n) {
  if (S.settings.calm) { el.textContent = n.toLocaleString(); return; }
  const t0 = performance.now(); const step = now => { const k = Math.min(1, (now - t0) / 1200), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(n * e).toLocaleString(); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step);
}
function renderRelations() {
  renderImpact();
  const R2 = SAMPLE.REL;
  $("#relChips").innerHTML = [["all", "Everyone"], ...Object.entries(R2).map(([k, r]) => [k, r.label])].map(([k, l]) => `<button type="button" class="chip glass press" data-f="${k}" aria-pressed="${k === relFilter}">${l}</button>`).join("");
  $$("#relSort button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === relSort));
  let list = SAMPLE.relations.filter(r => relFilter === "all" || r.type === relFilter);
  list = list.sort((a, b) => relSort === "impact" ? b.impact - a.impact : a.days - b.days);
  $("#people").innerHTML = list.map(r => {
    const p = person(r.person), T = R2[r.type], pc = piece(r.piece);
    const unit = r.type === "inspired" ? "pieces made" : r.type === "commission" ? "works ordered" : r.type === "collab" ? "shared projects" : r.type === "mentored" ? "sessions" : "studies";
    return `<article class="person glass">${avatarHTML(p.name, p.h)}<div><b>${esc(p.name)}</b><small>${esc(p.handle)} · ${r.days}d ago</small><div style="margin-top:6px"><span class="tag" style="--c:${T.c}">${T.label}</span></div></div>
      <div class="metric"><b>${r.impact}</b><small class="muted">${unit}</small></div>
      <p>“${esc(r.quote)}”</p>
      <div class="via">${esc(p.name.split(" ")[0])} ${esc(r.verb)} <button type="button" data-open="${pc.id}">${esc(pc.t)}</button></div></article>`;
  }).join("") || `<p class="muted">No one here yet.</p>`;
}
$("#relChips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (b) { relFilter = b.dataset.f; renderRelations(); } });
$("#relSort").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { relSort = b.dataset.v; renderRelations(); } });
$("#people").addEventListener("click", e => { const b = e.target.closest("[data-open]"); if (b) openArt(+b.dataset.open, PIECES.map(p => p.id)); });

function renderFollowers() {
  const fb = S.fb || (S.fb = {});
  const row = (f, kind) => { const p = person(f.person); const on = kind === "fing" ? !(fb["u" + p.id] === false) : !!fb["u" + p.id] || (f.mutual && fb["u" + p.id] !== false);
    return `<div class="row">${avatarHTML(p.name, p.h)}<div class="who"><b>${esc(p.name)}</b><small>${esc(p.handle)}${kind === "fol" && f.mutual ? " · follows you back" : ""}</small></div><span class="num">${f.days}d</span><button type="button" class="btn sm glass pill press ${on ? "" : "primary"}" data-u="${p.id}">${on ? "Following" : "Follow back"}</button></div>`; };
  const me = S.following ? `<div class="row">${avatarHTML(S.me.name || "You", 200)}<div class="who"><b>${esc(S.me.name || "You")}</b><small>just now</small></div><span class="badge">you</span></div>` : "";
  $("#folList").innerHTML = me + SAMPLE.followers.map(f => row(f, "fol")).join("");
  $("#fingList").innerHTML = SAMPLE.following.map(f => row(f, "fing")).join("");
}
$("[data-panel=followers]").addEventListener("click", e => {
  const b = e.target.closest("[data-u]"); if (!b) return;
  const k = "u" + b.dataset.u, isOn = b.textContent === "Following";
  S.fb = S.fb || {}; S.fb[k] = !isOn; save(); renderFollowers();
});

function renderViewers() {
  const wk = SAMPLE.week, max = Math.max(...wk), days = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
  countUp($("#viewsWeek"), wk.reduce((a, b) => a + b, 0));
  $("#spark").innerHTML = wk.map((v, i) => `<div title="${v} views"><i data-h="${v / max * 100}"></i><small>${days[(new Date().getDay() + 1 + i) % 7]}</small></div>`).join("");
  requestAnimationFrame(() => requestAnimationFrame(() => $$("#spark i").forEach(i => i.style.height = i.dataset.h + "%")));
  const top = PIECES.map(p => ({ id: p.id, v: SAMPLE.stats[p.id].views })).sort((a, b) => b.v - a.v).slice(0, 5);
  $("#topPieces").innerHTML = top.map((x, k) => { const p = piece(x.id); return `<button type="button" class="row" data-open="${p.id}" style="border:0;background:none;width:100%;text-align:left"><span class="cap-n" style="width:20px">${k + 1}</span><span class="res" style="padding:0;flex:1;pointer-events:none"><span class="th" style="--h:${p.hue}"><img src="${p.thumb}" alt="" onerror="this.remove()"></span><span><b>${esc(p.t)}</b><small>${esc(p.k)}</small></span></span><span class="num">${fmt(x.v)}</span></button>`; }).join("");
  $("#viewList").innerHTML = SAMPLE.viewers.map(v => { const p = person(v.person); return `<div class="row">${avatarHTML(p.name, p.h)}<div class="who"><b>${esc(p.name)}</b><small>${v.visits} visit${v.visits > 1 ? "s" : ""}</small></div><span class="num">${ago(v.mins)} ago</span></div>`; }).join("");
}
$("#topPieces").addEventListener("click", e => { const b = e.target.closest("[data-open]"); if (b) openArt(+b.dataset.open, PIECES.map(p => p.id)); });
