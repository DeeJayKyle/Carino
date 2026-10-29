-- Approval integrity: bind each queued action to its exact payload and give it an expiry.
-- Additive and nullable, so rows queued before this migration keep working unchanged.
ALTER TABLE actions ADD COLUMN payload_hash TEXT;
ALTER TABLE actions ADD COLUMN expires_at TEXT;
