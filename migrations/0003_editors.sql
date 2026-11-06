-- Who signed as an editor, so a root that owns nothing may still take back a machine (contract, revocation).
CREATE TABLE editors (
  doc TEXT NOT NULL,
  root TEXT NOT NULL,
  PRIMARY KEY (doc, root)
) WITHOUT ROWID;

CREATE INDEX editors_root ON editors (root);
