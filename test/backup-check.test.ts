import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const folder = mkdtempSync(join(tmpdir(), "folio-backup-"));

const check = (sql: string): string => {
  const file = join(folder, "dump.sql");
  writeFileSync(file, sql);
  return execFileSync(process.execPath, ["scripts/backup-check.mjs", file], { encoding: "utf8", stdio: "pipe" });
};

const TABLES = ["docs", "reports", "holds", "service_day", "service_stage", "false_reporters", "d1_migrations"]
  .map((name) => `CREATE TABLE ${name} (id TEXT);`)
  .join("\n");
const INDEX = "CREATE INDEX docs_owner ON docs (id);";
const WHOLE = `PRAGMA defer_foreign_keys=TRUE;\n${TABLES}\n${INDEX}\nINSERT INTO d1_migrations VALUES ('0001');`;

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("checking a dump", () => {
  it("takes one that restores, even with the empty tables of a day", () => {
    expect(check(`${WHOLE}\nCREATE TABLE seen_20000 (doc TEXT);`)).toContain("the dump restores");
  });

  it("refuses one that lacks a table", () => {
    expect(() => check("CREATE TABLE docs (id TEXT);")).toThrow(/the dump lacks reports/);
  });

  it("refuses one with no indexes", () => {
    expect(() => check(`${TABLES}\nINSERT INTO d1_migrations VALUES ('0001');`)).toThrow(/no indexes/);
  });

  it.each(["seen_20000", "net_day", "net_hour"])("refuses one that carries rows of %s", (name) => {
    expect(() => check(`${WHOLE}\nCREATE TABLE ${name} (doc TEXT);\nINSERT INTO ${name} VALUES ('a');`)).toThrow(
      new RegExp(`carries rows of ${name}`),
    );
  });

  it("refuses one with the schema and no rows", () => {
    expect(() => check(`${TABLES}\n${INDEX}`)).toThrow(/holds no rows/);
  });

  it("refuses one that does not load, and never quotes it", () => {
    let said = "";
    try {
      check(`${WHOLE}\nINSERT INTO reports VALUES ('palabras secretas' 'de una denuncia');`);
    } catch (error) {
      said = String((error as { stderr?: string }).stderr);
    }
    expect(said).toContain("the dump does not load");
    expect(said).not.toContain("secretas");
    expect(said).not.toContain("denuncia");
  });
});
