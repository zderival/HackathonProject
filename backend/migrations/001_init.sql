-- Core schema: identity, sessions, galleries (scene JSONB + revision), membership,
-- action history, assets, WebSocket tickets and viewer sessions.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  preferred_language text NOT NULL DEFAULT 'en',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

-- Opaque tokens; only SHA-256 hashes are stored.
CREATE TABLE auth_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_hash        text NOT NULL UNIQUE,
  refresh_hash       text NOT NULL UNIQUE,
  access_expires_at  timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at         timestamptz,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE galleries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users(id),
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  sharing_mode   text NOT NULL DEFAULT 'restricted'
                 CHECK (sharing_mode IN ('restricted', 'view_link', 'edit_link')),
  -- Share link tokens. Rotating replaces the token and bumps link_version.
  view_link_token text NOT NULL,
  edit_link_token text NOT NULL,
  link_version   integer NOT NULL DEFAULT 1,
  -- Bumped whenever sharing/membership changes; live sessions recheck access.
  access_version integer NOT NULL DEFAULT 1,
  scene          jsonb NOT NULL,
  schema_version integer NOT NULL,
  revision       bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX galleries_owner ON galleries (owner_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX galleries_view_token ON galleries (view_link_token);
CREATE UNIQUE INDEX galleries_edit_token ON galleries (edit_link_token);

-- Explicit roles (source invite/direct) are permanent until changed.
-- source = 'link' rows only count while the edit link with the same link_version is enabled.
CREATE TABLE gallery_members (
  gallery_id   uuid NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('editor', 'viewer')),
  source       text NOT NULL CHECK (source IN ('invite', 'direct', 'link')),
  link_version integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gallery_id, user_id)
);
CREATE INDEX gallery_members_user ON gallery_members (user_id);

CREATE TABLE gallery_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id  uuid NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('editor', 'viewer')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gallery_invitations_gallery ON gallery_invitations (gallery_id);

-- One row per committed revision. `changes` holds before/after values for undo and replay.
CREATE TABLE gallery_actions (
  gallery_id     uuid NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  revision       bigint NOT NULL,
  action_id      uuid NOT NULL,
  request_id     text NOT NULL,
  actor_id       uuid REFERENCES users(id),
  source         text NOT NULL CHECK (source IN ('manual', 'ai', 'undo', 'redo', 'system')),
  base_revision  bigint NOT NULL,
  label          text,
  ops            jsonb NOT NULL,
  changes        jsonb NOT NULL,
  undo_of        bigint,          -- revision this undo reverted
  redo_of        bigint,          -- revision of the undo this redo reverted
  undone         boolean NOT NULL DEFAULT false,
  ai_command_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gallery_id, revision)
);
CREATE UNIQUE INDEX gallery_actions_request ON gallery_actions (gallery_id, actor_id, request_id);
CREATE INDEX gallery_actions_actor ON gallery_actions (gallery_id, actor_id, revision DESC);

CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id    uuid NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL DEFAULT 'image' CHECK (kind IN ('image')),
  status        text NOT NULL CHECK (status IN ('ready', 'deleted')),
  original_format text NOT NULL,
  width         integer NOT NULL,
  height        integer NOT NULL,
  bytes         integer NOT NULL,
  sha256        text NOT NULL,
  -- [{name, key, format, width, height, bytes}]
  variants      jsonb NOT NULL,
  title         text NOT NULL DEFAULT '',
  description   text NOT NULL DEFAULT '',
  attribution   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX assets_gallery ON assets (gallery_id, created_at DESC);

-- Single-use, short-lived tickets for opening a WebSocket.
CREATE TABLE ws_tickets (
  ticket_hash   text PRIMARY KEY,
  gallery_id    uuid NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  viewer_session_id uuid,
  capability    text NOT NULL CHECK (capability IN ('edit', 'view')),
  link_token    text,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

-- Read-only sessions for the phone viewer (and website preview links).
CREATE TABLE viewer_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  gallery_id    uuid NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  link_token    text,
  kind          text NOT NULL CHECK (kind IN ('viewer', 'preview')),
  created_by    uuid REFERENCES users(id),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX viewer_sessions_gallery ON viewer_sessions (gallery_id);
