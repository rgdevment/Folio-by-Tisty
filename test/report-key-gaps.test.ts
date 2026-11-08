import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealContact, sealLink } from "../src/page/ui/seal";

const ID = "k7Qm2xPa";
const KEY = "nlt35tFEpAhP5bWJr2p2hIFCFml15FNS5LD2AsBbd2s";
const CASE = `https://tisty.cl/${ID}#caso.${"T".repeat(43)}`;
const MANIFEST_AT_MOST = 16_384;
const folder = mkdtempSync(join(tmpdir(), "folio-report-gaps-"));
const keyFile = join(folder, "gaps.key");

const script = (...args: string[]) =>
  execFileSync(process.execPath, ["scripts/report-key.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();

const envelopeOf = (manifestBytes: number): Buffer => {
  const start = '{"head":"","commitment":"","pad":"';
  const manifest = Buffer.from(`${start}${"x".repeat(manifestBytes - start.length - 2)}"}`);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(manifest.length);
  return Buffer.concat([Buffer.from("TENV"), size, manifest]);
};

let server: Server;
let origin: string;
let served: Buffer = Buffer.alloc(0);
let operatorKey: string;

beforeAll(async () => {
  operatorKey = script("new", keyFile);
  server = createServer((_request, response) => {
    response.writeHead(200);
    response.end(served);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(folder, { recursive: true, force: true });
});

const checking = async (envelope: Buffer) => {
  served = envelope;
  const sealed = await sealLink(ID, KEY, operatorKey);
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      ["scripts/report-key.mjs", "check", keyFile, ID, sealed, CASE],
      { env: { ...process.env, FOLIO_ORIGIN: origin } },
      (error, out, err) => done({ code: Number(error?.code ?? 0), out: out.trim(), err }),
    );
  });
};

describe("the size of a manifest the script will read", () => {
  it("reads one of 16384 bytes and says the key is not its", async () => {
    const result = await checking(envelopeOf(MANIFEST_AT_MOST));
    expect(result.code).toBe(3);
    expect(result.out).toContain("does not open it");
  });

  it("refuses one of 16385 bytes as no envelope", async () => {
    const result = await checking(envelopeOf(MANIFEST_AT_MOST + 1));
    expect(result.code).toBe(1);
    expect(result.err).toContain("this is no envelope");
  });
});

describe("the key file", () => {
  it.skipIf(process.platform === "win32")("is readable by its owner alone", () => {
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it("is never printed, by any command that fails", async () => {
    const secret = (await import("node:fs")).readFileSync(keyFile, "utf8").trim();
    const sealed = await sealContact(ID, "a@b.co", operatorKey);
    for (const args of [
      ["open", keyFile, "another1", sealed],
      ["open", keyFile, ID, "sealed1.short"],
      ["check", keyFile, ID, sealed, CASE],
    ]) {
      let output = "";
      try {
        script(...args);
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string };
        output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
      }
      expect(output).not.toContain(secret);
    }
  });
});
