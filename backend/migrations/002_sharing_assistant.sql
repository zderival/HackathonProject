-- Phone pairing for preview sessions, and the Gemini assistant (conversations,
-- messages and asynchronous commands).

-- A preview session can be claimed once by a phone using a short-lived pairing code
-- shown as a QR code by the website. The vs_ token itself never appears in a QR code.
ALTER TABLE viewer_sessions
  ADD COLUMN pairing_code_hash text UNIQUE,
  ADD COLUMN pairing_expires_at timestamptz,
  ADD COLUMN claimed_at timestamptz;

CREATE TABLE ai_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id  uuid NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language    text NOT NULL DEFAULT 'en',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_owner ON ai_conversations (gallery_id, user_id, updated_at DESC);

-- One command = one typed or spoken request. Status flow:
--   queued -> processing -> applied | needs_clarification | answered | failed | cancelled
CREATE TABLE ai_commands (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  gallery_id       uuid NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id       text NOT NULL,
  input_kind       text NOT NULL CHECK (input_kind IN ('text', 'audio')),
  input_text       text,
  audio_key        text,
  audio_mime       text,
  transcript       text,
  language         text NOT NULL,
  audio_enabled    boolean NOT NULL DEFAULT true,
  selected_node_ids jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL CHECK (status IN ('queued', 'processing', 'applied', 'needs_clarification', 'answered', 'failed', 'cancelled')),
  intent           text,
  reply_text       text,
  question         text,
  suggestions      jsonb NOT NULL DEFAULT '[]',
  plan             jsonb,
  action_id        uuid,
  revision         bigint,
  error_code       text,
  error_details    jsonb,
  speech_status    text NOT NULL DEFAULT 'disabled'
                   CHECK (speech_status IN ('disabled', 'pending', 'ready', 'failed')),
  speech_key       text,
  speech_mime      text,
  speech_error     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE UNIQUE INDEX ai_commands_request ON ai_commands (user_id, request_id);
CREATE INDEX ai_commands_conversation ON ai_commands (conversation_id, created_at);
