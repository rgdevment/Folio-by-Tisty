-- Which terms a key accepted and when the server first heard it, in the row every upload already reads.
ALTER TABLE keys ADD COLUMN terms_version TEXT;
ALTER TABLE keys ADD COLUMN terms_at INTEGER;
