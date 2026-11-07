-- A key the operator stopped: it uploads nothing more, and what it already shared is decided document by document.
ALTER TABLE keys ADD COLUMN blocked_at INTEGER;
CREATE INDEX keys_blocked ON keys (blocked_at) WHERE blocked_at IS NOT NULL;
