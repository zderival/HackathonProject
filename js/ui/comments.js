/* ========================================================================= COMMENTS (profile + per piece) */
function allProfComments() { return [...S.comments.profile, ...SAMPLE.profComments.map((c, i) => ({ ...c, sid: "p" + i }))]; }
function artCommentList(id) { return [...(S.comments.art[id] || []), ...SAMPLE.artComments[id].map((c, i) => ({ ...c, sid: "a" + id + "_" + i }))]; }
function commentHTML(c, scope) {
  const mine = !!c.mine, key = c.sid || c.cid;
  const name = mine ? (c.name || "You") : person(c.person).name, h = mine ? 200 : person(c.person).h;
  const liked = !!S.cLikes[key], likes = (c.likes || 0) + (liked ? 1 : 0);
  const mins = mine ? Math.floor((Date.now() - c.at) / 60000) : c.mins;
  return `<div class="comment">${avatarHTML(name, h)}<div><div class="hd"><b>${esc(name)}</b>${mine ? '<span class="badge">you</span>' : ""}<small>${ago(mins)}</small></div><p>${esc(c.text)}</p>
    <div class="acts"><button type="button" class="${liked ? "on" : ""}" data-like="${key}" aria-pressed="${liked}"><svg width="14" height="14" viewBox="0 0 24 24" fill="${liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.2"><path d="M12 20s-7-4.4-9.2-9A5 5 0 0 1 12 6a5 5 0 0 1 9.2 5c-2.2 4.6-9.2 9-9.2 9Z"/></svg>${likes}</button>${mine ? `<button type="button" data-del="${c.cid}" data-scope="${scope}">Delete</button>` : ""}</div></div></div>`;
}
function composeHTML(id) {
  if (!S.settings.allowComments) return `<p class="muted" style="font-size:14px">Comments are turned off.</p>`;
  return `<div class="compose">${avatarHTML(S.me.name || "You", 200)}<form data-c="${id}"><textarea class="field" name="text" rows="2" maxlength="500" required placeholder="Say something kind…" aria-label="Comment"></textarea><div class="bar"><input class="field" name="name" placeholder="Your name" maxlength="40" value="${esc(S.me.name)}" aria-label="Your name"><button class="btn primary glass pill press sm" type="submit">Post</button></div></form></div>`;
}
function bindComments(root, scope, artId) {
  root.addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target, text = f.text.value.trim(); if (!text) return;
    S.me.name = f.name.value.trim().slice(0, 40);
    const c = { cid: "c" + Date.now().toString(36), mine: true, name: S.me.name || "You", text, at: Date.now() };
    if (scope === "profile") S.comments.profile.unshift(c);
    else { const id = curArtId(); (S.comments.art[id] = S.comments.art[id] || []).unshift(c); }
    save(); f.text.value = "";
    scope === "profile" ? renderProfComments() : renderArtComments();
    toast("Comment posted");
  });
  root.addEventListener("click", e => {
    const l = e.target.closest("[data-like]"); if (l) { const k = l.dataset.like; S.cLikes[k] ? delete S.cLikes[k] : S.cLikes[k] = 1; save(); scope === "profile" ? renderProfComments(true) : renderArtComments(true); return; }
    const d = e.target.closest("[data-del]"); if (d) {
      if (scope === "profile") S.comments.profile = S.comments.profile.filter(c => c.cid !== d.dataset.del);
      else { const id = curArtId(); S.comments.art[id] = (S.comments.art[id] || []).filter(c => c.cid !== d.dataset.del); }
      save(); scope === "profile" ? renderProfComments() : renderArtComments();
    }
  });
}
function renderProfComments(listOnly) {
  if (!listOnly) $("#profCompose").innerHTML = composeHTML("profile");
  $("#profComments").innerHTML = allProfComments().map(c => commentHTML(c, "profile")).join("");
  $("#nCom").textContent = allProfComments().length;
}
function renderArtComments(listOnly) {
  const id = curArtId(), list = artCommentList(id);
  if (!listOnly) $("#artCompose").innerHTML = composeHTML("art");
  $("#artComList").innerHTML = list.map(c => commentHTML(c, "art")).join("");
  $("#artComN").textContent = list.length;
}
bindComments($("#profCompose").parentElement, "profile");
bindComments($("#artComments"), "art");
