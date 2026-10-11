/* ========================================================================= EDIT SHEET */
const sheet = $("#editSheet"), form = $("#editForm");
function openEditProfile() {
  const pr = S.profile;
  $("#editTitle").textContent = "Edit profile"; $("#editSub").textContent = "Changes save in this browser.";
  form.innerHTML = `
    <div class="av-edit"><span class="avatar" id="avPrev">${pr.avatar ? `<img src="${pr.avatar}" alt="">` : esc(initials(pr.name))}</span>
      <div class="btns"><label class="btn glass pill press sm" style="display:inline-flex;color:var(--ink)">Upload photo<input type="file" accept="image/*" id="avFile" hidden></label>${pr.avatar ? `<button type="button" class="btn glass pill press sm" id="avRm">Remove</button>` : ""}</div></div>
    <div class="row2"><label>Name<input class="field" name="name" maxlength="40" required value="${esc(pr.name)}"></label><label>Handle<input class="field" name="handle" maxlength="30" value="${esc(pr.handle)}"></label></div>
    <label>Bio<textarea class="field" name="bio" rows="3" maxlength="240">${esc(pr.bio)}</textarea></label>
    <div class="row2"><label>Location<input class="field" name="location" maxlength="40" value="${esc(pr.location)}" placeholder="City, Country"></label><label>Website<input class="field" name="site" maxlength="120" value="${esc(pr.site)}" placeholder="yoursite.com"></label></div>
    <label>Donation link<input class="field" name="donateLink" type="url" value="${esc(S.settings.donateLink)}" placeholder="https://ko-fi.com/yourname"></label>
    <div class="sheet-foot"><button type="button" class="btn glass pill press" value="cancel" id="sheetCancel">Cancel</button><button class="btn primary glass pill press" type="submit">Save</button></div>`;
  let newAv = pr.avatar;
  $("#avFile").onchange = e => { const f = e.target.files[0]; if (!f) return; resizeImage(f, 256).then(d => { newAv = d; $("#avPrev").innerHTML = `<img src="${d}" alt="">`; }); };
  if ($("#avRm")) $("#avRm").onclick = () => { newAv = ""; $("#avPrev").textContent = initials(form.name.value || pr.name); };
  $("#sheetCancel").onclick = () => sheet.close();
  form.onsubmit = e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    Object.assign(S.profile, { name: fd.name.trim() || "My World", handle: fd.handle.trim(), bio: fd.bio.trim(), location: fd.location.trim(), site: fd.site.trim(), avatar: newAv });
    S.settings.donateLink = fd.donateLink.trim(); $('[data-s="donateLink"]').value = S.settings.donateLink;
    save(); renderIdentity(); renderDonate(); sheet.close(); toast("Profile updated");
  };
  sheet.showModal();
}
function openEditPiece() {
  const id = curArtId(), p = piece(id);
  $("#editTitle").textContent = "Edit piece"; $("#editSub").textContent = "Update how this piece is titled and described.";
  form.innerHTML = `
    <label>Title<input class="field" name="t" maxlength="60" required value="${esc(p.t)}"></label>
    <div class="row2"><label>Type<input class="field" name="k" maxlength="60" value="${esc(p.k)}"></label><label>Date (MM/YY)<input class="field" name="d" maxlength="8" value="${esc(p.d)}"></label></div>
    <label>Description<textarea class="field" name="desc" rows="4" maxlength="600" placeholder="Process notes, tools, the story behind it…">${esc(p.desc || "")}</textarea></label>
    <div class="sheet-foot">${S.edits[id] ? `<button type="button" class="btn glass pill press" id="revert" style="margin-right:auto">Revert</button>` : ""}<button type="button" class="btn glass pill press" id="sheetCancel">Cancel</button><button class="btn primary glass pill press" type="submit">Save</button></div>`;
  $("#sheetCancel").onclick = () => sheet.close();
  if ($("#revert")) $("#revert").onclick = () => { delete S.edits[id]; save(); afterPieceEdit(); };
  form.onsubmit = e => { e.preventDefault(); const fd = Object.fromEntries(new FormData(form)); S.edits[id] = { t: fd.t.trim(), k: fd.k.trim(), d: fd.d.trim(), desc: fd.desc.trim() }; save(); afterPieceEdit(); toast("Piece updated"); };
  sheet.showModal();
}
function afterPieceEdit() { sheet.close(); renderArt(0); renderChips(); buildRingKeep(); if (curTab === "works") renderWorks(); }
function buildRingKeep() { const keep = target; buildRing(); target = pos = keep; }
$("#editBtn").onclick = openEditProfile;
$("#artEdit").onclick = openEditPiece;
sheet.addEventListener("click", e => { if (e.target === sheet) sheet.close(); });
function resizeImage(file, max) {
  return new Promise(res => { const img = new Image(); img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = img.width * s; c.height = img.height * s; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", .85)); URL.revokeObjectURL(img.src); }; img.src = URL.createObjectURL(file); });
}
