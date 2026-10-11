#!/usr/bin/env node
/* My World: visual test.
   Drives a real browser through the whole story and saves a screenshot at every step, plus a report page:

     sign up → make a world → add pictures → edit → QR code → a phone scans it → goggle mode → live edit →
     the one-time code is used up → the assistant answers

   Everything that can be checked is checked on the way (the server's copy of the scene, the QR code's address, the
   phone seeing the same pictures), and the result is listed in visual-test/report.html.

     npm run test:visual                      starts its own stand-in backend and web server, then tests them
     BACKEND_URL=http://localhost:8080 npm run test:visual    tests your real backend instead (start it first)

   One time setup:  npm i -D playwright   and   npx playwright install chromium */
import fs from "node:fs"; import path from "node:path"; import net from "node:net"; import { spawn } from "node:child_process"; import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, ".."), OUT = path.join(root, "visual-test"), ART = path.join(root, "sample-art") + path.sep;
let chromium; try { ({ chromium } = await import("playwright")); } catch { console.error("\nThe visual test needs Playwright:\n  npm i -D playwright\n  npx playwright install chromium\n"); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });

const steps = [], checks = []; let fails = 0;
const ok = (c, m) => { checks.push({ ok: !!c, m }); if (!c) fails++; console.log((c ? "  ok    " : "  FAIL  ") + m); return !!c; };
let n = 0;
const shot = async (page, name, title, note = "") => { const f = `${String(++n).padStart(2, "0")}-${name}.png`; await page.screenshot({ path: path.join(OUT, f) }); steps.push({ f, title, note }); console.log("  shot  " + f); };

/* servers */
let mock = null, web = null, BACKEND = process.env.BACKEND_URL;
if (!BACKEND) { const { createMock } = await import(pathToFileURL(path.join(here, "mock-backend.mjs"))); const bp = await freePort(); mock = createMock({ port: bp }); await mock.listen(bp, "127.0.0.1"); BACKEND = `http://127.0.0.1:${bp}`; console.log(`stand-in backend on ${BACKEND}`); }
const wp = await freePort(), BASE = `http://localhost:${wp}`;
web = spawn(process.execPath, [path.join(root, "serve.mjs")], { env: { ...process.env, PORT: String(wp), HOST: "127.0.0.1", BACKEND_URL: BACKEND }, stdio: "ignore" });
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + "/__info")).ok) break; } catch {} await sleep(250); }
console.log(`web server on ${BASE}\n`);
const cleanup = async () => { try { web.kill(); } catch {} try { await mock?.close(); } catch {} };

