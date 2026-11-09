import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createKeys,
  holdsSignature,
  type LimitsFiles,
  newKeys,
  pastTheServer,
  signedFile,
  signLimits,
} from "../scripts/limits-key";
import { sharingFaults } from "../scripts/limits-sharing";
import { LEVEL_ONE, publishedLimits } from "../src/core/limits";

// The same key as KEY in Tisty's crates/tisty-carrier/src/folio_limits.rs: a key swapped in docs/limits.pub must not pass.
const TISTY_LIMITS_KEY = "RWTBkOCJN2ITUeWMK6V3gXmiJGo2hT6mX+hgcjpQ9F6QBO9sWnO84Mak";

const said = Buffer.from('{"serial":1}\n');
const NOW = Date.UTC(2026, 10, 6);
const NOW_SECONDS = NOW / 1000;
const SERVER = publishedLimits(LEVEL_ONE);
const DAY_SECONDS = 86_400;

const sha256 = (said: string | Buffer): string => createHash("sha256").update(said).digest("hex");

describe("a signature of the limits", () => {
  const { secret, publicKey } = newKeys();
  const signature = signedFile(said, "limits.json", secret, NOW);

  it("holds for what it signed, under its key and its name", () => {
    expect(holdsSignature(said, signature, publicKey, "limits.json")).toBe(true);
  });

  it("does not hold for other bytes", () => {
    expect(holdsSignature(Buffer.from('{"serial":2}\n'), signature, publicKey)).toBe(false);
  });

  it("does not hold under another key", () => {
    expect(holdsSignature(said, signature, newKeys().publicKey)).toBe(false);
  });

  it("does not stand in for a file of another name", () => {
    expect(holdsSignature(said, signature, publicKey, "cloud.json")).toBe(false);
  });

  it("does not hold if its signed comment was changed", () => {
    const changed = signature.replace("file:limits.json", "file:limits.json extra");
    expect(holdsSignature(said, changed, publicKey)).toBe(false);
  });

  it("does not take what is not a signature, or not a key", () => {
    expect(holdsSignature(said, "not a signature", publicKey)).toBe(false);
    expect(holdsSignature(said, signature, "not a key")).toBe(false);
  });
});

describe("what the file may say", () => {
  it("may ask for less than the server takes", () => {
    expect(pastTheServer({ ...SERVER, files_bytes_at_most: 1 }, SERVER)).toEqual([]);
    expect(pastTheServer({ ...SERVER, ttl_days: [1] }, SERVER)).toEqual([]);
  });

  it("names the maker without counting it as a limit", () => {
    expect(pastTheServer({ ...SERVER, maker: { root: "A".repeat(43), name: "rgdevment" } }, SERVER)).toEqual([]);
  });

  it("names a field it does not know", () => {
    expect(pastTheServer({ ...SERVER, made_up: 1 }, SERVER)).toEqual(["made_up"]);
  });

  it("may not ask for more than the server takes", () => {
    const more = { ...SERVER, files_bytes_at_most: SERVER.files_bytes_at_most + 1 };
    expect(pastTheServer(more, SERVER)).toEqual(["files_bytes_at_most"]);
    expect(pastTheServer({ ...SERVER, ttl_days: [30] }, SERVER)).toEqual(["ttl_days"]);
    const faster = { ...SERVER, upload_waits_minutes: SERVER.upload_waits_minutes.map(() => 0) };
    expect(pastTheServer(faster, SERVER)).toEqual(["upload_waits_minutes"]);
  });

  it("has to say the oldest contracts the server holds to", () => {
    const floor = { ...SERVER, oldest_contract_taken: "2.0.0" };
    expect(pastTheServer(floor, SERVER)).toEqual(["oldest_contract_taken"]);
  });

  it("says nothing the server does not know, and leaves out nothing it does", () => {
    expect(pastTheServer({ ...SERVER, other: 1 }, SERVER)).toEqual(["other"]);
    const { files_at_most: _left, ...without } = SERVER;
    expect(pastTheServer(without, SERVER)).toEqual(["files_at_most"]);
  });
});

