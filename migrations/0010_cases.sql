-- A link that opens one version for whoever verifies a report or investigates it, even once blocked (decision 152).
CREATE TABLE cases (
  token_hash TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL,
  until INTEGER NOT NULL,
  sealed_records TEXT
) WITHOUT ROWID;