const GL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({ args: GL }); const errs = [];
try {
  const ctxE = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }), ed = await ctxE.newPage(); ed.setDefaultTimeout(120000);
  ed.on("pageerror", e => errs.push("editor: " + e.message)); ed.on("console", m => { if (m.type() === "error" && !/404|ERR_TUNNEL|ERR_ABORTED|Failed to load resource/.test(m.text())) errs.push("editor: " + m.text()); });

  console.log("Editor");
  await ed.goto(BASE + "/", { waitUntil: "domcontentloaded" }); await sleep(1500);
  await shot(ed, "home", "Home", "The liquid-glass home, as it was.");
  await ed.click('.dock button[data-go="world"]'); await sleep(2500);
  await ed.click('#studio .tabs button[data-t="cloud"]'); await sleep(600);
  await shot(ed, "cloud-signed-out", "World tab → Cloud", "Not signed in yet. The chips say whether the server is reachable.");
  ok(await ed.evaluate(() => Cloud.state.available), "the web page can reach the backend");
  await ed.click("text=New here?");
  const user = "visual_" + Date.now().toString(36);
  await ed.fill('input[aria-label="Username"]', user); await ed.fill('input[aria-label="Password"]', "correct horse battery");
  await ed.click('button:has-text("Create account")'); await sleep(1500);
  await shot(ed, "cloud-signed-in", "Signed in", "Worlds live on the server, so you can open them anywhere.");
  await ed.fill('input[aria-label="New world name"]', "Studio One"); await ed.click('button:has-text("Empty")'); await sleep(2000);
  ok(await ed.evaluate(() => Cloud.connected), "a new world is open and connected");
  await shot(ed, "cloud-open", "A world, open", "Live connection and saved state show here.");

  await ed.click('#studio .tabs button[data-t="media"]');
  const files = ["last-light.png", "cloud-study.jpg", "glum-thicket.png", "red-room.webp", "aurora.png", "cosmos.png"].map(f => ART + f).filter(f => fs.existsSync(f));
  await ed.setInputFiles("#studio input[type=file][multiple]", files); await sleep(7000);
  const srv = await ed.evaluate(async () => { const d = Cloud._debug(), sc = await Api.getScene(d.gid); return Object.values(sc.scene.nodes).filter(x => x.type === "artwork" && x.props.assetId).length; });
  ok(srv === files.length, `all ${files.length} pictures are on the server as artwork nodes (${srv})`);
  await shot(ed, "pictures", "Pictures added", "Each picture is uploaded untouched and hung in the dome.");

  const id0 = await ed.evaluate(() => VRStore.items[0].id);
  await ed.evaluate(id => { VRStore.update(id, { az: 55, size: 1.5, frame: "plate" }); VRStore.setBg({ top: "#123456" }); }, id0); await sleep(1800);
  const s1 = await ed.evaluate(async id => { const sc = await Api.getScene(Cloud._debug().gid), nd = sc.scene.nodes[id]; return { x: nd.transform.position[0], top: sc.scene.environment.gradientTopColor }; }, id0);
  ok(Math.abs(s1.x - Math.sin(55 * Math.PI / 180) * 3.3) < 0.01 && s1.top === "#123456", "moving a picture and changing the sky reach the server in the right place");
  await shot(ed, "edited", "Edited", "Moved, enlarged and framed one picture; changed the sky.");

  console.log("\nQR code and phone");
  await ed.click('#studio .tabs button[data-t="share"]'); await sleep(800);
  const info = await ed.evaluate(async () => { await Cloud.newPairing(); await new Promise(r => setTimeout(r, 400)); return Cloud.phoneURL("pair", "goggles"); });
  await sleep(600); await shot(ed, "qr", "Phone tab: the QR code", "Scanning it opens the world on a phone, signed in as a viewer, ready for goggle mode.");
  ok(/\/p\/[A-Za-z0-9_-]{6,}\?vr=goggles$/.test(info), "the QR code holds a one-time pairing address that asks for goggle mode");
  const qr = await ed.$("canvas.qr"); ok(!!qr, "a QR code is drawn");
  if (qr) { const png = path.join(OUT, "qr-only.png"); await qr.screenshot({ path: png }); }

  const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), ph = await ctxP.newPage(); ph.setDefaultTimeout(150000);
  ph.on("pageerror", e => errs.push("phone: " + e.message));
  const phoneUrl = info.replace(/^https?:\/\/[^/]+/, BASE);
  await ph.goto(phoneUrl, { waitUntil: "commit", timeout: 90000 }); await sleep(8000);
  await ph.waitForFunction(() => window.Cloud && Cloud.state.join === "live", null, { timeout: 60000 }).catch(() => {});
  const pj = await ph.evaluate(() => ({ join: Cloud.state.join, items: VRStore.items.length, top: VRStore.bg.top }));
  ok(pj.join === "live" && pj.items === files.length, `the phone joined from the code alone and has all ${files.length} pictures`);
  ok(pj.top === "#123456", "the phone has the creator's sky");
  await sleep(3000);
  const gg = await ph.evaluate(() => ({ on: World._debug().goggles, ready: [...World._debug().rt.values()].filter(r => r.ready && !r.placeholder).length }));
  ok(gg.on, "the QR code started goggle mode by itself (Android; an iPhone shows one Start button)");
  ok(gg.ready === files.length, "every picture loaded on the phone");
  await shot(ph, "phone-goggles", "Phone: goggle mode", "Two eyes, one per half of the screen. Put it in a headset or cardboard viewer.");

  await ed.evaluate(id => { VRStore.update(id, { az: -80, h: 2.1 }); VRStore.applyPreset("glum"); }, id0); await sleep(2500);
  const lv = await ph.evaluate(id => ({ az: VRStore.item(id).az, preset: VRStore.bg.preset }), id0);
  ok(lv.az === -80 && lv.preset === "glum", "an edit made on the computer shows up on the phone a moment later");
  await shot(ph, "phone-live", "Phone: after a live edit", "The creator moved a picture and changed the sky; the phone followed without a refresh.");
  await shot(ed, "editor-after-live", "Editor: same moment", "");

  const ctxP2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }), p2 = await ctxP2.newPage(); p2.setDefaultTimeout(150000);
  await p2.goto(phoneUrl, { waitUntil: "commit", timeout: 90000 }); await sleep(8000);
  await p2.waitForFunction(() => window.Cloud && Cloud.state.join && Cloud.state.join !== "connecting", null, { timeout: 60000 }).catch(() => {});
  ok(await p2.evaluate(() => Cloud.state.join) === "denied", "the same QR code can't be used a second time");
  await shot(p2, "phone-code-used", "Phone: a used code", "Plain words, and a way forward.");
  await ctxP2.close();

  console.log("\nLink mode");
  await ed.click('#studio .tabs button[data-t="share"]');
  const link = await ed.evaluate(async () => { await Cloud.setShareMode("view_link"); await new Promise(r => setTimeout(r, 600)); return Cloud.phoneURL("link", "motion"); });
  await sleep(500); await shot(ed, "qr-link", "Phone tab: link mode", "Anyone with the link can look. Choose motion look instead of goggles.");
  const ctxP3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), p3 = await ctxP3.newPage(); p3.setDefaultTimeout(150000);
  await p3.goto(link.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: "commit", timeout: 90000 }); await sleep(8000);
  await p3.waitForFunction(() => window.Cloud && Cloud.state.join === "live", null, { timeout: 60000 }).catch(() => {});
  ok(await p3.evaluate(() => Cloud.state.join === "live" && VRStore.items.length) === files.length, "a link opens the world on a phone");
  await shot(p3, "phone-link-card", "Phone: opened from a link", "Motion look is the main button because the QR code asked for it.");
  await ed.evaluate(() => Cloud.rotate()); await sleep(2500);
  await p3.reload({ waitUntil: "commit" }); await sleep(8000);
  await p3.waitForFunction(() => window.Cloud && Cloud.state.join && Cloud.state.join !== "connecting", null, { timeout: 60000 }).catch(() => {});
  ok(await p3.evaluate(() => Cloud.state.join) === "denied", "after the creator makes a new link, the old one stops working");
  await ctxP3.close();

  console.log("\nAssistant");
  await ed.click('#studio .tabs button[data-t="ai"]'); await sleep(600);
  const ready = await ed.evaluate(() => Cloud.assistantReady());
  if (ready) {
    const before = await ed.evaluate(() => VRStore.items[0].size);
    await ed.fill("#studio .ai-in", "make the first picture bigger"); await ed.press("#studio .ai-in", "Enter");
    await ed.waitForSelector("#studio .ai-act", { timeout: 30000 }).catch(() => {}); await sleep(800);
    ok(!!(await ed.$("#studio .ai-act")), "the assistant answered in the panel with a one-step Undo");
    ok(await ed.evaluate(() => VRStore.items[0].size) > before, "the change appeared in the dome");
  } else ok(true, "assistant is not switched on in this backend (add GEMINI_API_KEY); the tab says so");
  await shot(ed, "assistant", "Assistant", ready ? "Editor-only. It runs on the server; the key never reaches the browser." : "The server's assistant is off, and the tab explains how to turn it on.");
  ok(!errs.length, "no errors in the browser console" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));
} catch (e) { ok(false, "the test crashed: " + e.message); console.error(e); }

