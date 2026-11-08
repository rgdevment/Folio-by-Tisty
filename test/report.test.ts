import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import VECTORS from "@tisty/contracts/vectors.json";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LEVEL_ONE, levelOfReport } from "../src/core/limits";
import { saidOf } from "../src/core/report";
import { isSealedContact, isSealedLink } from "../src/core/sealed-link";
import { OPERATOR_KEY } from "../src/page/operator-key";
import { sealContact, sealLink } from "../src/page/ui/seal";

const ID = "k7Qm2xPa";
const WHY = "imita a un banco";
const LINK_KEY = "nlt35tFEpAhP5bWJr2p2hIFCFml15FNS5LD2AsBbd2s";
const UNCHECKED = "Not checked, written by whoever reported: ";
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
    expect(keyScript("open", file, ID, sealed)).toBe(`https://tisty.cl/${ID}#${LINK_KEY}`);
    expect(() => keyScript("open", file, "another1", sealed)).toThrow();
    const other = join(folder, "other.key");
    keyScript("new", other);
    expect(() => keyScript("open", other, ID, sealed)).toThrow();
  });

  it("gives a link to open only for its own document, and anything else as text", async () => {
    const elsewhere = await sealContact(ID, `another1#${LINK_KEY}`, operatorKey);
    expect(keyScript("open", file, ID, elsewhere)).toBe(`${UNCHECKED}another1#${LINK_KEY}`);
    const lure = await sealContact(ID, "https://panel-tisty.example/x", operatorKey);
    expect(keyScript("open", file, ID, lure)).toBe(`${UNCHECKED}https:/ /panel-tisty.example/x`);
  });

  it("finds the key under the home folder when its path starts with ~, as PowerShell hands it over", () => {
    const home = mkdtempSync(join(tmpdir(), "folio-home-"));
    const inHome = (...args: string[]) =>
      execFileSync(process.execPath, ["scripts/report-key.mjs", ...args], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }).trim();
    try {
      const made = inHome("new", "~/folio-reports.key");
      expect(made).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(() => inHome("new", join(home, "folio-reports.key"))).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is sealed by the page under a key that holds, and the private part is never here", async () => {
    expect(Buffer.from(OPERATOR_KEY, "base64url")).toHaveLength(32);
    expect(isSealedLink(await sealLink(ID, LINK_KEY, OPERATOR_KEY))).toBe(true);
  });

  it("seals an email apart from a link, under its own document", async () => {
    const sealed = await sealContact(ID, "a@b.co", operatorKey);
    expect(isSealedContact(sealed)).toBe(true);
    expect(sealed.startsWith("contact1.")).toBe(true);
    expect(keyScript("open", file, ID, sealed)).toBe(`${UNCHECKED}a@b.co`);
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
    expect(shown).toBe(`${UNCHECKED}a\\u{1b}[2Jb\\u{202e}c\\u{a}d`);
  });

  it("does not overwrite a key already there", () => {
    expect(() => keyScript("new", file)).toThrow();
  });

  it("differs each time, so two reports cannot be told to be the same link", async () => {
    expect(await sealLink(ID, LINK_KEY, operatorKey)).not.toBe(await sealLink(ID, LINK_KEY, operatorKey));
  });
});

describe("checking a sealed link without opening the document", () => {
  // biome-ignore lint/suspicious/noExplicitAny: these are the contract's own samples, in the shape it writes them.
  const SAMPLES = VECTORS as any;
  const SAMPLE_ID = "k7Qm2xPa";
  const ENVELOPE = Buffer.from(SAMPLES.main.envelope, "hex");
  const operatorKey = keyScript("new", join(folder, "check.key"));
  const keyFile = join(folder, "check.key");
  const CASE = `https://tisty.cl/${SAMPLE_ID}#caso.${"T".repeat(43)}`;
  let server: Server;
  let origin: string;
  let asked: { url: string; token: string | undefined }[] = [];
  let answer: { status: number; body: Buffer } = { status: 200, body: ENVELOPE };

  beforeAll(async () => {
    server = createServer((request, response) => {
      asked.push({ url: request.url ?? "", token: request.headers["folio-case"] as string | undefined });
      response.writeHead(answer.status);
      response.end(answer.body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  beforeEach(() => {
    asked = [];
    answer = { status: 200, body: ENVELOPE };
  });

  const checking = (sealed: string, ...more: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(
        process.execPath,
        ["scripts/report-key.mjs", "check", keyFile, SAMPLE_ID, sealed, ...more],
        { env: { ...process.env, FOLIO_ORIGIN: origin } },
        (error, out, err) => done({ code: Number(error?.code ?? 0), out: out.trim(), err }),
      );
    });

  it("says the key opens it, through the case link alone", async () => {
    const result = await checking(await sealLink(SAMPLE_ID, SAMPLES.link_key, operatorKey), CASE);
    expect(result.code).toBe(0);
    expect(result.out).toContain("opens this document");
    expect(result.out).not.toContain(SAMPLES.link_key);
    expect(asked).toEqual([{ url: `/api/v1/cases/${SAMPLE_ID}`, token: "T".repeat(43) }]);
  });

  it("says a made-up key does not open it", async () => {
    const result = await checking(await sealLink(SAMPLE_ID, "A".repeat(43), operatorKey), CASE);
    expect(result.code).toBe(3);
    expect(result.out).toContain("does not open it");
  });

  it("says what is sealed is no key, when it is no link", async () => {
    const result = await checking(await sealContact(SAMPLE_ID, "a@b.co", operatorKey), CASE);
    expect(result.code).toBe(3);
    expect(asked).toEqual([]);
  });

  it("will not check without a link to verify, so it never reads like a visitor", async () => {
    const sealed = await sealLink(SAMPLE_ID, SAMPLES.link_key, operatorKey);
    expect((await checking(sealed)).code).toBe(1);
    const result = await checking(sealed, "not-a-link");
    expect(result.code).toBe(1);
    expect(result.err).toContain("make a link to verify");
    expect(asked).toEqual([]);
  });

  it("says so when the link brings nothing", async () => {
    answer = { status: 404, body: Buffer.from("{}") };
    const result = await checking(await sealLink(SAMPLE_ID, SAMPLES.link_key, operatorKey), CASE);
    expect(result.code).toBe(1);
    expect(result.err).toContain("could not be brought: 404");
  });

  it("stops reading once it has the manifest", async () => {
    answer = { status: 200, body: Buffer.concat([ENVELOPE, Buffer.alloc(8_000_000)]) };
    const result = await checking(await sealLink(SAMPLE_ID, SAMPLES.link_key, operatorKey), CASE);
    expect(result.out).toContain("opens this document");
  });

  it.each([
    ["what is not an envelope", Buffer.from("<html>")],
    ["a manifest past its size", Buffer.concat([Buffer.from("TENV"), Buffer.from([0, 1, 0, 0]), Buffer.alloc(70_000)])],
    [
      "what ends before its manifest",
      Buffer.concat([Buffer.from("TENV"), Buffer.from([0, 0, 0, 200]), Buffer.alloc(10)]),
    ],
  ])("refuses %s", async (_, body) => {
    answer = { status: 200, body };
    const result = await checking(await sealLink(SAMPLE_ID, SAMPLES.link_key, operatorKey), CASE);
    expect(result.code).toBe(1);
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
