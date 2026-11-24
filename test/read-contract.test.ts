import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTRACTS, check, checkHtml } from "@tisty/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withoutTasks } from "../scripts/read-contract";

interface Said {
  group: string;
  cases?: { says: string; value: unknown }[];
  html_cases?: { says: string; html: string }[];
}

const WRITTEN = readFileSync("node_modules/@tisty/contracts/check.js", "utf8");
const ALL = Object.entries(CONTRACTS as unknown as Record<string, Said>);
const READ = ALL.filter(([, { group }]) => group !== "tasks");
const TASKS = ALL.filter(([, { group }]) => group === "tasks").map(([name]) => name);

describe("the contract the page is built with", () => {
  let folder: string;
  let lean: { check: typeof check; checkHtml: typeof checkHtml };

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "read-contract-"));
    const file = join(folder, "check.mjs");
    writeFileSync(file, withoutTasks(WRITTEN));
    lean = await import(/* @vite-ignore */ pathToFileURL(file).href);
  });

  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it("leaves the tasks out, and nothing else", () => {
    const written = withoutTasks(WRITTEN);
    expect(TASKS).toContain("task");
    for (const name of TASKS) expect(written).not.toContain(`"${name}":{"fields"`);
    for (const [name] of READ) expect(written).toContain(`"${name}":{`);
    expect(written.slice(written.indexOf(";\n"))).toBe(WRITTEN.slice(WRITTEN.indexOf(";\n")));
  });

  it.each(READ.filter(([, { cases }]) => cases?.length))("checks %s as the whole one does", (name, { cases = [] }) => {
    for (const { says, value } of cases) {
      expect(lean.check(name as "document", value), says).toEqual(check(name as "document", value));
    }
  });

  it("checks the words as the whole one does", () => {
    const said = READ.flatMap(([, { html_cases = [] }]) => html_cases);
    expect(said.length).toBeGreaterThan(0);
    for (const { says, html } of said) expect(lean.checkHtml(html), says).toEqual(checkHtml(html));
  });

  it("stops the build when the check is written another way", () => {
    expect(() => withoutTasks("export const x = 1;\n")).toThrow("not written as it was");
  });
});
