-- Run this once on your Supabase / PostgreSQL database.
-- The app also auto-creates this table on startup, but running it manually
-- ensures it exists before the first deployment.

CREATE TABLE IF NOT EXISTS baileys_auth (
    session_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      JSONB,
    PRIMARY KEY (session_id, key)
);

-- Optional: delete old whatsapp-web.js session tables if they exist
-- DROP TABLE IF EXISTS "RemoteAuth";

-- To reset the WhatsApp session (force re-scan QR):
-- DELETE FROM baileys_auth WHERE session_id = 'famfin';
