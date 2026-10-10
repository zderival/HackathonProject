-- Optional Solana donations. One custodial wallet per gallery; its secret key is stored
-- only encrypted (AES-256-GCM with an application key that is not in the database).

CREATE TABLE donation_wallets (
  gallery_id       uuid PRIMARY KEY REFERENCES galleries(id),
  cluster          text NOT NULL,
  public_key       text NOT NULL UNIQUE,
  encrypted_secret bytea NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  message          text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- A donation starts as an intent with a unique Solana Pay reference key and is counted
-- only after the transaction is verified on-chain.
CREATE TABLE donations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id      uuid NOT NULL REFERENCES galleries(id),
  wallet          text NOT NULL,
  reference       text NOT NULL UNIQUE,
  requested_lamports bigint,
  donor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  donor_name      text NOT NULL DEFAULT '',
  donor_message   text NOT NULL DEFAULT '',
  status          text NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired')),
  signature       text UNIQUE,
  lamports        bigint,
  from_address    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  confirmed_at    timestamptz
);
CREATE INDEX donations_gallery ON donations (gallery_id, status, confirmed_at DESC);
CREATE INDEX donations_pending ON donations (expires_at) WHERE status = 'pending';

CREATE TABLE donation_withdrawals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id    uuid NOT NULL REFERENCES galleries(id),
  requested_by  uuid NOT NULL REFERENCES users(id),
  request_id    text NOT NULL,
  destination   text NOT NULL,
  lamports      bigint NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
  signature     text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gallery_id, request_id)
);
