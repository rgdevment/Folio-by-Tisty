import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const REQUIRED = ["docs", "reports", "holds", "service_day", "service_stage", "false_reporters", "d1_migrations"];
const LEFT_OUT = /^(seen_\d+|net_day|net_hour)$/;

const file = process.argv[2];
if (!file) throw new Error("give the dump to check");

const db = new DatabaseSync(":memory:");
// A fixed message, because SQLite's can quote the dump and this repository's logs are public.
try {
  db.exec(readFileSync(file, "utf8"));
} catch {
  throw new Error("the dump does not load");
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all()
  .map((one) => String(one.name));
const missing = REQUIRED.filter((name) => !tables.includes(name));
if (missing.length > 0) throw new Error(`the dump lacks ${missing.join(", ")}`);

for (const name of tables.filter((one) => LEFT_OUT.test(one))) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get();
  if (n !== 0) throw new Error(`the dump carries rows of ${name}, which it must leave out`);
}

const { migrations } = db.prepare("SELECT COUNT(*) AS migrations FROM d1_migrations").get();
if (migrations === 0) throw new Error("the dump holds no rows");

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all();
if (indexes.length === 0) throw new Error("the dump has no indexes, and d1_migrations would say they exist");

const { integrity_check: integrity } = db.prepare("PRAGMA integrity_check").get();
if (integrity !== "ok") throw new Error(`the dump is damaged: ${integrity}`);

console.log("the dump restores");
