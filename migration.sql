-- Run this once on your Supabase / PostgreSQL database.
-- The app also auto-creates this table on startup, but running it manually
-- ensures it exists before the first deployment.
--
-- IMPORTANT: value column is TEXT (not JSONB).
-- Baileys Signal protocol keys contain JS Sets / typed arrays that don't
-- serialize cleanly to PostgreSQL JSONB. We store raw JSON strings instead
-- and handle all serialization in the application layer via BufferJSON.

CREATE TABLE IF NOT EXISTS baileys_auth (
    session_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    PRIMARY KEY (session_id, key)
);

-- If you previously ran the JSONB version, migrate with:
-- ALTER TABLE baileys_auth ALTER COLUMN value TYPE TEXT USING value::text;

-- To reset the WhatsApp session (force re-scan QR):
-- DELETE FROM baileys_auth WHERE session_id = 'famfin';
