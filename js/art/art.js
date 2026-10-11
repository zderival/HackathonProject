/* ========================================================================= ART PAGE */
let artOpen = false, artList = [], artPos = 0, donAmt = 5;
const curArtId = () => artList[artPos];
function openArt(id, list) {
  artList = list || view.slice(); artPos = Math.max(0, artList.indexOf(id));
  if (artPos < 0) { artList = PIECES.map(p => p.id); artPos = id; }
  artOpen = true; $("#art").classList.add("on");
  $("#" + route).classList.add("behind");
  document.body.style.overflow = "hidden";
  history.pushState({ art: id }, "", "#art/" + id);
  renderArt(0);
  setTimeout(() => $("#artClose").focus({ preventScroll: true }), 50);
}
function closeArt(fromPop) {
  if (!artOpen) return;
  artOpen = false; $("#art").classList.remove("on"); $("#" + route).classList.remove("behind");
  placeVideo();
  if (!fromPop) history.back();
  const id = curArtId(); if (route === "home" && view.includes(id) && view[focusedIdx] !== id) goTo(view.indexOf(id));
}
function renderArt(dir) {
  const id = curArtId(), p = piece(id), media = $("#artMedia");
  const paint = () => {
    media.style.setProperty("--ar", p.ar);
    if (p.video) { media.innerHTML = ""; placeVideo(); }
    else media.innerHTML = `<img src="${p.src}" alt="${esc(p.t)}" draggable="false" onerror="this.src='${p.thumb}';this.onerror=function(){this.parentNode&&(this.outerHTML=missingHTML(${p.id}))}">`;
    media.classList.remove("swap-l", "swap-r");
  };
  if (dir && !S.settings.calm) { media.classList.add(dir > 0 ? "swap-l" : "swap-r"); setTimeout(paint, 220); } else paint();
  $("#artKind").textContent = p.k;
  $("#artT").textContent = p.t;
  $("#artD").textContent = p.d ? (p.video ? "Runtime " + p.d : "Signed " + p.d) : "Undated";
  $("#artDesc").textContent = p.desc || "";
  $("#artCount").textContent = pad(artPos + 1) + " / " + pad(artList.length);
  const liked = !!S.likes[id];
  $("#likeBtn").classList.toggle("liked", liked); $("#likeBtn").setAttribute("aria-pressed", liked);
  $("#likeN").textContent = fmt(SAMPLE.stats[id].likes + (liked ? 1 : 0));
  $("#viewN").textContent = fmt(SAMPLE.stats[id].views);
  if (S.settings.followHue) hueTarget = p.hue;
  renderDonate(); renderArtComments();
  history.replaceState({ art: id }, "", "#art/" + id);
}
function artStep(d) { if (artList.length < 2) return; artPos = mod(artPos + d, artList.length); renderArt(d); $("#artScroll").scrollTo({ top: 0, behavior: "smooth" }); }
$("#artClose").onclick = () => closeArt();
$("#artPrev").onclick = () => artStep(-1);
$("#artNext").onclick = () => artStep(1);
$("#art .veil").onclick = () => closeArt();
$("#likeBtn").onclick = () => {
  const id = curArtId(); S.likes[id] ? delete S.likes[id] : S.likes[id] = 1; save();
  const b = $("#likeBtn"); b.classList.toggle("liked", !!S.likes[id]); b.setAttribute("aria-pressed", !!S.likes[id]);
  $("#likeN").textContent = fmt(SAMPLE.stats[id].likes + (S.likes[id] ? 1 : 0));
  const sv = b.querySelector("svg"); sv.classList.remove("heart-pop"); void sv.offsetWidth; sv.classList.add("heart-pop");
};
async function share(title, url) {
  try { if (navigator.share) { await navigator.share({ title, url }); return; } } catch { return; }
  try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { toast(url); }
}
$("#artShare").onclick = () => share(piece(curArtId()).t, location.href);
$("#shareBtn").onclick = () => share("My World", location.href.split("#")[0] + "#profile");
// swipe on the art stage
(() => { let x0 = null, y0 = 0; const st = $("#artStage");
  st.addEventListener("pointerdown", e => { if (e.target.closest("button, video")) return; x0 = e.clientX; y0 = e.clientY; });
  st.addEventListener("pointerup", e => { if (x0 === null) return; const dx = e.clientX - x0, dy = e.clientY - y0; x0 = null; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) artStep(dx < 0 ? 1 : -1); });
})();

/* donations */
const AMOUNTS = [3, 5, 10, 25];
function renderDonate() {
  const st = S.settings, cur = st.currency || "$";
  $("#curSym").textContent = cur;
  $("#amounts").innerHTML = AMOUNTS.map(a => `<button type="button" class="amt" data-a="${a}" aria-pressed="${a === donAmt && !$("#customAmt").value}">${esc(cur)}${a}</button>`).join("");
  const amt = currentAmt();
  const p = artOpen ? piece(curArtId()) : null;
  $("#donLead").textContent = p ? `Like “${p.t}”? Tips go straight to ${S.profile.name} and help fund the next painting.` : "";
  const go = $("#donGo"); go.textContent = amt ? `Donate ${cur}${amt}` : "Choose an amount";
  go.disabled = !amt; go.style.opacity = amt ? "" : ".55";
  let host = ""; try { host = st.donateLink ? new URL(st.donateLink.replace("{amount}", "1")).host : ""; } catch {}
  $("#donFine").innerHTML = host ? `You'll finish on <b>${esc(host)}</b>. This gallery never sees your card details.` : (st.owner ? `No donation link yet. Add one in <a href="#settings" data-goset>Settings › Donations</a> to start receiving tips.` : `Donations aren't set up yet.`);
  if (p) {
    const n = SAMPLE.supporters[p.id];
    const faces = SAMPLE.people.slice((p.id * 3) % 20, (p.id * 3) % 20 + Math.min(4, n));
    $("#supporters").innerHTML = n ? `<span class="stack">${faces.map(f => avatarHTML(f.name, f.h)).join("")}</span><span><b style="color:var(--ink)">${n}</b> supporter${n > 1 ? "s" : ""} loved this piece</span>` : `<span>Be the first to support this piece.</span>`;
  }
}
const currentAmt = () => { const c = parseFloat($("#customAmt").value); return c > 0 ? Math.round(c * 100) / 100 : donAmt; };
$("#amounts").addEventListener("click", e => { const b = e.target.closest(".amt"); if (!b) return; donAmt = +b.dataset.a; $("#customAmt").value = ""; renderDonate(); });
$("#customAmt").addEventListener("input", renderDonate);
$("#donFine").addEventListener("click", e => { if (e.target.closest("[data-goset]")) { e.preventDefault(); closeArt(); setTimeout(() => setRoute("settings"), 50); } });
$("#donGo").onclick = () => {
  const link = S.settings.donateLink, amt = currentAmt();
  if (!link) { toast(S.settings.owner ? "Add your donation link in Settings first" : "Donations aren't set up yet"); return; }
  let url; try { url = new URL(link.includes("{amount}") ? link.replace("{amount}", amt) : link); } catch { toast("That donation link doesn't look right"); return; }
  if (!/^https:$/.test(url.protocol)) { toast("Donation links must start with https://"); return; }
  window.open(url.href, "_blank", "noopener");
  toast(`Thank you! Opening ${url.host}…`);
};
