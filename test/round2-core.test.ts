import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEVEL_ONE } from "../src/core/limits";
import { saidOf } from "../src/core/report";
import { holdsALink } from "../src/core/sealed-link";
import { toBase64Url } from "../src/core/start";
import { sealContact, sealLink } from "../src/page/ui/seal";

const KEY = "nlt35tFEpAhP5bWJr2p2hIFCFml15FNS5LD2AsBbd2s";

describe("a key in the detail of a report", () => {
  const said = (detail: string) => saidOf({ category: "spam", detail }, LEVEL_ONE);

  it.each([
    ["with its document and a #", `https://tisty.cl/AbCdEfGh#${KEY}`],
    ["after a # alone", `#${KEY}`],
    ["bare", KEY],
    ["bare between words", `mira esto ${KEY} gracias`],
    ["bare at the end of a sentence", `la llave es ${KEY}.`],
    ["in parentheses", `(${KEY})`],
    ["in quotes", `"${KEY}"`],
    ["after an equals sign", `key=${KEY}`],
    ["after a colon", `llave:${KEY}`],
    ["on its own line", `hola\n${KEY}\nadios`],
    ["with a tab around it", `\t${KEY}\t`],
    ["at the start of an address bar copy", `tisty.cl/AbCdEfGh#${KEY}&x=1`],
    ["in a markdown link", `[mira](https://tisty.cl/AbCdEfGh#${KEY})`],
    ["in angle brackets", `<https://tisty.cl/AbCdEfGh#${KEY}>`],
    ["with an ellipsis after it", `${KEY}…`],
    ["followed by a comma", `${KEY},`],
  ])("is refused when it is %s", (_where, detail) => {
    expect(holdsALink(detail)).toBe(true);
    expect(said(`${detail} es un sitio de estafa`)).toBeNull();
  });

  it.each([
    ["followed by an underscore, as a markdown emphasis closes", `_https://tisty.cl/AbCdEfGh#${KEY}_`],
    ["followed by a dash", `https://tisty.cl/AbCdEfGh#${KEY}-`],
    ["followed by more letters, as when a line is cut and joined", `https://tisty.cl/AbCdEfGh#${KEY}abc`],
  ])("a # link is still refused when its key is %s, as it was before a bare key counted", (_where, detail) => {
    expect(holdsALink(detail), "a key reaches the database in the clear").toBe(true);
  });

  it.each([
    [
      "a link to a page with a 43-character slug",
      "https://example.com/news/this-is-a-slug-of-exactly-forty-three-chars-ok",
    ],
    ["a short link", "https://example.com/a/b?c=d"],
    ["a hex digest of 64 characters", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["a 42-character token", "A".repeat(42)],
    ["a 44-character token", "A".repeat(44)],
    ["a url-safe token inside a long query", `https://example.com/?token=${"a".repeat(80)}`],
    ["a hyphenated sentence", "ya-lo-vi-en-el-sitio-y-pide-datos-de-la-tarjeta-bancaria"],
  ])("lets through %s", (_what, detail) => {
    expect(said(`${detail} es un sitio de estafa`)).not.toBeNull();
  });

  it.each([
    ["a url whose path is exactly one 43-character segment", `https://phishing.example/${"a".repeat(43)}`],
    [
      "a url whose last segment is a 43-character slug",
      "https://news.example/2026/11/un-articulo-de-largo-justo-cuarenta-y-tres-x",
    ],
    ["a url with a 43-character query value", `https://phishing.example/login?session=${"b".repeat(43)}&x=1`],
  ])("does not turn away a report that quotes %s, though it holds no key", (_what, detail) => {
    expect(holdsALink(detail), "a long address is how phishing is reported").toBe(false);
  });
});

describe("report-key.mjs", () => {
  const ID = "k7Qm2xPa";
  const TOKEN = "T".repeat(43);
  const CASE = `https://tisty.cl/${ID}#caso.${TOKEN}`;
  const workdir = mkdtempSync(join(process.cwd(), "test", ".round2-"));
  const home = join(workdir, "home");
  const elsewhere = join(workdir, "elsewhere");
  const script = join(process.cwd(), "scripts", "report-key.mjs");
  let server: Server;
  let origin: string;
  const requests: { url: string; token: string | undefined }[] = [];
  let served: Buffer = Buffer.alloc(0);
  let operatorKey = "";

  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(
        process.execPath,
        [script, ...args],
        { cwd: elsewhere, env: { ...process.env, HOME: home, USERPROFILE: home, FOLIO_ORIGIN: origin, ...env } },
        (error, out, err) => done({ code: Number(error?.code ?? 0), out: out.trim(), err }),
      );
    });

  const envelopeFor = (key: string): Buffer => {
    const head = toBase64Url(new Uint8Array(32).fill(5));
    const commitment = createHmac("sha256", Buffer.from(key, "base64url"))
      .update("tisty-envelope-commit")
      .update(Buffer.from(head, "base64url"))
      .digest()
      .toString("base64url");
    const manifest = Buffer.from(JSON.stringify({ head, commitment }));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(manifest.length);
    return Buffer.concat([Buffer.from("TENV"), size, manifest]);
  };

  beforeAll(async () => {
    mkdirSync(home, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    server = createServer((request, response) => {
      requests.push({ url: request.url ?? "", token: request.headers["folio-case"] as string | undefined });
      response.writeHead(200);
      response.end(served);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const made = await run(["new", "~/made.key"]);
    operatorKey = made.out;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(workdir, { recursive: true, force: true });
  });

  describe("where it looks for its file", () => {
    it("makes it in the home folder when told ~/", async () => {
      const result = await run(["new", "~/slash.key"]);
      expect(result.code).toBe(0);
      expect(existsSync(join(home, "slash.key"))).toBe(true);
      expect(existsSync(join(elsewhere, "~"))).toBe(false);
    });

    it("makes it in the home folder when told ~\\, as PowerShell hands it over", async () => {
      const result = await run(["new", "~\\back.key"]);
      expect(result.code).toBe(0);
      expect(existsSync(join(home, "back.key"))).toBe(true);
      expect(readdirSync(elsewhere)).toEqual([]);
    });

    it("makes it in a folder of the home folder", async () => {
      mkdirSync(join(home, "keys"));
      expect((await run(["new", "~/keys/deep.key"])).code).toBe(0);
      expect(existsSync(join(home, "keys", "deep.key"))).toBe(true);
      expect((await run(["new", "~\\keys\\deep2.key"])).code).toBe(0);
      expect(existsSync(join(home, "keys", "deep2.key"))).toBe(true);
    });

    it("does not touch a name that merely starts with a tilde", async () => {
      const result = await run(["new", "~other.key"]);
      expect(result.code).toBe(0);
      expect(existsSync(join(elsewhere, "~other.key"))).toBe(true);
      expect(existsSync(join(home, "other.key"))).toBe(false);
      expect(existsSync(join(home, "~other.key"))).toBe(false);
    });

    it("does not touch a lone tilde", async () => {
      const result = await run(["new", "~"]);
      expect(result.code).toBe(0);
      expect(existsSync(join(elsewhere, "~"))).toBe(true);
    });

    it("never overwrites a key that exists, whichever way it is named", async () => {
      await run(["new", "~/once.key"]);
      const before = readFileSync(join(home, "once.key"), "utf8");
      const again = await run(["new", "~\\once.key"]);
      expect(again.code).not.toBe(0);
      expect(readFileSync(join(home, "once.key"), "utf8")).toBe(before);
      expect(again.out + again.err).not.toContain(before.trim());
    });

    it("opens with the key it finds either way, and reads the same seal", async () => {
      const sealed = await sealLink(ID, KEY, (await run(["new", "~/same.key"])).out);
      const bySlash = await run(["open", "~/same.key", ID, sealed]);
      const byBack = await run(["open", "~\\same.key", ID, sealed]);
      expect(bySlash.code).toBe(0);
      expect(bySlash.out).toBe(`${origin}/${ID}#${KEY}`);
      expect(byBack).toEqual(bySlash);
    });

    it("says nothing of a key's text when the file is not there", async () => {
      const result = await run(["open", "~/missing.key", ID, `sealed1.${"A".repeat(150)}`]);
      expect(result.code).not.toBe(0);
      expect(result.out).toBe("");
    });
  });

  describe("what it prints of a seal that is not the document's own link", () => {
    const opening = async (said: string, id = ID) =>
      run(["open", "~/made.key", id, await sealContact(id, said, operatorKey)]);

    it("prints a link of its own document, ready to click, and nothing more", async () => {
      const result = await run(["open", "~/made.key", ID, await sealLink(ID, KEY, operatorKey)]);
      expect(result.out).toBe(`${origin}/${ID}#${KEY}`);
      expect(result.err).toContain("to open in a browser");
    });

    it("does not print as a link the own link of another document", async () => {
      const result = await opening(`Zz9Zz9Zz#${KEY}`);
      expect(result.out).toMatch(/^Not checked, written by whoever reported: /);
      expect(result.out).not.toContain(`${origin}/`);
    });

    it("prints a reporter's words on one line, with no address that a terminal would offer", async () => {
      const result = await opening("mira https://evil.example/pay y http://x.test/\nsegunda linea");
      expect(result.out.split("\n")).toHaveLength(1);
      expect(result.out).not.toMatch(/https?:\/\//);
      expect(result.out).toContain("\\u{a}");
    });

    it("escapes the controls that rewrite a terminal", async () => {
      const result = await opening("\u001b[2J\u001b]0;title\u0007 \u202e \u0000 \u200b \u2028");
      expect([...result.out].filter((one) => /\p{C}|\u2028/u.test(one))).toEqual([]);
    });

    it("breaks every address of the scheme, not only the first", async () => {
      const result = await opening("a://b a://b a://b ftp://c file:///etc/passwd");
      expect(result.out).not.toContain("://");
    });
  });

  describe("checking a key against a case link", () => {
    const check = async (said: string, caseLink: string, envelope = envelopeFor(KEY)) => {
      served = envelope;
      requests.length = 0;
      const sealed = await sealContact(ID, said, operatorKey);
      return run(["check", "~/made.key", ID, sealed, caseLink]);
    };

    it("takes the key from a link with its #, and asks with the case's token alone", async () => {
      const result = await check(`${ID}#${KEY}`, CASE);
      expect(result.out).toContain("The key opens this document");
      expect(requests).toEqual([{ url: `/api/v1/cases/${ID}`, token: TOKEN }]);
    });

    it("takes the key when the seal carries more than the link", async () => {
      const result = await check(`mira esto: https://tisty.cl/${ID}#${KEY} y lo otro`, CASE);
      expect(result.out).toContain("The key opens this document");
    });

    it("takes the key of the link that has it when the seal carries a case link first", async () => {
      const result = await check(`https://tisty.cl/${ID}#caso.${"Q".repeat(43)} y ${ID}#${KEY}`, CASE);
      expect(result.out).toContain("The key opens this document");
    });

    it("does not take a case token for a key", async () => {
      const result = await check(`https://tisty.cl/${ID}#caso.${"Q".repeat(43)}`, CASE);
      expect(result.code).toBe(3);
      expect(result.out).toContain("no key to this document");
      expect(requests).toEqual([]);
    });

    it("says the key is not the document's, without saying what the key was", async () => {
      const result = await check(`${ID}#${"x".repeat(43)}`, CASE);
      expect(result.code).toBe(3);
      expect(result.out).toContain("does not open it");
      expect(result.out + result.err).not.toContain("x".repeat(43));
    });

    it("sends nothing to the server when the link it is given is not a case link, and never the document's key", async () => {
      const result = await check(`${ID}#${KEY}`, `https://tisty.cl/${ID}#${KEY}`);
      expect(result.code).toBe(1);
      expect(result.err).toContain("not a case link");
      expect(requests).toEqual([]);
      expect(result.out + result.err).not.toContain(KEY);
    });

    it.each([
      ["a token one short", `https://tisty.cl/${ID}#caso.${"T".repeat(42)}`],
      ["no token", `https://tisty.cl/${ID}#caso.`],
      ["the word and no dot", `https://tisty.cl/${ID}#caso${"T".repeat(43)}`],
      ["a query in place of a fragment", `https://tisty.cl/${ID}?caso.${TOKEN}`],
    ])("refuses a case link with %s, and asks the server nothing", async (_what, link) => {
      const result = await check(`${ID}#${KEY}`, link);
      expect(result.code).toBe(1);
      expect(requests).toEqual([]);
    });

    it("uses only the first 43 characters of a token that goes on", async () => {
      const result = await check(`${ID}#${KEY}`, `${CASE}${"Z".repeat(10)}`);
      expect(requests[0]?.token).toBe(TOKEN);
      expect(result.code).toBe(0);
    });

    it("asks about the document of the seal, whatever the case link's address says", async () => {
      await check(`${ID}#${KEY}`, `https://elsewhere.example/Zz9Zz9Zz#caso.${TOKEN}`);
      expect(requests).toEqual([{ url: `/api/v1/cases/${ID}`, token: TOKEN }]);
    });

    it("sends the request to the origin it was told, never to the host of the link it was handed", async () => {
      await check(`${ID}#${KEY}`, `https://evil.example/${ID}#caso.${TOKEN}`);
      expect(requests).toHaveLength(1);
    });
  });
});
