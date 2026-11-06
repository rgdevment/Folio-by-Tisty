-- What a report is about and what it weighs (decisions 152 and 153). fix_by is the last day to correct a light one.
ALTER TABLE reports ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN level TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE docs ADD COLUMN fix_by INTEGER;
