-- The owner's machine and name_tag as last signed: only the owner's own upload may change them (decision 145).
ALTER TABLE docs ADD COLUMN owner_mark TEXT NOT NULL DEFAULT '';
