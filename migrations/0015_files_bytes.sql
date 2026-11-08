-- What the attachments of the latest version weigh, so what a key holds counts them as they are.
ALTER TABLE docs ADD COLUMN files_bytes INTEGER NOT NULL DEFAULT 0;
