/* UTILITIES
   DOM shortcuts, formatting, avatars, toasts and image helpers shared by every screen. */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : n.toLocaleString();
const ago = m => m < 1 ? "just now" : m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : m < 43200 ? Math.floor(m / 1440) + "d" : Math.floor(m / 43200) + "mo";
const piece = i => ({ ...PIECES[i], ...(S.edits[i] || {}) });
const person = id => SAMPLE.people[id];
const initials = n => n.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
const avatarHTML = (name, h, img, extra = "") => `<span class="avatar" style="--h:${h}" ${extra}>${img ? `<img src="${img}" alt="">` : esc(initials(name))}</span>`;
const myAvatar = () => avatarHTML(S.profile.name, 30, S.profile.avatar);

function toast(msg) {
  const t = document.createElement("div"); t.className = "toast glass"; t.textContent = msg;
  $("#toasts").append(t); setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, 2600);
}

/* image with graceful fallback when the file isn't next to the page */
function imgHTML(p, which = "thumb", eager) {
  return `<img src="${which === "full" ? p.src : p.thumb}" alt="${esc(p.t)}" ${eager ? "" : 'loading="lazy"'} decoding="async" draggable="false" class="fade" onload="this.classList.add('loaded')" onerror="this.parentNode&&(this.outerHTML=missingHTML(${p.id}))">`;
}
function missingHTML(i) { const p = piece(i); return `<div class="missing" style="--h:${p.hue};--ar:${p.ar}"><div>${esc(p.t)}<small>${esc(p.k)}</small></div></div>`; }
