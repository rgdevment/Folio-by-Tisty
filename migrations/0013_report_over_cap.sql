-- A network that reached its documents stays on record for the operator, and counts for nothing (decision 41).
ALTER TABLE reports ADD COLUMN over_cap INTEGER NOT NULL DEFAULT 0;
