-- Which terms a key accepted, in the row every upload already reads, and to the hour so it names no upload.
ALTER TABLE keys ADD COLUMN terms_version TEXT;
ALTER TABLE keys ADD COLUMN terms_hour INTEGER;
