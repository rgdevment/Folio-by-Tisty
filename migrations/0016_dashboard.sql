-- How each document was read every day, never by whom; and its uploader's network, gone the day after like the quotas.
CREATE TABLE doc_day (
  doc TEXT NOT NULL,
  day INTEGER NOT NULL,
  nets INTEGER NOT NULL,
  proved INTEGER NOT NULL,
  hours INTEGER NOT NULL,
  peak INTEGER NOT NULL,
  by_uploader INTEGER NOT NULL,
  PRIMARY KEY (doc, day)
) WITHOUT ROWID;

CREATE TABLE net_doc (
  day INTEGER NOT NULL,
  doc TEXT NOT NULL,
  net TEXT NOT NULL,
  PRIMARY KEY (day, doc)
) WITHOUT ROWID;

ALTER TABLE net_day ADD COLUMN uploads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_day ADD COLUMN uploads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_day ADD COLUMN new_docs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_day ADD COLUMN new_keys INTEGER NOT NULL DEFAULT 0;
ALTER TABLE docs ADD COLUMN first_day INTEGER;
ALTER TABLE service_stage ADD COLUMN bill REAL;
ALTER TABLE service_stage ADD COLUMN line REAL;
ALTER TABLE service_stage ADD COLUMN stored_gb REAL;
ALTER TABLE service_stage ADD COLUMN spent_at INTEGER;
ALTER TABLE service_stage ADD COLUMN swept_hour INTEGER;