describe("the sharing fields", () => {
  const closedWith = (es: unknown) => sharingFaults({ sharing_open: false, sharing_closed_note: { es } });

  it("take a service that is open or closed, with no message", () => {
    expect(sharingFaults({ sharing_open: true })).toEqual([]);
    expect(sharingFaults({ sharing_open: false })).toEqual([]);
  });

  it.each([[undefined], ["true"], [1], [null]])("refuse %j as whether it is open", (open) => {
    expect(sharingFaults({ sharing_open: open })).toEqual(["sharing_open is not true or false"]);
  });

  it("take the message Tisty gives as its example, in one language or both", () => {
    const es = "Abrimos el lunes.\nMira los detalles [aquí](https://folio.tisty.app/lanzamiento).";
    const en = "We open on Monday.\nSee the details [here](https://folio.tisty.app/launch).";
    expect(sharingFaults({ sharing_open: false, sharing_closed_note: { es, en } })).toEqual([]);
    expect(closedWith(es)).toEqual([]);
  });

  it("take exactly what fits, and refuse past it", () => {
    expect(closedWith("a".repeat(400))).toEqual([]);
    expect(closedWith("a".repeat(401))[0]).toContain("401 characters");
    expect(closedWith("a\n\nb\nc\nd\ne")).toEqual([]);
    expect(closedWith("a\n\nb\nc\nd\ne\nf")[0]).toContain("over 6 lines");
  });

  it("count the syntax of a link among the characters", () => {
    const link = "[a](https://tisty.app/)";
    expect(closedWith(link + "b".repeat(400 - link.length))).toEqual([]);
    expect(closedWith(link + "b".repeat(401 - link.length))[0]).toContain("401 characters");
  });

  it.each([
    ["tisty.app", "https://tisty.app"],
    ["its subdomains", "https://folio.tisty.app/a?b=c#d"],
    ["tisty.cl", "https://tisty.cl/a"],
  ])("take a link to %s", (_where, address) => {
    expect(closedWith(`[a](${address})`)).toEqual([]);
  });

  it.each([
    ["plain http", "http://tisty.app"],
    ["another site", "https://example.com"],
    ["a name that only ends alike", "https://nottisty.app"],
    ["a name that only starts alike", "https://tisty.app.example.com"],
    ["a subdomain of tisty.cl", "https://a.tisty.cl"],
    ["a port", "https://tisty.app:443/"],
    ["a user", "https://user@tisty.app/"],
    ["a user hidden by a backslash", "https://tisty.app\\@example.com"],
    ["no address", ""],
    ["a scheme in capitals", "HTTPS://tisty.app"],
    ["a name in capitals", "https://TISTY.app/"],
    ["parentheses in its address", "https://tisty.app/a(b)c"],
  ])("refuse a link with %s", (_what, address) => {
    expect(closedWith(`[a](${address})`)[0]).toContain("links where Tisty would not");
  });

  it("refuse a link with no text, and one that is not whole", () => {
    expect(closedWith("[ ](https://tisty.app)")[0]).toContain("no text");
    expect(closedWith("[a](https://tisty.app")[0]).toContain("not whole");
  });

  it.each([
    ["bold", "**a**"],
    ["italics", "*a*"],
    ["italics with underscores", "_a_"],
    ["strikethrough", "~~a~~"],
    ["code", "`a`"],
    ["a quote", "> a"],
    ["a title", "# a"],
    ["a list", "a\n- b"],
    ["a numbered list", "1. a"],
    ["a picture", "![a](https://tisty.app)"],
    ["HTML", "<b>a</b>"],
    ["bold inside a link", "[**a**](https://tisty.app)"],
  ])("refuse %s, which Tisty would show literally", (_what, es) => {
    expect(closedWith(es)).toContain("sharing_closed_note es has formatting Tisty would show literally");
  });

  it("leave alone a link whose address looks like formatting", () => {
    expect(closedWith("[a](https://tisty.app/a__b)")).toEqual([]);
  });

  it("leave alone what only looks a little like formatting", () => {
    expect(closedWith("3 * 4 = 12, a_b y 5 > 4")).toEqual([]);
  });

  it.each([
    ["a tab", "a\tb"],
    ["a carriage return", "a\r\nb"],
    ["a control character", "a\u0007b"],
    ["a space of no width", "a\u200bb"],
    ["a joiner", "a\u2060b"],
    ["a text reversal", "a\u202eb"],
    ["a line separator", "a\u2028b"],
    ["a blank Hangul letter", "a\u3164b"],
  ])("refuse %s", (_what, es) => {
    expect(closedWith(es)[0]).toContain("invisible");
  });

  it("refuse the line Tisty adds below", () => {
    expect(closedWith("Conoce más en folio.tisty.app.")[0]).toContain("repeats");
  });

  it("refuse a message that says nothing, or is not one", () => {
    expect(closedWith("  ")[0]).toContain("is empty");
    expect(closedWith(1)[0]).toContain("not text");
    expect(sharingFaults({ sharing_open: false, sharing_closed_note: {} })[0]).toContain("says nothing");
    expect(sharingFaults({ sharing_open: false, sharing_closed_note: "a" })[0]).toContain("not an object");
    expect(sharingFaults({ sharing_open: false, sharing_closed_note: { pt: "a" } })[0]).toContain("pt");
  });
});

