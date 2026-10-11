/* ========================================================================= VIDEO placement (one embedded copy) */
function placeVideo() {
  const v = $("#timelapse"); const vid = PIECES.find(p => p.video).id;
  let slot = null;
  if (artOpen && curArtId() === vid) { slot = $("#artMedia"); v.controls = true; v.muted = false; }
  else { v.controls = false; v.muted = true; const j = view.indexOf(vid); slot = j >= 0 && cards[j] ? cards[j].querySelector(".vslot") : $("#videoHome"); }
  if (v.parentElement !== slot) { if (slot.classList && slot.classList.contains("vslot")) slot.innerHTML = ""; slot.append(v); }
  if (artOpen && curArtId() === vid) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  else if (route === "home" && focusedIdx >= 0 && view[focusedIdx] === vid) v.play().catch(() => {}); else v.pause();
}