await browser.close(); await cleanup();

/* report */
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My World · visual test</title>
<style>:root{color-scheme:dark}body{margin:0;background:radial-gradient(1200px 700px at 20% -10%,#3a2a4a,transparent),#0b0a12;color:#f5f1ea;font:15px/1.5 system-ui,-apple-system,sans-serif;padding:32px 20px 80px}
main{max-width:1180px;margin:auto}h1{font-weight:600;letter-spacing:.2px;margin:0 0 4px}h1 b{color:#ffb86b}.sub{opacity:.7;margin:0 0 24px}
.sum{display:inline-block;padding:6px 14px;border-radius:99px;background:${fails ? "#5b2330" : "#1f4a3a"};border:1px solid rgba(255,255,255,.2)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:18px;margin:26px 0}
figure{margin:0;padding:12px;border-radius:20px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(14px)}
figure img{width:100%;border-radius:12px;display:block}figcaption b{display:block;margin-top:10px}figcaption span{opacity:.7;font-size:13px}
ul{list-style:none;padding:0}li{padding:5px 0;border-bottom:1px solid rgba(255,255,255,.08)}.p{color:#7fe0b0}.f{color:#ff8a98}</style>
<main><h1>My <b>World</b> · visual test</h1><p class="sub">${new Date().toLocaleString()} · ${BACKEND}</p>
<p><span class="sum">${checks.length - fails} of ${checks.length} checks passed</span></p>
<div class="grid">${steps.map(s => `<figure><a href="${s.f}"><img src="${s.f}" loading="lazy" alt=""></a><figcaption><b>${esc(s.title)}</b><span>${esc(s.note)}</span></figcaption></figure>`).join("")}</div>
<h2>Checks</h2><ul>${checks.map(c => `<li class="${c.ok ? "p" : "f"}">${c.ok ? "✓" : "✗"} ${esc(c.m)}</li>`).join("")}</ul></main>`;
fs.writeFileSync(path.join(OUT, "report.html"), html);
console.log(`\n${checks.length - fails}/${checks.length} checks passed. Open visual-test/report.html\n`);
process.exit(fails ? 1 : 0);