describe("signing the limits", () => {
  let place: string;
  let files: LimitsFiles;
  let keyFile: string;

  const read = () => JSON.parse(readFileSync(files.limits, "utf8")) as Record<string, unknown>;
  const signing = (days?: string, now = NOW, server = SERVER) => signLimits(keyFile, days, now, server, files);

  beforeEach(() => {
    place = mkdtempSync(join(tmpdir(), "limits-"));
    files = {
      limits: join(place, "limits.json"),
      publicKey: join(place, "limits.pub"),
      termsEs: join(place, "TERMINOS.md"),
      termsEn: join(place, "TERMS.md"),
    };
    writeFileSync(files.termsEs, "términos\n");
    writeFileSync(files.termsEn, "terms\n");
    keyFile = join(place, "the.key");
    createKeys(keyFile, files);
  });

  afterEach(() => {
    rmSync(place, { recursive: true, force: true });
  });

  it("refuses to open sharing while the Worker it names keeps it off", () => {
    const worker = join(place, "wrangler.toml");
    writeFileSync(worker, 'SHARING_OPEN = "false"\n');
    writeFileSync(files.limits, `${JSON.stringify({ serial: 1, sharing_open: true })}\n`);
    const opening = () => signLimits(keyFile, undefined, NOW, SERVER, { ...files, worker });
    expect(opening).toThrow("open and deploy the Worker first");
    writeFileSync(worker, 'SHARING_OPEN = "true"\n');
    expect(opening).not.toThrow();
  });

  it("writes what its public key answers for, and each signing grows the serial", () => {
    signing();
    signing();
    expect(read().serial).toBe(2);
    expect(
      holdsSignature(
        readFileSync(files.limits),
        readFileSync(`${files.limits}.minisig`, "utf8"),
        readFileSync(files.publicKey, "utf8"),
        "limits.json",
      ),
    ).toBe(true);
  });

  it("keeps the maker it was given, and refuses one that is not a maker", () => {
    signing();
    const maker = { root: "A".repeat(43), name: "rgdevment", domain: "rgdevment.dev" };
    writeFileSync(files.limits, JSON.stringify({ ...read(), maker }));
    signing();
    expect(read().maker).toEqual(maker);
    writeFileSync(files.limits, JSON.stringify({ ...read(), maker: { root: "not a root" } }));
    expect(() => signing()).toThrow("maker.root is not a root");
  });

  it("names the terms by the hash of their exact bytes", () => {
    signing();
    expect(read().terms).toEqual({ version: "1", es: sha256("términos\n"), en: sha256("terms\n") });
  });

  it("keeps the version of the terms while neither text changes", () => {
    signing();
    signing();
    expect((read().terms as { version: string }).version).toBe("1");
  });

  it.each([
    ["Spanish", "termsEs"],
    ["English", "termsEn"],
  ] as const)("raises the version of the terms when the %s text changes", (_language, text) => {
    signing();
    writeFileSync(files[text], "otro texto\r\n");
    signing();
    const terms = read().terms as { version: string; es: string; en: string };
    expect(terms.version).toBe("2");
    expect(terms[text === "termsEs" ? "es" : "en"]).toBe(sha256("otro texto\r\n"));
  });

  it("starts closed, with no message", () => {
    signing();
    expect(read().sharing_open).toBe(false);
    expect(read()).not.toHaveProperty("sharing_closed_note");
  });

  it("keeps whether it is open and its message", () => {
    signing();
    const note = { es: "Abrimos el lunes." };
    writeFileSync(files.limits, JSON.stringify({ ...read(), sharing_open: true, sharing_closed_note: note }));
    signing();
    expect(read().sharing_open).toBe(true);
    expect(read().sharing_closed_note).toEqual(note);
  });

  it("writes nothing with a message Tisty would drop", () => {
    signing();
    writeFileSync(files.limits, JSON.stringify({ ...read(), sharing_closed_note: { es: "**a**" } }));
    const before = readFileSync(files.limits, "utf8");
    const signature = readFileSync(`${files.limits}.minisig`, "utf8");
    expect(() => signing()).toThrow("formatting");
    expect(readFileSync(files.limits, "utf8")).toBe(before);
    expect(readFileSync(`${files.limits}.minisig`, "utf8")).toBe(signature);
  });

  it("does not replace the key copies are built with", () => {
    const before = readFileSync(files.publicKey, "utf8");
    expect(() => createKeys(join(place, "other.key"), files)).toThrow("built with");
    expect(readFileSync(files.publicKey, "utf8")).toBe(before);
    expect(existsSync(join(place, "other.key"))).toBe(false);
  });

  it("keeps a pause in force unless told otherwise", () => {
    signing("7");
    const until = NOW_SECONDS + 7 * DAY_SECONDS;
    expect(read().uploads_halted_until).toBe(until);
    signing();
    expect(read().uploads_halted_until).toBe(until);
    signing("0");
    expect(read().uploads_halted_until).toBeUndefined();
  });

  it("lets a pause that ended go", () => {
    signing("1");
    signing(undefined, NOW + 2 * DAY_SECONDS * 1000);
    expect(read().uploads_halted_until).toBeUndefined();
  });

  it("refuses a pause past a week", () => {
    expect(() => signing("8")).toThrow("whole days");
    expect(() => signing("half")).toThrow("whole days");
  });

  it("keeps a number lowered by hand, and adds what the server newly says", () => {
    signing();
    const { files_at_most: _new, ...older } = read();
    writeFileSync(files.limits, JSON.stringify({ ...older, files_bytes_at_most: 1000 }));
    signing();
    expect(read().files_bytes_at_most).toBe(1000);
    expect(read().files_at_most).toBe(SERVER.files_at_most);
  });

  it("writes nothing when a number is past what the server takes", () => {
    signing();
    const before = readFileSync(files.limits, "utf8");
    const lower = { ...SERVER, files_bytes_at_most: 1 };
    expect(() => signing(undefined, NOW, lower)).toThrow("files_bytes_at_most");
    expect(readFileSync(files.limits, "utf8")).toBe(before);
  });

  it("writes nothing with a key that is not the one published", () => {
    signing();
    const before = readFileSync(files.limits, "utf8");
    writeFileSync(keyFile, `${newKeys().secret}\n`);
    expect(() => signing()).toThrow("not the key");
    expect(readFileSync(files.limits, "utf8")).toBe(before);
  });
});

