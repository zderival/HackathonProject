/* CLOUD UI: the studio's "Cloud" tab (account + worlds) and the phone card (QR code).
   Same glass look as the rest of the studio; everything reads and writes through Cloud. */
const CloudUI = (() => {
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) { const v = attrs[k]; if (k === "class") e.className = v; else if (k.startsWith("on")) e[k] = v; else if (v === true) e.setAttribute(k, ""); else if (v !== false && v != null) e.setAttribute(k, v); }
    kids.flat().forEach(c => c != null && c !== false && e.append(c.nodeType ? c : document.createTextNode(c)));
    return e;
  };
  const LS = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const st = Cloud.state;
  const ago = iso => { const s = Math.max(1, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : s < 129600 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; };

  /* ---------- QR ---------- */
  function drawQR(canvas, text) {
    const qr = new MyWorldQRCode(-1, 1); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), quiet = 4, cell = Math.max(3, Math.floor(264 / (n + quiet * 2))), size = (n + quiet * 2) * cell;
    canvas.width = canvas.height = size; const x = canvas.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, size, size); x.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) x.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
  }
  const seg = (opts, get, set, label) => {
    const el = h("div", { class: "seg2", role: "radiogroup", "aria-label": label });
    const paint = () => el.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", b.dataset.v === get()));
    opts.forEach(([v, l, tip]) => el.append(h("button", { type: "button", role: "radio", "data-v": v, title: tip || "", onclick: () => { set(v); paint(); } }, l)));
    paint(); return el;
  };

  /* ---------- the phone card ---------- */
  function phoneCard(goCloud) {
    const box = h("div", { class: "phone" });
    let kind = LS.get("mw.qr.kind", "pair"), mode = LS.get("mw.qr.mode", "goggles"), tick = 0;
    const paint = () => {
      clearInterval(tick);
      const kids = [];
      if (!st.checked) kids.push(h("small", { class: "muted" }, "Checking for the backend…"));
      else if (!st.available) kids.push(h("small", { class: "muted" }, "The backend isn't answering, so there is nothing to scan yet. Start it (see README), then reload. Everything else here keeps working on this device."));
      else if (!st.user) kids.push(h("small", { class: "muted" }, "Sign in to put this dome online. Then a QR code here sends your whole world, background and all, to a phone."), h("button", { type: "button", class: "btn primary glass pill press", onclick: goCloud }, "Open the Cloud tab"));
      else if (!st.gallery) kids.push(h("small", { class: "muted" }, "Pick a world (or make one from this dome) in the Cloud tab first."), h("button", { type: "button", class: "btn primary glass pill press", onclick: goCloud }, "Open the Cloud tab"));
      else if (st.gallery.role !== "owner") kids.push(h("small", { class: "muted" }, "Only the owner of this world can make phone links."));
      else {
        const sh = st.sharing;
        const needLink = kind === "link", linkOn = sh && sh.sharingMode !== "restricted" && sh.viewUrl;
        const url = needLink ? (linkOn ? Cloud.phoneURL("link", mode) : "") : (st.pair ? Cloud.phoneURL("pair", mode) : "");
        kids.push(
          h("span", { class: "mini" }, "What should the phone do?"),
          seg([["goggles", "Goggle mode", "Split screen for a headset, moves with your head"], ["motion", "Motion look", "Full screen, moves when you move the phone"], ["look", "Just look", "Drag to look"]], () => mode, v => { mode = v; LS.set("mw.qr.mode", v); paint(); }, "Phone mode"),
          h("span", { class: "mini" }, "Who can use the code?"),
          seg([["pair", "Just one phone", "Private: works once and expires in a few minutes"], ["link", "Anyone with it", "A share link you can switch off any time"]], () => kind, v => { kind = v; LS.set("mw.qr.kind", v); paint(); if (v === "pair" && !st.pair) Cloud.newPairing(); }, "Code type"));
        if (needLink && !linkOn) kids.push(h("small", { class: "muted" }, "Sharing is off. Turn on the link to get a QR code anyone can scan."), h("button", { type: "button", class: "btn primary glass pill press", onclick: () => Cloud.setShareMode("view_link") }, "Turn on the share link"));
        else if (!needLink && !st.pair) kids.push(h("small", { class: "muted" }, "Making a one-time code…"), h("button", { type: "button", class: "btn primary glass pill press", onclick: () => Cloud.newPairing() }, "Make a code"));
        if (url) {
          const canvas = h("canvas", { class: "qr", width: 10, height: 10, role: "img", "aria-label": "QR code that opens this world on a phone" });
          try { drawQR(canvas, url); } catch (e) { console.error(e); }
          const urlIn = h("input", { class: "field", readonly: true, value: url, "aria-label": "Phone address", onfocus: e => e.target.select() });
          const left = h("span", { class: "pcount" });
          kids.push(h("div", { class: "qrwrap" }, canvas));
          if (!needLink) {
            const upd = () => { const s = Math.round((st.pair.expiresAt - Date.now()) / 1000); left.textContent = s > 0 ? `Works once · expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "Expired. Make a new code."; left.classList.toggle("off", s <= 0); };
            upd(); tick = setInterval(upd, 1000);
            kids.push(left);
          } else kids.push(h("small", { class: "pcount" }, "Anyone who scans this can look (not edit) until you switch it off."));
          kids.push(
            h("small", { class: "muted" }, mode === "goggles" ? "Scan it, tap Start goggle mode, then slide the phone into your headset. The whole world, background and pictures, loads on the phone and follows your edits live." : mode === "motion" ? "Scan it and the phone looks around as you move it. It follows your edits live." : "Scan it and drag to look around. It follows your edits live."),
            h("div", { class: "irow" }, urlIn, h("button", { type: "button", class: "btn glass pill press sm", onclick: async () => { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { urlIn.select(); toast("Press copy on your keyboard"); } } }, "Copy")),
            Cloud.phoneNeedsHttps() ? h("div", { class: "warn" }, h("b", {}, "Phones need https for motion. "), "This address is plain http, so a phone can show the world and let you drag, but won't share its motion sensors. Start the server with HTTPS=1, or put a tunnel in front and paste its address below.") : null);
          const row = [h("a", { class: "btn glass pill press sm", href: url, target: "_blank", rel: "noopener" }, "Test in a new tab")];
          if (!needLink) row.push(h("button", { type: "button", class: "btn glass pill press sm", onclick: () => Cloud.newPairing() }, "New code"));
          else row.push(h("button", { type: "button", class: "btn glass pill press sm", onclick: () => Cloud.rotate() }, "Replace link"), h("button", { type: "button", class: "btn glass pill press sm", onclick: () => Cloud.setShareMode("restricted") }, "Stop sharing"));
          kids.push(h("div", { class: "irow" }, row));
        }
        kids.push(h("label", { class: "cr cs col" }, h("span", { class: "cl" }, "Address the phone should use"),
          h("input", { class: "field", placeholder: Cloud.phoneOrigin(), value: LS.get("mw.public", ""), "aria-label": "Phone address override", onchange: e => { if (!Cloud.setPublic(e.target.value)) { toast("That doesn't look like a web address"); e.target.value = LS.get("mw.public", ""); } } })),
          h("small", { class: "muted" }, "Leave empty to use " + Cloud.phoneOrigin() + (/localhost|127\./.test(location.hostname) ? " (your computer's Wi-Fi address; the phone has to be on the same network)" : "") + "."));
        kids.push(h("div", { class: "sync " + (st.sync || "idle") }, h("i"), st.sync === "saving" ? (st.detail || "Sending your changes…") : st.sync === "error" ? "Problem: " + (st.err || "couldn't reach the server") : "Phones are up to date"));
      }
      box.replaceChildren(...kids.filter(Boolean));
    };
    let last = "";
    Cloud.subscribe(n => { const sig = [n.checked, n.available, !!n.user, n.gallery && n.gallery.id, n.gallery && n.gallery.role, n.sharing && n.sharing.sharingMode, n.sharing && n.sharing.viewUrl, n.pair && n.pair.code, n.sync, n.detail, n.err].join("|"); if (sig !== last) { last = sig; paint(); } });
    paint(); return box;
  }

  /* ---------- account + worlds ---------- */
  function cloudPane() {
    const pane = h("div", { class: "pane", "data-pane": "cloud", hidden: true });
    let registering = false, armDel = "";
    const paint = () => {
      const kids = [];
      const chip = (cls, txt) => h("span", { class: "cchip " + cls }, h("i"), txt);
      if (!st.checked) { pane.replaceChildren(h("small", { class: "muted" }, "Looking for the backend…")); return; }
      kids.push(h("span", { class: "lbl first" }, "Backend"), h("div", { class: "irow cstat" }, chip(st.available ? "on" : "off", st.available ? "Online" : "Not reachable"), st.gallery ? chip(st.live === "live" ? "on" : st.live === "off" ? "off" : "wait", st.live === "live" ? "Live" : st.live === "reconnecting" ? "Reconnecting…" : st.live === "connecting" ? "Connecting…" : "Offline") : null, st.gallery ? chip(st.sync === "error" ? "off" : st.sync === "saving" ? "wait" : "on", st.sync === "saving" ? "Saving…" : st.sync === "error" ? "Not saved" : "Saved") : null));
      if (!st.available) kids.push(h("div", { class: "warn" }, "The backend isn't answering. Start it, or run the stand-in with ", h("code", {}, "npm run mock"), ". Until then you can keep building here; nothing is lost."));
      else if (!st.user) {
        const u = h("input", { class: "field", autocomplete: "username", placeholder: "username", "aria-label": "Username", maxlength: 30 }), p = h("input", { class: "field", type: "password", autocomplete: registering ? "new-password" : "current-password", placeholder: "password (8 or more characters)", "aria-label": "Password", maxlength: 200 });
        const nm = registering ? h("input", { class: "field", placeholder: "display name (optional)", "aria-label": "Display name", maxlength: 80 }) : null;
        const go = e => { e && e.preventDefault(); Cloud.signIn(u.value.trim(), p.value, registering, nm && nm.value.trim() || undefined); };
        p.onkeydown = e => { if (e.key === "Enter") go(); };
        kids.push(h("span", { class: "lbl" }, registering ? "Create an account" : "Sign in"),
          h("small", { class: "muted" }, "Your worlds live on the backend, so any device can open them. No email needed. There is no password reset."),
          h("form", { class: "authf", onsubmit: go }, u, p, nm, h("div", { class: "irow" },
            h("button", { type: "submit", class: "btn primary glass pill press", disabled: st.busy === "auth" }, st.busy === "auth" ? "One moment…" : registering ? "Create account" : "Sign in"),
            h("button", { type: "button", class: "btn glass pill press", onclick: () => { registering = !registering; paint(); } }, registering ? "I have an account" : "New here?"))),
          st.authErr ? h("div", { class: "warn", role: "alert" }, st.authErr) : null);
      } else {
        kids.push(h("span", { class: "lbl" }, "You"), h("div", { class: "cuser" }, h("span", { class: "avatar sm" }, (st.user.displayName || "?").slice(0, 1).toUpperCase()), h("div", {}, h("b", {}, st.user.displayName), h("small", { class: "muted" }, "@" + st.user.username)), h("button", { type: "button", class: "btn glass pill press sm", onclick: () => Cloud.signOut() }, "Sign out")));
        if (st.gallery) {
          const g = st.gallery;
          kids.push(h("span", { class: "lbl" }, "Open world"), h("div", { class: "wcur glass" }, h("b", {}, g.title), h("small", { class: "muted" }, `${g.role}${st.readOnly ? " · view only" : ""} · revision ${st.rev}`)),
            h("div", { class: "irow" },
              g.role === "owner" ? h("button", { type: "button", class: "btn glass pill press sm", onclick: () => { const t = prompt("Name this world", g.title); if (t && t.trim()) Cloud.renameGallery(t.trim()); } }, "Rename") : null,
              h("button", { type: "button", class: "btn glass pill press sm", onclick: () => { Cloud.closeGallery(); setTimeout(() => location.reload(), 50); } }, "Back to this device's dome")));
          if (st.readOnly) kids.push(h("div", { class: "warn" }, "You can look at this world but not change it."));
        }
        kids.push(h("span", { class: "lbl" }, "Your worlds"));
        if (!st.galleries.length) kids.push(h("small", { class: "muted" }, "None yet. Make one from the dome you have on screen:"));
        const list = h("div", { class: "wlist" });
        st.galleries.forEach(g => {
          const cur = st.gallery && st.gallery.id === g.id;
          list.append(h("div", { class: "wrow glass" + (cur ? " cur" : "") },
            h("div", {}, h("b", {}, g.title), h("small", { class: "muted" }, `${g.role} · ${ago(g.updatedAt)}${g.sharingMode !== "restricted" ? " · shared" : ""}`)),
            h("div", { class: "irow tight" },
              cur ? h("span", { class: "cchip on" }, h("i"), "Open") : h("button", { type: "button", class: "btn glass pill press sm", disabled: st.busy === "open", onclick: () => Cloud.openGallery(g.id).catch(e => toast(e.message)) }, "Open"),
              g.role === "owner" ? h("button", { type: "button", class: "btn glass pill press sm danger", "aria-label": "Delete " + g.title, onclick: () => { if (armDel !== g.id) { armDel = g.id; paint(); setTimeout(() => { if (armDel === g.id) { armDel = ""; paint(); } }, 3000); return; } armDel = ""; Cloud.deleteGallery(g.id); } }, armDel === g.id ? "Sure?" : "Delete") : null)));
        });
        kids.push(list);
        const title = h("input", { class: "field", placeholder: "Name for a new world", "aria-label": "New world name", maxlength: 120, value: "" });
        kids.push(h("label", { class: "cr cs col" }, h("span", { class: "cl" }, "New world"), title),
          h("div", { class: "irow" },
            h("button", { type: "button", class: "btn primary glass pill press", disabled: st.busy === "open", onclick: () => Cloud.createGallery(title.value.trim() || "My World", true) }, "From this dome"),
            h("button", { type: "button", class: "btn glass pill press", disabled: st.busy === "open", onclick: () => Cloud.createGallery(title.value.trim() || "My World", false) }, "Empty")),
          h("small", { class: "muted" }, "“From this dome” uploads the pictures you added and your background. Videos stay on this device because the backend keeps pictures only."));
      }
      const typed = {}; pane.querySelectorAll("input").forEach(i => { typed[i.getAttribute("aria-label")] = [i.value, i === document.activeElement]; });
      pane.replaceChildren(...kids.filter(Boolean)); // keep what someone was typing when a status dot changes
      pane.querySelectorAll("input").forEach(i => { const t = typed[i.getAttribute("aria-label")]; if (t) { i.value = t[0]; if (t[1]) i.focus(); } });
    };
    let last = "";
    Cloud.subscribe(n => { const sig = [n.checked, n.available, !!n.user, n.authErr, n.busy, n.live, n.sync, n.rev, n.readOnly, n.gallery && n.gallery.id, n.gallery && n.gallery.title, n.galleries.map(g => g.id + g.title + g.updatedAt + g.sharingMode).join(",")].join("|"); if (sig !== last) { last = sig; paint(); } });
    paint(); return pane;
  }

  return { cloudPane, phoneCard, drawQR };
})();
