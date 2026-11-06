-- What the operator did and to what, so an action can be answered for later (decision 45).
CREATE TABLE moderation (
  at INTEGER NOT NULL,
  doc TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (at, doc, action)
) WITHOUT ROWID;

-- Only the operator lifts what the operator blocked: no appeal or new version overrules that decision.
ALTER TABLE docs ADD COLUMN blocked_by_operator INTEGER NOT NULL DEFAULT 0;
