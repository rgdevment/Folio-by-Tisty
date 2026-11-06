-- Every table finds by its key, since each index apart costs another row on every write (decision 128).
-- The readers of each day live in their own table, seen_<day>, which the store creates and drops: dropping costs no rows.

CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  anchor TEXT,
  permit TEXT,
  admin_hash TEXT NOT NULL,
  latest INTEGER NOT NULL DEFAULT 0,
  versions TEXT NOT NULL DEFAULT '[]',
  bytes INTEGER NOT NULL DEFAULT 0,
  ttl_days INTEGER NOT NULL,
  dies_on INTEGER NOT NULL,
  active_day INTEGER NOT NULL,
  paused_at INTEGER,
  blocked_at INTEGER,
  blocked_hour INTEGER,
  appealed_at INTEGER,
  appealed_hour INTEGER,
  legal_until INTEGER,
  read_total INTEGER NOT NULL DEFAULT 0,
  days TEXT NOT NULL DEFAULT '{}'
) WITHOUT ROWID;

CREATE INDEX docs_owner ON docs (owner, anchor);

CREATE TABLE service_day (
  day INTEGER PRIMARY KEY,
  readers INTEGER NOT NULL,
  docs INTEGER NOT NULL,
  hours TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE service_stage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stage TEXT NOT NULL,
  alerted TEXT NOT NULL DEFAULT 'open',
  digested_hour INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE net_day (
  day INTEGER NOT NULL,
  net TEXT NOT NULL,
  docs INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (day, net)
) WITHOUT ROWID;

-- One row per network and action, reset within itself each hour: the network's name changes every day (decision 137).
CREATE TABLE net_hour (
  net TEXT NOT NULL,
  action TEXT NOT NULL,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (net, action)
) WITHOUT ROWID;

CREATE TABLE reports (
  doc TEXT NOT NULL,
  net TEXT NOT NULL,
  at INTEGER NOT NULL,
  at_hour INTEGER NOT NULL,
  category TEXT NOT NULL,
  detail TEXT,
  sealed_link TEXT,
  asn INTEGER NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc, net)
) WITHOUT ROWID;

CREATE TABLE false_reporters (
  net TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE revocations (
  root TEXT NOT NULL,
  machine TEXT NOT NULL,
  at INTEGER NOT NULL,
  signed TEXT NOT NULL,
  PRIMARY KEY (root, machine)
) WITHOUT ROWID;

CREATE TABLE holds (
  held TEXT NOT NULL,
  holder TEXT NOT NULL,
  PRIMARY KEY (held, holder)
) WITHOUT ROWID;

CREATE INDEX holds_holder ON holds (holder);

CREATE TABLE openings (
  doc TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (doc, at)
) WITHOUT ROWID;
