-- What the operator did and to what, so an action can be answered for later (decision 45).
CREATE TABLE moderation (
  at INTEGER NOT NULL,
  doc TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (at, doc, action)
) WITHOUT ROWID;
