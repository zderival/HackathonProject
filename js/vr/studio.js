/* =========================================================================
   STUDIO: the editing panel beside the live dome.
   Five tabs: Media (add, place, size), Sky (presets + every dial), Phone (QR code, export), Cloud (account + worlds on the backend), Assistant (editor only).
   Every control writes to VRStore, which updates the dome (and any pop-out window) immediately.
   ========================================================================= */
const Studio = (() => {
  const { SCHEMA, PKEYS, PRESETS, presetBg, swatch, FONTS } = VRData;
  const Scene = VRStore;
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) { const v = attrs[k]; if (k === "class") e.className = v; else if (k.startsWith("on")) e[k] = v; else if (v === true) e.setAttribute(k, ""); else if (v !== false && v != null) e.setAttribute(k, v); }
    kids.flat().forEach(c => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
    return e;
  };
  const rnd = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
  let syncs = [], inspSyncs = [], tab = "media", root;

  /* ---------- small control factories. each returns { el, sync() } ---------- */
  function range(label, get, set, o) {
    const out = h("output"), inp = h("input", { type: "range", "aria-label": label });
    const paint = () => { const lo = +inp.min, hi = +inp.max; inp.style.setProperty("--p", ((+inp.value - lo) / (hi - lo || 1)) * 100 + "%"); out.textContent = (o.fmt ? o.fmt(+inp.value) : rnd(+inp.value, o.step < 1 ? 2 : 0)) + (o.u || ""); };
    inp.oninput = () => { set(+inp.value); paint(); };
    const wrap = h("label", { class: "cr" }, h("span", { class: "cl" }, label), out, inp);
    const sync = () => { const lo = typeof o.min === "function" ? o.min() : o.min, hi = typeof o.max === "function" ? o.max() : o.max; inp.min = lo; inp.max = hi; inp.step = o.step; inp.value = get(); paint(); };
    sync(); return { el: wrap, sync };
  }
  function color(label, get, set) {
    const inp = h("input", { type: "color", "aria-label": label });
    inp.oninput = () => set(inp.value);
    const wrap = h("label", { class: "cr cc" }, h("span", { class: "cl" }, label), inp);
    const sync = () => { inp.value = /^#[0-9a-f]{6}$/i.test(get()) ? get() : "#000000"; };
    sync(); return { el: wrap, sync };
  }
  function toggle(label, get, set) {
    const inp = h("input", { type: "checkbox", class: "switch", "aria-label": label });
    inp.onchange = () => set(inp.checked);
    const wrap = h("label", { class: "cr ct" }, h("span", { class: "cl" }, label), inp);
    const sync = () => { inp.checked = !!get(); }; sync(); return { el: wrap, sync };
  }
  function select(label, opts, get, set) {
    const inp = h("select", { class: "field sel", "aria-label": label }, opts.map(o => h("option", { value: o.v }, o.l)));
    inp.onchange = () => set(inp.value);
    const wrap = h("label", { class: "cr cs" }, h("span", { class: "cl" }, label), inp);
    const sync = () => { inp.value = get(); }; sync(); return { el: wrap, sync };
  }
  function seg(label, opts, get, set) {
    const wrap = h("div", { class: "cr cseg" }, h("span", { class: "cl" }, label), h("div", { class: "seg", role: "group", "aria-label": label }, opts.map(o => h("button", { type: "button", "data-v": o.v, onclick: () => set(o.v) }, o.l))));
    const sync = () => wrap.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === get())); sync(); return { el: wrap, sync };
  }

  /* ---------- Media tab ---------- */
  let listEl, inspEl, galEl;
  const typeIcon = { image: "◼", video: "▶", text: "T" };
  function thumbFor(it) {
    const box = h("span", { class: "mt" });
    if (it.type === "text") { box.textContent = "Aa"; return box; }
    if (it.type === "video" && !it.mediaId) { box.textContent = "▶"; return box; }
    const set = u => { if (u) { const im = h("img", { src: u, alt: "", draggable: "false" }); im.onerror = () => { im.remove(); box.textContent = typeIcon[it.type]; }; box.append(im); } else box.textContent = typeIcon[it.type]; };
    if (it.mediaId && it.type === "image") World.blobURL(it.mediaId).then(set); else if (it.type === "image") set(it.src); else box.textContent = "▶";
    return box;
  }
  function renderList() {
    if (!listEl) return;
    listEl.replaceChildren();
    if (!Scene.items.length) { listEl.append(h("p", { class: "empty" }, "Nothing here yet. Upload pictures, videos or text, or pick pieces from your gallery.")); return; }
    Scene.items.forEach(it => {
      const row = h("div", { class: "mrow", "data-id": it.id, "aria-selected": World.selected === it.id, tabindex: "0", role: "button",
        onclick: () => { World.select(it.id); World.turnTo(it); },
        onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); World.select(it.id); World.turnTo(it); } } },
        thumbFor(it),
        h("span", { class: "mn" }, h("b", {}, it.name || (it.type === "text" ? (it.text && it.text.body || "Text").slice(0, 28) : "Untitled")), h("small", {}, ({ image: "Picture", video: "Video", text: "Text" })[it.type])),
        h("button", { type: "button", class: "eye", "aria-label": it.hidden ? "Show" : "Hide", "aria-pressed": !!it.hidden, title: it.hidden ? "Show in dome" : "Hide from dome", onclick: e => { e.stopPropagation(); Scene.update(it.id, { hidden: !it.hidden }); } }, it.hidden ? "◌" : "●"));
      listEl.append(row);
    });
  }
  function renderInspector() {
    inspSyncs = []; inspEl.replaceChildren();
    const id = World.selected, it = id && Scene.item(id);
    inspEl.hidden = !it;
    if (!it) return;
    const dome = () => Scene.view.dome, up = patch => Scene.update(id, patch), add = c => { inspSyncs.push(c.sync); return c.el; };
    const nameIn = h("input", { class: "field", value: it.name || "", placeholder: "Name (optional)", "aria-label": "Name", oninput: e => { up({ name: e.target.value }); renderListRow(id); } });
    inspEl.append(h("div", { class: "ihead" }, h("span", { class: "eyebrow" }, "Selected"), h("small", {}, it.type === "text" ? "Text" : it.type === "video" ? "Video · plays when you look at it" : "Picture")), nameIn);
    inspEl.append(add(toggle("Show name under it", () => it.caption, v => up({ caption: v }))));
    inspEl.append(h("span", { class: "lbl" }, "Position"));
    inspEl.append(
      add(range("Left ⟷ right", () => it.az, v => up({ az: v }), { min: -180, max: 180, step: 1, u: "°" })),
      add(range("Height", () => it.h, v => up({ h: v }), { min: .2, max: () => rnd(dome() * .95), step: .05, u: " m" })),
      add(range("Distance", () => it.d, v => up({ d: v }), { min: .8, max: () => rnd(dome() - .3), step: .05, u: " m" })),
      h("span", { class: "lbl" }, "Size"),
      add(range("Size", () => it.size, v => up({ size: v }), { min: .2, max: () => rnd(Math.min(6, dome() * 1.3)), step: .05, u: " m" })),
      add(range("Tilt", () => it.tilt || 0, v => up({ tilt: v }), { min: -45, max: 45, step: 1, u: "°" })));
    if (it.type === "text") {
      const t = () => ({ ...Scene.TEXT_DEFAULTS, ...(Scene.item(id).text || {}) }), ut = p => up({ text: { ...t(), ...p } });
      inspEl.append(h("span", { class: "lbl" }, "Text"));
      const ta = h("textarea", { class: "field", rows: "3", "aria-label": "Text", oninput: e => ut({ body: e.target.value }) }); ta.value = t().body; inspEl.append(ta);
      inspEl.append(
        add(select("Font", FONTS.map(f => ({ v: f.v, l: f.l })), () => t().font, v => ut({ font: v }))),
        add(select("Weight", [{ v: "400", l: "Regular" }, { v: "700", l: "Bold" }, { v: "800", l: "Heavy" }], () => String(t().weight), v => ut({ weight: +v }))),
        add(range("Letter size", () => t().fs || 1, v => ut({ fs: v }), { min: .4, max: 2.5, step: .05, u: "×" })),
        add(color("Text color", () => t().color, v => ut({ color: v }))),
        add(seg("Align", [{ v: "left", l: "Left" }, { v: "center", l: "Center" }, { v: "right", l: "Right" }], () => t().align, v => { ut({ align: v }); inspSyncs.forEach(f => f()); })),
        add(toggle("Card behind the text", () => t().card, v => ut({ card: v }))),
        add(color("Card color", () => t().cardCol, v => ut({ cardCol: v }))),
        add(range("Card opacity", () => t().cardOp, v => ut({ cardOp: v }), { min: 0, max: 1, step: .01 })));
    }
    inspEl.append(h("span", { class: "lbl" }, "Look"));
    inspEl.append(add(select("Frame", [{ v: "none", l: "None (just your media)" }, { v: "thin", l: "Thin line" }, { v: "plate", l: "Dark plate" }], () => it.frame || "none", v => up({ frame: v }))));
    if (it.type === "video") inspEl.append(add(toggle("Loop", () => it.loop !== false, v => up({ loop: v }))), add(toggle("Mute this video", () => !!it.mute, v => up({ mute: v }))));
    if (it.mediaId) inspEl.append(h("p", { class: "note" }, `Shown exactly as uploaded${it.bytes ? " · " + (it.bytes / 1048576).toFixed(1) + " MB" : ""}. Nothing is filtered, cropped or re-encoded.`));
    let armed = 0;
    const del = h("button", { type: "button", class: "btn glass pill press sm danger", onclick: () => {
      if (!armed) { armed = 1; del.textContent = "Tap again to remove"; setTimeout(() => { armed = 0; del.textContent = "Remove"; }, 2500); return; }
      Scene.remove(id); } }, "Remove");
    inspEl.append(h("div", { class: "irow" },
      h("button", { type: "button", class: "btn glass pill press sm", onclick: () => World.turnTo(Scene.item(id)) }, "Look at it"),
      h("button", { type: "button", class: "btn glass pill press sm", onclick: () => { const c = Scene.duplicate(id); c && World.select(c.id); } }, "Duplicate"), del));
  }
  function renderListRow(id) { const r = listEl.querySelector(`[data-id="${id}"] b`), it = Scene.item(id); if (r && it) r.textContent = it.name || "Untitled"; }

  function mediaTab() {
    const fileIn = h("input", { type: "file", multiple: true, hidden: true, accept: "image/*,video/*,text/plain,.txt,.md", onchange: e => { World.addFiles(e.target.files); e.target.value = ""; } });
    galEl = h("div", { class: "gal", hidden: true });
    PIECES.forEach((_, i) => { const p = piece(i); if (p.video) return; /* the speed-paint video stays out of the dome */ galEl.append(h("button", { type: "button", class: "gt", title: p.t, onclick: () => { const it = Scene.addItem({ type: "image", name: p.t, src: p.thumb, ar: p.ar, size: 1.25 }); World.select(it.id); World.turnTo(it); galEl.hidden = true; } }, h("img", { src: p.thumb, alt: p.t, loading: "lazy", onerror: e => { e.target.replaceWith(h("span", {}, p.t.slice(0, 2))); } }))); });
    listEl = h("div", { class: "mlist" }); inspEl = h("div", { class: "insp", hidden: true });
    return h("div", { class: "pane", "data-pane": "media" },
      h("div", { class: "add-row" },
        h("button", { type: "button", class: "btn primary glass pill press sm", onclick: () => fileIn.click() }, "＋ Upload"),
        h("button", { type: "button", class: "btn glass pill press sm", onclick: () => { const it = Scene.addItem({ type: "text", name: "", text: { ...Scene.TEXT_DEFAULTS }, size: 1.6, ar: 2.4 }); World.select(it.id); World.turnTo(it); } }, "Aa Text"),
        h("button", { type: "button", class: "btn glass pill press sm", onclick: () => { galEl.hidden = !galEl.hidden; } }, "From gallery"), fileIn),
      h("small", { class: "muted drop-note" }, "Pictures, videos or .txt files. Or drop them anywhere on the dome. Your files stay on this device."),
      galEl, inspEl, listEl);
  }

  /* ---------- Background tab ---------- */
  function bgTab() {
    const bg = () => Scene.bg;
    const grid = h("div", { class: "presets" }, PKEYS.map(k => h("button", { type: "button", class: "pre", "data-k": k, onclick: () => Scene.applyPreset(k) }, h("i", { style: `background:${swatch(k)}` }), PRESETS[k].name)));
    const status = h("small", { class: "muted pre-note" });
    const pane = h("div", { class: "pane", "data-pane": "bg", hidden: true }, h("span", { class: "lbl first" }, "Start from"), grid, status);
    const rows = [];
    SCHEMA.forEach(g => {
      const det = h("details", { class: "grp", open: !!g.open }, h("summary", {}, g.title));
      g.items.forEach(s => {
        let c;
        const get = () => bg()[s.k], set = v => Scene.setBg({ [s.k]: v });
        if (s.t === "range") c = range(s.l, get, set, { min: s.min, max: s.max, step: s.step, u: s.u });
        else if (s.t === "color") c = color(s.l, get, set);
        else if (s.t === "toggle") c = toggle(s.l, get, set);
        else if (s.t === "select") c = select(s.l, s.o, get, set);
        else if (s.t === "image") {
          const name = h("small", { class: "muted" }), file = h("input", { type: "file", accept: "image/*", hidden: true, onchange: async e => { const f = e.target.files[0]; e.target.value = ""; if (f) { await Scene.setPano(f); } } });
          const clear = h("button", { type: "button", class: "btn glass pill press sm", onclick: () => Scene.clearPano() }, "Remove");
          const up = h("button", { type: "button", class: "btn primary glass pill press sm", onclick: () => file.click() }, "＋ Upload image");
          const el = h("div", { class: "cr cimg" }, h("div", { class: "irow" }, up, clear, file), name, h("small", { class: "muted" }, s.note));
          c = { el, sync() { name.textContent = bg().pano ? "Using: " + (bg().panoName || "your image") : "No image yet"; clear.hidden = !bg().pano; } }; c.sync();
        }
        rows.push({ s, c }); det.append(c.el);
      });
      pane.append(det);
    });
    const reset = h("button", { type: "button", class: "btn glass pill press sm", onclick: () => Scene.applyPreset(bg().preset in PRESETS ? bg().preset : "lastLight") }, "Reset to preset");
    pane.append(h("div", { class: "irow" }, reset));
    syncs.push(() => {
      rows.forEach(({ s, c }) => { c.sync(); c.el.hidden = !!(s.show && !s.show(bg())); });
      grid.querySelectorAll(".pre").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === bg().preset));
      status.textContent = bg().preset === "custom" ? "Custom: your own mix. Pick a preset to start over." : "Tweak anything below. It changes right away.";
    });
    return pane;
  }

  /* ---------- Dome & share tab ---------- */
  function shareTab() {
    const dome = range("Dome size", () => Scene.view.dome, v => Scene.setDome(v), { min: 3, max: 10, step: .1, u: " m", fmt: v => rnd(v, 1) });
    const dot = toggle("Show the gaze dot", () => World.ui.dot, v => World.setDot(v));
    syncs.push(dome.sync, dot.sync);
    const importIn = h("input", { type: "file", accept: ".zip,application/zip", hidden: true, onchange: async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; try { await Scene.importZip(f); toast("Scene imported"); } catch (err) { toast(err.message || "Couldn't import that file"); } } });
    let armed = 0;
    const reset = h("button", { type: "button", class: "btn glass pill press sm danger", onclick: () => { if (!armed) { armed = 1; reset.textContent = "Tap again: this deletes uploads"; setTimeout(() => { armed = 0; reset.textContent = "Start over"; }, 3000); return; } Scene.reset(); toast("Back to the starting scene"); armed = 0; reset.textContent = "Start over"; } }, "Start over");
    return h("div", { class: "pane", "data-pane": "share", hidden: true },
      h("span", { class: "lbl first" }, "Show it on a phone"), CloudUI.phoneCard(() => setTab("cloud")),
      h("span", { class: "lbl" }, "The dome"), dome.el, dot.el,
      h("small", { class: "muted" }, "Smaller domes feel cozier. Shrinking it brings your media in with it."),
      h("span", { class: "lbl" }, "See it as you edit"),
      h("button", { type: "button", class: "btn primary glass pill press", onclick: () => World.popOut() }, "Open live view in a new window"),
      h("small", { class: "muted" }, "It updates the moment you change anything here. Put it on a second screen, or in a headset browser on the same computer."),
      h("span", { class: "lbl" }, "Save & move"),
      h("div", { class: "irow" },
        h("button", { type: "button", class: "btn glass pill press sm", onclick: async () => { try { const blob = await Scene.exportZip(), a = h("a", { href: URL.createObjectURL(blob), download: "my-dome.zip" }); document.body.append(a); a.click(); a.remove(); toast("Saved my-dome.zip"); } catch (e) { toast("Couldn't export: " + e.message); } } }, "Export (.zip)"),
        h("button", { type: "button", class: "btn glass pill press sm", onclick: () => importIn.click() }, "Import"), importIn, reset),
      h("small", { class: "muted" }, "The export holds your original files and settings. To show it on another device without the server, host the site online (https) and import the .zip there."));
  }

  function setOpen(v) { root.classList.toggle("open", v); $("#world").classList.toggle("studio-open", v); }
  function setTab(t) {
    tab = t;
    root.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.t === t));
    root.querySelectorAll(".pane").forEach(p => p.hidden = p.dataset.pane !== t);
  }

  function build() {
    root = $("#studio");
    const tabs = h("div", { class: "tabs", role: "tablist" }, [["media", "Media"], ["bg", "Sky"], ["share", "Phone"], ["cloud", "Cloud"], ["ai", "Assistant"]].filter(x => !(x[0] === "ai" && Scene.viewerMode)).map(([k, l]) => h("button", { type: "button", role: "tab", "data-t": k, onclick: () => setTab(k) }, l)));
    const body = h("div", { class: "studio-body" }, mediaTab(), bgTab(), shareTab(), CloudUI.cloudPane(), Scene.viewerMode ? null : Assistant.build());
    root.append(h("button", { class: "studio-head", id: "studioHead", type: "button", "aria-label": "Collapse or expand the studio", onclick: () => setOpen(!root.classList.contains("open")) }, h("span", {}, h("span", { class: "eyebrow" }, "Your dome"), h("b", { id: "stNow" }, "Live · edits show instantly")), h("i", { class: "chev" })), tabs, body);
    const now = $("#stNow"), paintNow = n => { if (now) now.textContent = !n.available ? "On this device · edits show instantly" : n.gallery ? `${n.gallery.title} · ${n.readOnly ? "view only" : n.sync === "saving" ? "saving…" : n.live === "live" ? "live" : "offline"}` : n.user ? "Signed in · pick a world in Cloud" : "On this device · sign in under Cloud"; };
    Cloud.subscribe(paintNow); paintNow(Cloud.state);
    setOpen(innerWidth > 900);
    setTab("media"); refreshAll();
    World.onSelect(() => { renderList(); renderInspector(); if (World.selected) { setTab("media"); setOpen(true); root.querySelector(".studio-body").scrollTop = 0; const row = listEl.querySelector(`[aria-selected="true"]`); row && row.scrollIntoView({ block: "nearest" }); } });
    Scene.subscribe(ev => {
      if (ev.type === "items" || ev.type === "reset") { renderList(); renderInspector(); syncs.forEach(f => f()); }
      else if (ev.type === "item") { const p = ev.patch || {}; if ("hidden" in p) renderList(); inspSyncs.forEach(f => f()); }
      else if (ev.type === "bg" || ev.type === "view") { syncs.forEach(f => f()); inspSyncs.forEach(f => f()); }
    });
  }
  function refreshAll() { renderList(); renderInspector(); syncs.forEach(f => f()); }
  return { build };
})();
