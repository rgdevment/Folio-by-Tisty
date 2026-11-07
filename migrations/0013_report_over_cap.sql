-- A network that reached its documents stays on record for the operator, and blocks nothing (decision 41).
ALTER TABLE reports ADD COLUMN over_cap INTEGER NOT NULL DEFAULT 0;

-- A report counts what its network reported, and without this each one would read them all.
CREATE INDEX reports_net ON reports (net);
