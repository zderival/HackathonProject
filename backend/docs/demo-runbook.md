# Demo runbook

## Before the demo (once)

```bash
docker compose up -d db s3          # PostgreSQL + S3-compatible storage
npm ci
cp .env.example .env                # set GEMINI_API_KEY (never commit .env)
npm run migrate
npm run storage:cors                # browsers may load textures from signed URLs
npm run seed:demo                   # prints 4 accounts + a random password ONCE
npm run smoke:gemini                # real Gemini check per language; listen to reports/audio/*.wav
npm run dev                         # API on http://localhost:8080
npm run demo:simulate               # automated dress rehearsal (prints latency)
```

For phones on the same Wi-Fi, set `PUBLIC_API_URL`, `S3_PUBLIC_ENDPOINT`, `DEEP_LINK_BASE_URL`
to your computer's LAN IP (e.g. `http://192.168.1.20:8080`), or use the deployed HTTPS URLs.

Accounts from the seed (password printed by the seed): `owner@demo.gallery.test` (en),
`editor@...` (ht), `editor2@...` (ko), `viewer@...` (es). Each seed run creates a new
"Demo Gallery" and resets these passwords.

## Script (about 6 minutes)

| # | Who / where | Action | What the audience sees |
|---|---|---|---|
| 1 | Owner (website) | Sign in, open "Demo Gallery" | Furnished room, three artworks, bench, sculpture, spotlights |
| 2 | Owner | "Preview on phone" -> QR (`viewer-sessions {kind: preview}` + `/v1/pairings/qr`) | QR code on screen |
| 3 | Phone 1 (+ phone 2) | Scan, app claims the pairing code, headset on | The same room in VR; looking around is local head tracking |
| 4 | Editor (2nd laptop, `editor@`) | Sign in, open the gallery | Presence of a second editor |
| 5 | Owner | Upload an image, drag it onto the north wall | Appears on both phones within a blink |
| 6 | Editor | Resize the room wider, darken the floor, warm the key light | Walls move out on the phones |
| 7 | Owner | Move the viewpoint (`setViewerAnchor`) | Phones glide to the new spot; heads still turn freely |
| 8 | Both | Edit the same frame at once | Second editor gets a clear conflict, nothing lost |
| 9 | Editor (Haitian Creole) | Voice: "Mete mi yo blan." | Walls turn white; written reply in Kreyòl, then spoken reply |
| 10 | Owner | Text: "Make the selected painting a little larger" then "a little more" | Follow-up resizes the same painting again |
| 11 | Owner | Mute toggle, then ask "Any ideas for the lighting?" | Written suggestions only, no audio, nothing changes |
| 12 | Owner | "Undo that" (or the undo button) | Only the assistant's last change reverts; the editor's floor stays |
| 13 | Owner | Members panel: downgrade the editor to viewer | Editor's toolbar disables instantly; their next edit is refused |
| 14 | Owner | Sharing: rotate the view link | The old QR stops working (resolve returns 410) |
| 15 | (optional) Visitor | Donate on devnet from Phantom | Total donated updates live |

Fallbacks: if Gemini is slow or unavailable, the command shows `failed` with a localized
message and nothing changes; continue with manual edits. If a phone disconnects, it
reconnects with backoff and resyncs to the latest state automatically.

## After the demo

`npm run demo:simulate -- --base <url>` prints the latency summary to quote. Do not claim
VR frame rates, lens correction or audio quality from the backend tests; those belong to the
client apps and to listening tests.