describe("the command", () => {
  it("runs under this Node as the instructions say, and says how when asked nothing", () => {
    const run = spawnSync(process.execPath, ["scripts/limits-key.ts"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("sign <file>");
  });
});

describe("the notice left where Tisty 1.43.0 and older read", () => {
  const file = readFileSync("docs/limits.json");
  const notice = JSON.parse(file.toString()) as Record<string, unknown>;
  const branch = JSON.parse(readFileSync(".limits/limits.json", "utf8")) as { serial: number };

  it("closes sharing and asks for 1.43.1, in a way they take", () => {
    expect(notice.sharing_open).toBe(false);
    expect(JSON.stringify(notice.sharing_closed_note)).toContain("1.43.1");
    expect(sharingFaults(notice)).toEqual([]);
  });

  it("is signed with the key Tisty is built with", () => {
    expect(
      holdsSignature(file, readFileSync("docs/limits.json.minisig", "utf8"), TISTY_LIMITS_KEY, "limits.json"),
    ).toBe(true);
  });

  it("stays under the branch's serial, so a Tisty that saw it still takes the branch after updating", () => {
    expect(notice.serial as number).toBeLessThan(branch.serial);
  });
});

describe("the limits Folio publishes", () => {
  const file = readFileSync(".limits/limits.json");
  const published = JSON.parse(file.toString()) as Record<string, unknown>;

  it("ask for nothing the server would refuse", () => {
    expect(pastTheServer(published, SERVER)).toEqual([]);
    expect(published.serial).toBeGreaterThan(0);
  });

  it("say whether sharing is open, in a way Tisty takes", () => {
    expect(sharingFaults(published)).toEqual([]);
  });

  it("are signed with the key Tisty is built with", () => {
    const signature = readFileSync(".limits/limits.json.minisig", "utf8");
    expect(readFileSync("docs/limits.pub", "utf8").trim()).toBe(TISTY_LIMITS_KEY);
    expect(holdsSignature(file, signature, TISTY_LIMITS_KEY, "limits.json")).toBe(true);
  });

  it("name the terms exactly as they are published", () => {
    const terms = published.terms as { version: string; es: string; en: string };
    expect(terms.es).toBe(sha256(readFileSync("docs/TERMINOS.md")));
    expect(terms.en).toBe(sha256(readFileSync("docs/TERMS.md")));
    expect(terms.version).toMatch(/^[1-9][0-9]*$/);
  });

  it("say on their first lines the version they name", () => {
    const { version } = published.terms as { version: string };
    expect(readFileSync("docs/TERMINOS.md", "utf8")).toContain(`**Versión ${version}, vigente desde`);
    expect(readFileSync("docs/TERMS.md", "utf8")).toContain(`**Version ${version}, in force since`);
  });

  it("fit in what a reader of a signed file takes", () => {
    expect(file.length).toBeLessThanOrEqual(16 * 1024);
  });
});
