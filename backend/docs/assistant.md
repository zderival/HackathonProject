# Assistant (Gemini): text, voice and spoken replies

## What it does

Editors talk to a gallery-scoped assistant by typing or with a short push-to-talk clip.
The model **proposes** an edit plan; the server validates, authorizes and commits it
through the same pipeline as manual edits (`source: "ai"`). Clear requests are applied
immediately as **one action / one undo step**; genuinely unclear ones get one focused
question and change nothing. After an edit the reply says what changed and asks whether
it looks right. Suggestions never change the scene until the user asks for them.

## Flow (asynchronous, idempotent)

```
POST /v1/galleries/{id}/assistant/conversations {language}          -> conversation
POST /v1/assistant/conversations/{cid}/commands                      -> 202 {id, status: "queued"}
     {requestId, text, language?, audioEnabled?, selectedNodeIds?}
POST /v1/assistant/conversations/{cid}/voice-commands  (multipart)   -> 202
     fields: requestId, language, audioEnabled, selectedNodeIds (JSON), durationMs; file "audio"
GET  /v1/assistant/commands/{id}                                     -> status/result
     or WebSocket {type: "assistant", command} on your edit connection
POST /v1/assistant/commands/{id}/cancel
GET  /v1/assistant/commands/{id}/speech                              -> {url (signed), mimeType, expiresAt, proxyPath}
```

Statuses: `queued` -> `processing` -> one of

| Status | Scene changed? | Show |
|---|---|---|
| `applied` | yes (`actionId`, `revision`) | `reply`, `question`, `suggestions` |
| `needs_clarification` | no | `reply` + `question`; unclear audio asks to repeat or type |
| `answered` | no | answer / ideas |
| `failed` | no | `error.message` (localized) and `reply` |
| `cancelled` | no | - |

The same `requestId` always returns the same command and never applies twice. Cancelling
after the edit committed leaves it `applied` (use undo instead): the edit and the status
change commit in one transaction.

**Speech:** with `audioEnabled: true` (default) speech is generated **after** the written
reply is published (`speech.status`: `pending` -> `ready` | `failed`). `audioEnabled: false`
(mute) skips generation entirely. A speech failure never rolls back the edit or hides the
reply. Output: WAV, 24 kHz mono 16-bit.

## Voice input

Accepted (detected from the bytes): WAV, WebM/Opus (Chrome, Firefox `MediaRecorder`),
MP4/M4A AAC (Safari), OGG, MP3, AAC, FLAC, AIFF. Limits: `ASSISTANT_MAX_AUDIO_BYTES` (4 MB)
and `ASSISTANT_MAX_AUDIO_SECONDS` (30 s; exact for WAV, otherwise the client's `durationMs`
plus the byte limit). Gemini transcribes and plans in one call; the transcript is returned
so users can see what was understood. Low-confidence audio is never acted on. Browser speech
recognition is not required.

## Follow-ups and revisions

The model receives bounded context: a compact scene summary (up to
`ASSISTANT_MAX_CONTEXT_NODES`), the selection, viewer-relative wall directions
(left/right/front/back from the shared viewpoint), assets, the last 6 actions with
before/after values, and the last `ASSISTANT_MAX_HISTORY_TURNS` turns of the conversation.
That is what makes "a little larger", "use the previous color" and "undo that" refer to the
right thing. "Undo that" undoes the latest action of **this conversation** (or the one the
model names, if it belongs to the user) through the guarded undo, so newer unrelated edits
are preserved.

## Safety model

- The model returns JSON constrained by a response schema; operation names are an
  allowlisted enum. Arguments are parsed and validated against the exact operation schema.
  Nothing is ever executed as code (no JavaScript, SQL, shell or arbitrary tool names).
- The model cannot change permissions, sharing, ownership or accounts: no such operation exists.
- Scene names, titles, descriptions, labels and transcripts are embedded as JSON data and
  the system instruction tells the model they are never instructions.
- Rejected plans get **one** repair attempt with the server's error message; then the command
  fails with `AI_INVALID_PLAN` and a reply that says nothing was changed.
- No database lock is held during inference. At commit the server rechecks permission (a
  downgrade during inference blocks the edit) and the revision: the plan is merged on top of
  unrelated newer edits; if someone changed the same properties, the assistant re-plans once
  on the latest scene, otherwise it fails with a retryable conflict.
- Timeouts (`ASSISTANT_TIMEOUT_MS`), bounded retries with backoff for 429/5xx/network errors
  (`ASSISTANT_MAX_RETRIES`), per-user rate limit (`ASSISTANT_COMMANDS_PER_MINUTE`), input
  length limit, bounded history. The API key stays on the server.

## Languages

`en` (default), `ht` (Haitian Creole), `fr`, `es`, `ko`. Replies are written in the command's
language. Haitian Creole is named to the model explicitly as a distinct language, not French.

| | Status |
|---|---|
| Localized error/system messages | Implemented for all five; machine-written, needs native-speaker review. |
| Text understanding, audio understanding, speech output | **Not claimed until verified** with your key: `npm run smoke:gemini`. Results appear per language in `GET /v1/capabilities` (`assistant.languages`). The Gemini 3.8 Flash TTS documentation (checked 2026-10-10) lists all five languages for speech output. |

`npm run smoke:gemini` sends the five example commands from the brief through the real
model, applies the plans to a real scene offline, checks that each does what was asked,
synthesizes speech per language (saved to `reports/audio/<lang>.wav` for listening), and
feeds that synthesized speech back as voice input. Synthesized speech is not a human
recording; test with real speakers before claiming audio quality.

## Models and configuration

`GEMINI_MODEL` (default `gemini-3.8-flash`) and `GEMINI_TTS_MODEL`
(`gemini-3.8-flash-tts`) are configurable; check availability for your key with the smoke
test. The adapter uses the official `@google/genai` SDK (Interactions API: structured
output via `response_format` with a JSON schema, inline audio input, audio output).

## Tests

`test/assistant.test.ts` drives the full pipeline with a **deterministic fake provider**
(applied edits, clarification, malformed plans and repair, timeouts, speech failure after a
successful edit, mute, idempotency, follow-ups, undo preserving a collaborator's change,
re-planning after a conflicting edit, permission downgrade during inference, cancellation,
voice clips, unsupported/oversized audio). These tests verify the backend's behaviour, **not**
Gemini's language ability. `ASSISTANT_PROVIDER=fake` exists for offline UI work and is refused
in production.
