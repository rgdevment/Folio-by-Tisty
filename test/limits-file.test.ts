import { spawnSync } from "node:child_process";
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
import { LEVEL_ONE, publishedLimits } from "../src/core/limits";

const said = Buffer.from('{"serial":1}\n');
const NOW = Date.UTC(2026, 10, 6);
const NOW_SECONDS = NOW / 1000;
const SERVER = publishedLimits(LEVEL_ONE);
const DAY_SECONDS = 86_400;

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

describe("signing the limits", () => {
  let place: string;
  let files: LimitsFiles;
  let keyFile: string;

  const read = () => JSON.parse(readFileSync(files.limits, "utf8")) as Record<string, unknown>;
  const signing = (days?: string, now = NOW, server = SERVER) => signLimits(keyFile, days, now, server, files);

  beforeEach(() => {
    place = mkdtempSync(join(tmpdir(), "limits-"));
    files = { limits: join(place, "limits.json"), publicKey: join(place, "limits.pub") };
    keyFile = join(place, "the.key");
    createKeys(keyFile, files);
  });

  afterEach(() => {
    rmSync(place, { recursive: true, force: true });
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

describe("the limits Folio publishes", () => {
  const file = readFileSync("docs/limits.json");
  const published = JSON.parse(file.toString()) as Record<string, unknown>;

  it("ask for nothing the server would refuse", () => {
    expect(pastTheServer(published, SERVER)).toEqual([]);
    expect(published.serial).toBeGreaterThan(0);
  });

  it("are signed with the key Tisty is built with", () => {
    const signature = readFileSync("docs/limits.json.minisig", "utf8");
    const publicKey = readFileSync("docs/limits.pub", "utf8");
    expect(holdsSignature(file, signature, publicKey, "limits.json")).toBe(true);
  });

  it("fit in what a reader of a signed file takes", () => {
    expect(file.length).toBeLessThanOrEqual(16 * 1024);
  });
});
