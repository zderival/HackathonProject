#!/usr/bin/env node
/* My World: web server for the front end.
   - serves this folder (no build step)
   - forwards /v1/* (REST + WebSocket), /health, /ready and /openapi.json to the backend, so the page and the API
     share ONE address. That is what lets a phone that scanned the QR code reach everything through a single URL
     (no CORS, no second port, no mixed http/ws content, and the backend's PUBLIC_API_URL no longer matters).
   - serves index.html for the share links the backend creates: /view/<id>, /p/<code>, /g/<id>, /invite/<token>
   - GET /__info tells the page which LAN addresses a phone could use for the QR code.

   Environment:
     PORT         default 5173
     HOST         default 0.0.0.0 (so phones on your Wi-Fi can connect)
     BACKEND_URL  default http://localhost:8080
     HTTPS=1      serve https with a self-signed certificate (needs `openssl`); phones then allow motion sensors
     PUBLIC_URL   optional: the https address of a tunnel (Cloudflare Tunnel, ngrok) that points at this server
   Zero dependencies: Node 18+ is enough. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const BACKEND = new URL(process.env.BACKEND_URL || "http://localhost:8080");
const USE_HTTPS = process.env.HTTPS === "1";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
};
const SPA = [/^\/view\/[^/]+\/?$/, /^\/p\/[^/]+\/?$/, /^\/g\/[^/]+(\/join)?\/?$/, /^\/invite\/[^/]+\/?$/];
const PROXIED = [/^\/v1(\/|$)/, /^\/health$/, /^\/ready$/, /^\/openapi\.json$/];

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  // 192.168.x / 10.x first: those are the ones a phone on your Wi-Fi can reach
  return out.sort((a, b) => Number(/^(192\.168|10\.)/.test(b)) - Number(/^(192\.168|10\.)/.test(a)));
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const headers = { "content-type": type, "cache-control": file.endsWith(".html") ? "no-cache" : "public, max-age=300", "accept-ranges": "bytes" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) { // videos need Range requests
      let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2])), end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file, { start, end }).pipe(res); return;
    }
    res.writeHead(200, { ...headers, "content-length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function proxyHttp(req, res) {
  const lib = BACKEND.protocol === "https:" ? https : http;
  const headers = { ...req.headers, host: BACKEND.host };
  const fwd = req.socket.remoteAddress; headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], fwd].filter(Boolean).join(", ");
  headers["x-forwarded-proto"] = USE_HTTPS ? "https" : "http";
  const up = lib.request({ protocol: BACKEND.protocol, hostname: BACKEND.hostname, port: BACKEND.port || (BACKEND.protocol === "https:" ? 443 : 80), method: req.method, path: req.url, headers }, r => {
    res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
  });
  up.on("error", e => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BACKEND_UNREACHABLE", message: `The backend at ${BACKEND.origin} isn't answering (${e.code || e.message}). Start it with "npm run dev" in the backend folder, or run "npm run mock" here.`, details: null, requestId: null } }));
  });
  req.on("aborted", () => up.destroy());
  req.pipe(up);
}

function proxyUpgrade(req, socket, head) {
  const target = net.connect({ host: BACKEND.hostname, port: Number(BACKEND.port || (BACKEND.protocol === "https:" ? 443 : 80)) }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]; lines.push(`${k}: ${k.toLowerCase() === "host" ? BACKEND.host : req.rawHeaders[i + 1]}`);
    }
    target.write(lines.join("\r\n") + "\r\n\r\n"); if (head && head.length) target.write(head);
    socket.pipe(target); target.pipe(socket);
  });
  const bye = () => { socket.destroy(); target.destroy(); };
  target.on("error", bye); socket.on("error", bye); socket.on("close", bye); target.on("close", bye);
}

function handler(req, res) {
  const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
  if (PROXIED.some(r => r.test(p))) return proxyHttp(req, res);
  if (p === "/__info") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ app: "my-world", port: PORT, https: USE_HTTPS, lan: lanAddresses(), publicUrl: PUBLIC_URL, backend: BACKEND.origin }));
  }
  if (SPA.some(r => r.test(p))) {
    // share links live below /view/, /p/, /g/ ... so relative asset URLs must resolve from the site root
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace("<head>", '<head>\n<base href="/">');
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : html);
  }
  const file = path.normalize(path.join(ROOT, p === "/" ? "index.html" : p));
  const blocked = /(^|[\\/])(\.|node_modules|tools|serve\.mjs|package(-lock)?\.json|README)/i.test(path.relative(ROOT, file));
  if (!file.startsWith(ROOT + path.sep) || blocked) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("Forbidden"); }
  sendFile(req, res, file);
}

function certificate() {
  const dir = path.join(ROOT, ".certs"), key = path.join(dir, "key.pem"), crt = path.join(dir, "cert.pem");
  if (!fs.existsSync(key) || !fs.existsSync(crt)) {
    fs.mkdirSync(dir, { recursive: true });
    const san = ["DNS:localhost", "IP:127.0.0.1", ...lanAddresses().map(a => `IP:${a}`)].join(",");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=my-world.local", "-addext", `subjectAltName=${san}`, "-keyout", key, "-out", crt], { stdio: "ignore" });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

export function start({ port = PORT, host = HOST } = {}) {
  const server = USE_HTTPS ? https.createServer(certificate(), handler) : http.createServer(handler);
  server.on("upgrade", (req, socket, head) => {
    if (PROXIED.some(r => r.test(new URL(req.url, "http://x").pathname))) proxyUpgrade(req, socket, head); else socket.destroy();
  });
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("serve.mjs")) {
  const server = await start();
  const scheme = USE_HTTPS ? "https" : "http", port = server.address().port;
  console.log(`\n  My World is running.\n`);
  console.log(`  On this computer   ${scheme}://localhost:${port}/`);
  for (const a of lanAddresses()) console.log(`  On your Wi-Fi      ${scheme}://${a}:${port}/`);
  if (PUBLIC_URL) console.log(`  Public (tunnel)    ${PUBLIC_URL}/`);
  console.log(`  Backend            ${BACKEND.origin}  (forwarded at /v1)`);
  if (!USE_HTTPS && !PUBLIC_URL) console.log(`\n  Tip: phones only share motion sensors on https. Run with HTTPS=1 or put a tunnel in front and set PUBLIC_URL.`);
  console.log("");
}
