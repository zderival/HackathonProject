/* ========================================================================= THE RING (home) */
const space = $("#space"), ring = $("#ring");
let view = PIECES.map(p => p.id);  // ids currently in the ring
let cards = [], pos = 0, target = 0, STEP = 22, R = 1200, H = 400, wrap = true;
let dragging = false, lastInteract = performance.now(), focusedIdx = -1;
let tiltX = 0, tiltY = 0, tX = 0, tY = 0;

function buildRing() {
  ring.innerHTML = "";
  cards = view.map((id, j) => {
    const p = piece(id);
    const b = document.createElement("button");
    b.type = "button"; b.className = "card"; b.dataset.j = j; b.tabIndex = -1;
    b.setAttribute("aria-label", "Open " + p.t);
    b.innerHTML = `<div class="face">${p.video ? `<div class="vslot" style="width:100%;height:100%"><img src="${p.thumb}" alt="" draggable="false" onerror="this.parentNode&&(this.outerHTML=missingHTML(${p.id}))"></div><span class="play glass">▶ Timelapse</span>` : imgHTML(p, "thumb", j < 6)}<div class="gloss"></div><div class="shade"></div></div>`;
    ring.append(b); return b;
  });
  wrap = view.length >= 6;
  pos = target = 0; focusedIdx = -1;
  $("#dots").innerHTML = view.length <= 24 ? view.map(() => "<i></i>").join("") : "";
  layoutRing(); placeVideo();
}

function layoutRing() {
  const vw = innerWidth, vh = space.clientHeight || innerHeight * .6;
  H = Math.max(180, Math.min(vh * .78, 470));
  cards.forEach((c, j) => {
    const ar = piece(view[j]).ar;
    let w = H * ar, h = H;
    const maxW = Math.min(vw * (vw < 640 ? .78 : .6), 820);
    if (w > maxW) { w = maxW; h = w / ar; }
    c.style.setProperty("--w", w + "px"); c.style.setProperty("--h", h + "px");
  });
  const unit = Math.min(H * 1.05, vw * (vw < 640 ? .62 : .42));
  R = unit / Math.sin(STEP * Math.PI / 180);
}

const rel = j => { let o = j - pos; if (wrap) { const n = view.length; o = ((o % n) + n) % n; if (o > n / 2) o -= n; } return o; };
const mod = (a, n) => ((a % n) + n) % n;

function frame(now) {
  if (route === "world") { requestAnimationFrame(frame); return; }  // the 3D world has its own loop
  if (!dragging) { pos += (target - pos) * (S.settings.calm ? 1 : .085); if (Math.abs(target - pos) < .0005) pos = target; }
  const t = now / 1000, calm = S.settings.calm;
  tiltX += (tX - tiltX) * .05; tiltY += (tY - tiltY) * .05;
  // each card gets its own perspective so wide pieces never slice through each other; z-index decides stacking
  const cam = `perspective(1500px) rotateX(${calm ? 0 : -3 + tiltY * 3}deg) rotateY(${calm ? 0 : tiltX * 5}deg)`;
  for (let j = 0; j < cards.length; j++) {
    const c = cards[j], o = rel(j), a = Math.abs(o);
    if (a > 5.5) { if (c.style.visibility !== "hidden") c.style.visibility = "hidden"; continue; }
    c.style.visibility = "";
    const ang = o * STEP * Math.PI / 180;
    const x = R * Math.sin(ang), z = R * (Math.cos(ang) - 1) - a * 60;
    const bob = calm ? 0 : Math.sin(t * .9 + j * 1.3) * 6 * Math.min(1, a + .3);
    const sc = 1 - Math.min(a, 3) * .06;
    c.style.transform = `${cam} translate3d(${x}px, ${bob}px, ${z}px) rotateY(${o * STEP}deg) scale(${sc})`;
    c.style.zIndex = 100 - Math.round(a * 10);
    c.style.opacity = a > 4 ? Math.max(0, 1 - (a - 4) / 1.5) : 1;
    c.firstElementChild.lastElementChild.style.opacity = Math.min(.75, a * .22);
  }
  const fi = view.length ? mod(Math.round(pos), view.length) : -1;
  if (fi !== focusedIdx) onFocus(fi);

  if (S.settings.autoRotate && !calm && !dragging && document.visibilityState === "visible" && !artOpen && route === "home" && now - lastInteract > 7000) {
    target += 1; lastInteract = now - 1500;
    if (!wrap && target > view.length - 1) target = 0;
  }
  drawFlow(now);
  requestAnimationFrame(frame);
}

