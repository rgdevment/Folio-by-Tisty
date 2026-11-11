-- Who edited first wins a tie past the cap of what a reader is told, since roots made later cannot have arrived before.
ALTER TABLE editors ADD COLUMN first_version INTEGER;
