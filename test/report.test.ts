import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LEVEL_ONE, levelOfReport } from "../src/core/limits";
import { saidOf } from "../src/core/report";
import { isSealedLink } from "../src/core/sealed-link";
import { OPERATOR_KEY } from "../src/page/operator-key";
import { sealLink } from "../src/page/ui/seal";

const ID = "k7Qm2xPa";
const LINK_KEY = "nlt35tFEpAhP5bWJr2p2hIFCFml15FNS5LD2AsBbd2s";
const folder = mkdtempSync(join(tmpdir(), "folio-report-"));
const file = join(folder, "report.key");

const keyScript = (...args: string[]): string =>
  execFileSync(process.execPath, ["scripts/report-key.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("a link sealed for the operator", () => {
  const operatorKey = keyScript("new", file);

  it("opens only with the operator's key and under its own document", async () => {
    const sealed = await sealLink(ID, LINK_KEY, operatorKey);
    expect(isSealedLink(sealed)).toBe(true);
    expect(sealed).not.toContain(LINK_KEY);
    expect(keyScript("open", file, ID, sealed)).toBe(`${ID}#${LINK_KEY}`);
    expect(() => keyScript("open", file, "another1", sealed)).toThrow();
    const other = join(folder, "other.key");
    keyScript("new", other);
    expect(() => keyScript("open", other, ID, sealed)).toThrow();
  });

  it("is sealed by the page under a key that holds, and the private part is never here", async () => {
    expect(Buffer.from(OPERATOR_KEY, "base64url")).toHaveLength(32);
    expect(isSealedLink(await sealLink(ID, LINK_KEY, OPERATOR_KEY))).toBe(true);
  });

  it("does not overwrite a key already there", () => {
    expect(() => keyScript("new", file)).toThrow();
  });

  it("differs each time, so two reports cannot be told to be the same link", async () => {
    expect(await sealLink(ID, LINK_KEY, operatorKey)).not.toBe(await sealLink(ID, LINK_KEY, operatorKey));
  });
});

describe("what a report may say", () => {
  const sealed = `sealed1.${"A".repeat(150)}`;

  it("takes the version the reader saw", () => {
    expect(saidOf({ category: "spam", version: 4 }, LEVEL_ONE)).toEqual({ category: "spam", version: 4 });
  });

  it("takes a category it knows, with what it may bring", () => {
    expect(saidOf({ category: "spam" }, LEVEL_ONE)).toEqual({ category: "spam" });
    expect(saidOf({ category: "threat", detail: "x", sealedLink: sealed }, LEVEL_ONE)).toEqual({
      category: "threat",
      detail: "x",
      sealedLink: sealed,
    });
  });

  it.each([
    ["no category", {}],
    ["another category", { category: "copyright" }],
    ["what every object inherits", { category: "constructor" }],
    ["a link in the clear", { category: "phishing", sealedLink: `https://tisty.cl/${ID}#${LINK_KEY}` }],
    ["a bare key", { category: "phishing", sealedLink: LINK_KEY }],
    ["a link that is too long", { category: "phishing", sealedLink: `sealed1.${"A".repeat(1024)}` }],
    ["a link on a light report", { category: "spam", sealedLink: sealed }],
    ["a link in the detail", { category: "spam", detail: `mira https://tisty.cl/${ID}#${LINK_KEY}` }],
    ["a link with its token in the detail", { category: "spam", detail: `${ID}#${LINK_KEY}.token` }],
    ["a version that is not one", { category: "spam", version: 0 }],
    ["a version in words", { category: "spam", version: "1" }],
    ["a detail that is too long", { category: "spam", detail: "x".repeat(LEVEL_ONE.reportDetailAtMost + 1) }],
  ])("refuses %s", (_, body) => {
    expect(saidOf(body, LEVEL_ONE)).toBeNull();
  });

  it("gives each category its level", () => {
    expect(["spam", "phishing", "csam", "constructor"].map(levelOfReport)).toEqual(["light", "medium", "grave", null]);
  });
});