function onFocus(fi) {
  if (focusedIdx >= 0 && cards[focusedIdx]) cards[focusedIdx].classList.remove("focus");
  focusedIdx = fi; if (fi < 0) return;
  cards[fi].classList.add("focus");
  const p = piece(view[fi]);
  const cc = $("#capCard"); cc.classList.add("swap");
  setTimeout(() => {
    $("#capT").textContent = p.t; $("#capK").textContent = p.k; $("#capD").textContent = p.d ? "· " + p.d : "";
    $("#capN").textContent = pad(fi + 1) + " / " + pad(view.length);
    cc.classList.remove("swap");
  }, 160);
  $$("#dots i").forEach((d, k) => d.classList.toggle("on", k === fi));
  setHero(p);
  const v = $("#timelapse");
  if (p.video && !artOpen) v.play().catch(() => {}); else if (!artOpen) v.pause();
}

let heroFlip = 0;
function setHero(p) {
  const layers = $$("#hero div"); heroFlip ^= 1;
  layers[heroFlip].style.backgroundImage = `url("${p.thumb}")`;
  layers[heroFlip].classList.add("on"); layers[heroFlip ^ 1].classList.remove("on");
  if (S.settings.followHue) hueTarget = p.hue;
}

function go(d) { lastInteract = performance.now(); target = Math.round(target) + d; if (!wrap) target = Math.max(0, Math.min(view.length - 1, target)); }
function goTo(j) { lastInteract = performance.now(); target = Math.round(pos) + rel(j); }

/* drag, flick, click */
let dx0 = 0, pos0 = 0, moved = 0, vel = 0, lastX = 0, lastT = 0, downTarget = null;
space.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  dragging = true; moved = 0; vel = 0; dx0 = lastX = e.clientX; lastT = performance.now(); pos0 = pos; downTarget = e.target.closest(".card");
  space.setPointerCapture(e.pointerId); space.classList.add("dragging"); lastInteract = performance.now();
});
space.addEventListener("pointermove", e => {
  const r = space.getBoundingClientRect();
  tX = ((e.clientX - r.left) / r.width - .5) * 2; tY = ((e.clientY - r.top) / r.height - .5) * 2;
  if (!dragging) return;
  const per = R * Math.sin(STEP * Math.PI / 180);
  moved = Math.max(moved, Math.abs(e.clientX - dx0));
  const now = performance.now(), dt = Math.max(1, now - lastT);
  vel = vel * .6 + (-(e.clientX - lastX) / per / dt) * .4;
  lastX = e.clientX; lastT = now;
  pos = pos0 - (e.clientX - dx0) / per;
  if (!wrap) pos = Math.max(-.4, Math.min(view.length - .6, pos));
});
const endDrag = e => {
  if (!dragging) return; dragging = false; space.classList.remove("dragging");
  if (moved < 6) {
    if (downTarget) { const j = +downTarget.dataset.j; Math.abs(rel(j)) < .5 ? openArt(view[j]) : goTo(j); }
    target = Math.round(target); return;
  }
  target = Math.round(pos + vel * 220);
  if (!wrap) target = Math.max(0, Math.min(view.length - 1, target));
  lastInteract = performance.now();
};
space.addEventListener("pointerup", endDrag);
space.addEventListener("pointercancel", endDrag);
space.addEventListener("pointerleave", () => { tX = tY = 0; });
let wheelAcc = 0, wheelT = 0;
space.addEventListener("wheel", e => {
  e.preventDefault();
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  wheelAcc += d;
  const now = performance.now();
  if (Math.abs(wheelAcc) > 50 && now - wheelT > 140) { go(Math.sign(wheelAcc)); wheelAcc = 0; wheelT = now; }
}, { passive: false });
$("#ringPrev").onclick = () => go(-1);
$("#ringNext").onclick = () => go(1);
$("#openBtn").onclick = () => focusedIdx >= 0 && openArt(view[focusedIdx]);

/* category chips */
function renderChips() {
  $("#chips").innerHTML = CATS.map(([k, label, f]) => {
    const n = PIECES.filter(p => f(piece(p.id))).length;
    return n ? `<button type="button" class="chip glass press" data-cat="${k}" aria-pressed="${k === curCat}">${label}<span class="n">${n}</span></button>` : "";
  }).join("");
}
let curCat = "all";
$("#chips").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  curCat = b.dataset.cat; renderChips();
  const f = CATS.find(c => c[0] === curCat)[2];
  view = PIECES.filter(p => f(piece(p.id))).map(p => p.id); buildRing();
});
