# My World

A liquid-glass art portfolio with a dome you can step into. Make a world on your computer, add pictures, text and a sky, and show it on a phone: scan a QR code and the whole world opens there, ready for goggle mode in a headset or cardboard viewer. Edits you make on the computer show up on the phone while you make them.

This folder is the front end. It talks to the backend in `../backend` (Fastify, Postgres, S3, WebSocket, Gemini).

```
Browser / phone ──► serve.mjs (port 5173) ──┬─► this folder's files
                                            └─► /v1/*  (REST + WebSocket) ──► backend (port 8080)
```

`serve.mjs` is the one address everything uses. Because the page and the API share it, a phone that scans the QR code only ever needs this one address: no CORS settings, no second port, and the backend's `PUBLIC_API_URL` stops mattering for phones.

## Run it

**Fastest way:** with Docker Desktop open, `bash run-everything.sh` does steps 1 and 2 below for you, then runs the backend check. `bash run-everything.sh stop` stops it all. The manual steps follow.

You need Node 22 or newer. The front end has no build step and no packages to install.

**1. Start the backend** (once; needs Docker for Postgres and S3)

```bash
cd ../backend
docker compose up -d db s3
cp .env.example .env          # defaults already match docker compose
npm ci
npm run migrate
npm run storage:cors
npm run seed:demo             # optional demo data
npm run dev                   # http://localhost:8080
```

Add `ASSISTANT_PROVIDER=fake` to the backend's `.env` to try the assistant without a Gemini key, or put your `GEMINI_API_KEY` there for the real one. The key stays on the server and never reaches the browser. Without either, the Assistant tab says it isn't switched on.

**2. Start the front end**

```bash
cd HackathonProject
npm start                     # http://localhost:5173
```

Open http://localhost:5173, go to **World → Cloud**, create an account, then **From this dome** (or **Empty**).

**No Docker?** `npm run mock` starts a small in-memory stand-in for the backend on port 8080, good for trying the front end. Nothing is saved when it stops. It is not the real backend.

## Try it on a phone

1. Open **World → Phone**. Choose what the phone should do: *Goggle mode*, *Motion look* or *Just look*, and who can use the code: *Just one phone* (works once, expires in 10 minutes) or *Anyone with it* (a link you can turn off).
2. Scan the QR code. The code holds the address and the choice. The phone opens the world, already signed in as a viewer, with every picture and the sky loaded, and follows your edits live.
3. In goggle mode the screen splits into two eyes. Put the phone in the headset.

**Motion sensors need https on phones.** `http://192.168…` works for dragging to look, but phones only share motion over https. Pick one:

- `HTTPS=1 npm start` makes a self-signed certificate (needs `openssl`). The phone warns once; tap through it.
- Run a tunnel (Cloudflare Tunnel, ngrok) in front of port 5173 and start with `PUBLIC_URL=https://your-tunnel.example npm start`. The QR code then uses that address. This is the smoothest option.

The Phone tab shows a warning when the address isn't secure, and lets you type an address by hand if the computer picked the wrong network.

## Check that it all works

```bash
npm run verify           # about 70 checks against http://localhost:8080
npm run verify -- https://your-backend.example     # or any other backend
npm run test:visual      # drives a browser through the whole story, saves screenshots
```

`npm run verify` makes the same calls the front end makes (sign up, refresh tokens, upload, edit the scene, conflicts, undo, WebSocket, QR pairing, links, assistant) and prints PASS or FAIL for each, with the reason when it fails. Run it first if something feels off: it tells you whether the problem is the backend or the page.

`npm run test:visual` needs `npm i` once, then `npx playwright install chromium`. It starts its own stand-in backend and web server (set `BACKEND_URL=http://localhost:8080` to test your real one), then signs up, makes a world, adds the pictures in `sample-art/`, edits, shows the QR code, plays the phone, uses the one-time code twice, tries a link, rotates it and asks the assistant. It writes the screenshots and a report to `visual-test/report.html`.

## What is where

| | |
|---|---|
| `index.html`, `css/`, `js/` | The site. `js/api/` is the part that talks to the backend; `js/vr/` is the dome, editor and assistant. |
| `js/api/scenemap.js` | Translates between the dome's items and the backend's scene (nodes, operations). Unit tested. |
| `js/api/cloud.js` | Accounts, worlds, the live connection, saving, sharing, the phone join. |
| `serve.mjs` | The web server and `/v1` forwarder. |
| `tools/verify-backend.mjs` | The backend check. |
| `tools/visual-test.mjs` | The browser test. |
| `tools/mock-backend.mjs` | The stand-in backend. |
| `sample-art/` | Six paintings for trying uploads. |

## Good to know

- **Pictures** must be JPEG, PNG or WebP, up to the backend's upload limit (20 MB by default). They are stored as they are; the backend makes smaller copies for faster loading.
- **Videos** work in the dome on your own computer, but the backend stores pictures only, so a world that is connected to the backend refuses them with a short note. Add a picture or text instead.
- **Passwords and keys.** Only sign-in tokens are kept in the browser. No password, and no AI key, is ever stored there.
- **Donations** on the art pages are still the design only; they aren't connected to the backend's donation features.
- **Losing connection.** The page keeps working and reconnects by itself (it retries with a growing pause, and again as soon as the phone or laptop is back online). Changes are saved in small batches; if two people edit at once, the page catches up with the server's version and sends your change again.
- **Phone motion on iPhone** needs a tap on *Start* once (the phone asks permission); Android starts goggle mode by itself when the QR code asked for it.

## Settings

| Variable | Default | |
|---|---|---|
| `PORT` | 5173 | This page |
| `HOST` | 0.0.0.0 | Leave it so phones on your Wi-Fi can connect |
| `BACKEND_URL` | http://localhost:8080 | The backend |
| `HTTPS` | | `1` for a self-signed https |
| `PUBLIC_URL` | | https address of a tunnel in front of this server |

In the backend's `.env`, set `VIEWER_BASE_URL` to the address people open this page at once you deploy (while testing, the Phone tab swaps in the address your phone can actually reach), and `TRUST_PROXY=true` behind a TLS proxy.
