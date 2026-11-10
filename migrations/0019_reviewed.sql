-- The owner's latest word on an anchor's reviews and when it came, kept beside the anchor with the version it came in.
ALTER TABLE docs ADD COLUMN reviewed TEXT;
ALTER TABLE docs ADD COLUMN reviewed_at INTEGER;
