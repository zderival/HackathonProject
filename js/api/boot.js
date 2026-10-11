/* BOOT: runs first, before anything else.
   Share links look like /view/<gallery>?link=<token> (anyone with the link), /p/<code> (one-time phone pairing) and
   /g/<gallery> (the creator's own page). This reads which one this page was opened with, and makes the page's
   relative files (css/, js/, media/) still load from the site root when the path has extra segments.
   (serve.mjs also writes the same <base> into the page itself, because this file is one of those relative files.) */
(function () {
  var boot = window.MW_BOOT = { kind: "", join: false, galleryId: "", code: "", link: "", vr: "", token: "" };
  if (!/^https?:$/.test(location.protocol)) return; // opened as a file: local mode only
  document.write('<base href="/">');
  var p = location.pathname, q = new URLSearchParams(location.search), m;
  boot.vr = q.get("vr") === "goggles" || q.get("vr") === "motion" ? q.get("vr") : "";
  boot.link = q.get("link") || "";
  if ((m = /^\/view\/([0-9a-f-]{36})\/?$/i.exec(p))) { boot.kind = "view"; boot.galleryId = m[1].toLowerCase(); boot.join = true; }
  else if ((m = /^\/p\/([A-Za-z0-9_-]{6,64})\/?$/.exec(p))) { boot.kind = "pairing"; boot.code = m[1]; boot.join = true; }
  else if ((m = /^\/g\/([0-9a-f-]{36})(\/join)?\/?$/i.exec(p))) { boot.kind = "editor"; boot.galleryId = m[1].toLowerCase(); boot.editJoin = !!m[2]; }
  else if ((m = /^\/invite\/([A-Za-z0-9_-]{10,100})\/?$/.exec(p))) { boot.kind = "invite"; boot.token = m[1]; }
})();
