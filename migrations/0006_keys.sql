-- Every key that ever shared, for good: its limits and reputation belong to it, and a new one starts from the least (decision 102).
CREATE TABLE keys (
  root TEXT PRIMARY KEY,
  first_day INTEGER NOT NULL
) WITHOUT ROWID;

ALTER TABLE net_day ADD COLUMN keys INTEGER NOT NULL DEFAULT 0;
