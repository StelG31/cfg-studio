-- models/schema.sql
-- ---------------------------------------------------------------------------
-- Purpose:
--   The complete CFG Studio database schema. Applied by models/migrate.js on
--   every startup; every statement is idempotent, so running it against an
--   up-to-date database is a no-op.
--
--   The whole schema is created at once, including the tables that only the
--   authentication phase will use. grammars.owner_id is a foreign key into
--   users, so introducing these tables piecemeal would mean altering a live
--   table later. Creating them together now means the auth phase adds code
--   and touches no tables at all.
--
--   variables, terminals and productions are JSONB rather than normalised
--   rows. A grammar is always read and written as one whole document, and
--   there is never a query like "find all grammars containing rule X".
--   Normalising them would add joins and no capability. The relationships
--   that DO get queried — user to grammars, teacher to students — are real
--   columns with real foreign keys.

BEGIN;

-- CREATE TABLE IF NOT EXISTS is NOT race-safe on its own: two instances
-- booting together can both pass the existence check, and the loser then
-- fails with 23505 on a system catalogue index. This lock makes the whole
-- migration mutually exclusive across the cluster. The XACT variant releases
-- itself on COMMIT or ROLLBACK, so a migration that crashes half way cannot
-- wedge every future boot. The key is an arbitrary constant and must never
-- change.
SELECT pg_advisory_xact_lock(823141);

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
    -- Students belong to a teacher. Deleting a teacher removes their
    -- students; admins and teachers simply leave this NULL.
    teacher_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grammars (
    id           UUID PRIMARY KEY,
    owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    variables    JSONB NOT NULL,
    terminals    JSONB NOT NULL,
    start_symbol TEXT NOT NULL,
    productions  JSONB NOT NULL,
    test_strings JSONB NOT NULL DEFAULT '{"accept":[],"reject":[]}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    -- Session ids are opaque random tokens, not UUIDs: they are secrets,
    -- and a UUID advertises its own structure and generation time.
    id         TEXT PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A foreign key does not create an index, so deleting a user would otherwise
-- force a sequential scan of every child table to enforce the cascade.
CREATE INDEX IF NOT EXISTS grammars_owner_id_idx ON grammars (owner_id);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS users_teacher_id_idx ON users (teacher_id);

-- Backs the grammar listing, which is always ordered newest-first.
CREATE INDEX IF NOT EXISTS grammars_updated_at_idx ON grammars (updated_at DESC);

-- Backs expiry sweeps of the session table.
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

COMMIT;
