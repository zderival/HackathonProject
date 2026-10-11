-- Accounts use a username + password only; email is removed.
-- Existing accounts get a username derived from the part of their email before "@"
-- (sanitized, made unique with a short ID suffix when needed).

ALTER TABLE users ADD COLUMN username text;

WITH base AS (
  SELECT id, created_at,
         left(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9_.-]', '', 'g'), 22) AS b
  FROM users
),
fixed AS (
  SELECT id, created_at, CASE WHEN length(b) < 3 THEN 'user' || b ELSE b END AS b FROM base
),
numbered AS (
  SELECT id, b, row_number() OVER (PARTITION BY b ORDER BY created_at, id) AS n FROM fixed
)
UPDATE users u
SET username = CASE WHEN numbered.n = 1 THEN numbered.b ELSE numbered.b || '-' || left(replace(u.id::text, '-', ''), 6) END
FROM numbered
WHERE numbered.id = u.id;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
DROP INDEX users_email_lower;
ALTER TABLE users DROP COLUMN email;

-- Invitations now target a username. Pending email invitations cannot be matched to a
-- username, so they are revoked; accepted ones keep their history.
UPDATE gallery_invitations SET revoked_at = now() WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE gallery_invitations RENAME COLUMN email TO username;
