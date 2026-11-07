import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LEVEL_ONE, levelOfReport } from "../src/core/limits";
import { saidOf } from "../src/core/report";
import { isSealedContact, isSealedLink } from "../src/core/sealed-link";
import { OPERATOR_KEY } from "../src/page/operator-key";
import { sealContact, sealLink } from "../src/page/ui/seal";

const ID = "k7Qm2xPa";
const WHY = "imita a un banco";
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

  it("seals an email apart from a link, under its own document", async () => {
    const sealed = await sealContact(ID, "a@b.co", operatorKey);
    expect(isSealedContact(sealed)).toBe(true);
    expect(sealed.startsWith("contact1.")).toBe(true);
    expect(keyScript("open", file, ID, sealed)).toBe("a@b.co");
    expect(() => keyScript("open", file, "another1", sealed)).toThrow();
    const longest = await sealContact(ID, `${"a".repeat(244)}@example.co`, operatorKey);
    expect(isSealedContact(longest)).toBe(true);
    expect(isSealedLink(longest)).toBe(false);
    expect(isSealedContact(await sealLink(ID, LINK_KEY, operatorKey))).toBe(false);
  });

  it("will not open under the other kind's label", async () => {
    const sealed = await sealContact(ID, "a@b.co", operatorKey);
    expect(() => keyScript("open", file, ID, `sealed1.${sealed.slice("contact1.".length)}`)).toThrow();
    expect(() => keyScript("open", file, ID, "other1.abc")).toThrow();
  });

  it("shows what controls a terminal as text, since anyone can seal anything", async () => {
    const sealed = await sealContact(ID, "a\u001b[2Jb\u202Ec\nd", operatorKey);
    const shown = keyScript("open", file, ID, sealed);
    expect(shown).toBe("a\\u{1b}[2Jb\\u{202e}c\\u{a}d");
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

  it.each(["threat", "doxxing", "intimate", "csam"])("refuses a grave report of %s without its link", (category) => {
    expect(saidOf({ category, detail: WHY }, LEVEL_ONE)).toBeNull();
    expect(saidOf({ category, detail: WHY, sealedLink: sealed }, LEVEL_ONE)).not.toBeNull();
  });

  it("takes an email only sealed, and not on a light report", () => {
    const sealedContact = `contact1.${"A".repeat(80)}`;
    expect(saidOf({ category: "phishing", detail: WHY, sealedContact }, LEVEL_ONE)).toEqual({
      category: "phishing",
      detail: WHY,
      sealedContact,
    });
    expect(saidOf({ category: "spam", sealedContact }, LEVEL_ONE)).toBeNull();
    expect(saidOf({ category: "offensive", sealedContact }, LEVEL_ONE)).toBeNull();
    for (const said of [
      "a@b.co",
      `contact1.${"A".repeat(79)}`,
      `sealed1.${"A".repeat(80)}`,
      `contacts.${"A".repeat(80)}`,
      `contact1.${"A".repeat(504)}`,
      7,
    ]) {
      expect(saidOf({ category: "phishing", detail: WHY, sealedContact: said }, LEVEL_ONE)).toBeNull();
    }
  });

  it.each(["phishing", "malware", "scam"])("asks %s to say why, in at least a few words", (category) => {
    expect(saidOf({ category }, LEVEL_ONE)).toBeNull();
    expect(saidOf({ category, detail: "corto" }, LEVEL_ONE)).toBeNull();
    expect(saidOf({ category, detail: `   ${"x".repeat(9)}   ` }, LEVEL_ONE)).toBeNull();
    expect(saidOf({ category, detail: 7 }, LEVEL_ONE)).toBeNull();
    expect(saidOf({ category, detail: "x".repeat(10) }, LEVEL_ONE)).not.toBeNull();
  });

  it("does not ask a light report to say why", () => {
    expect(saidOf({ category: "offensive" }, LEVEL_ONE)).toEqual({ category: "offensive" });
  });

  it("takes a category it knows, with what it may bring", () => {
    expect(saidOf({ category: "spam" }, LEVEL_ONE)).toEqual({ category: "spam" });
    expect(saidOf({ category: "threat", detail: WHY, sealedLink: sealed }, LEVEL_ONE)).toEqual({
      category: "threat",
      detail: WHY,
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
