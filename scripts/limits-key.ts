import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEVEL_ONE, publishedLimits } from "../src/core/limits.ts";

type Published = ReturnType<typeof publishedLimits>;

export interface LimitsFiles {
  limits: string;
  publicKey: string;
}

const inDocs = (name: string): string => resolve(fileURLToPath(new URL(`../docs/${name}`, import.meta.url)));
const PUBLISHED: LimitsFiles = { limits: inDocs("limits.json"), publicKey: inDocs("limits.pub") };
const USAGE = "node scripts/limits-key.ts new <file> | sign <file> [days uploads halt, 0 to lift a pause]";
const SECONDS_IN_A_DAY = 86_400;
const HALTED_DAYS_AT_MOST = 7;
const KEY_ID_BYTES = 8;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const ALGORITHM_BYTES = 2;
const ID_ENDS_AT = ALGORITHM_BYTES + KEY_ID_BYTES;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const verifierOf = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });

const rawOf = (key: KeyObject): Buffer => Buffer.from(key.export({ format: "der", type: "spki" }).subarray(-KEY_BYTES));

const keyIdOf = (raw: Buffer): Buffer => createHash("sha256").update(raw).digest().subarray(0, KEY_ID_BYTES);

const blake2b = (said: Buffer): Buffer => createHash("blake2b512").update(said).digest();

const minisignKey = (raw: Buffer): string => Buffer.concat([Buffer.from("Ed"), keyIdOf(raw), raw]).toString("base64");

export const newKeys = (): { secret: string; publicKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    secret: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: minisignKey(rawOf(publicKey)),
  };
};

export const signedFile = (said: Buffer, name: string, secret: string, now: number): string => {
  const key = createPrivateKey({ key: Buffer.from(secret, "base64url"), format: "der", type: "pkcs8" });
  const signature = sign(null, blake2b(said), key);
  const trusted = `timestamp:${Math.floor(now / 1000)}\tfile:${name}\thashed`;
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), key);
  return [
    "untrusted comment: signature from the key of Folio's limits",
    Buffer.concat([Buffer.from("ED"), keyIdOf(rawOf(createPublicKey(key))), signature]).toString("base64"),
    `trusted comment: ${trusted}`,
    global.toString("base64"),
    "",
  ].join("\n");
};

export const holdsSignature = (said: Buffer, signatureFile: string, publicKey: string, name?: string): boolean => {
  const [, signed, trustedLine, global] = signatureFile.split(/\r?\n/);
  const key = Buffer.from(publicKey.trim(), "base64");
  const signature = Buffer.from(signed ?? "", "base64");
  const trustedPrefix = "trusted comment: ";
  if (!trustedLine?.startsWith(trustedPrefix) || !global) return false;
  if (key.length !== ID_ENDS_AT + KEY_BYTES || signature.length !== ID_ENDS_AT + SIGNATURE_BYTES) return false;
  if (signature.subarray(0, ALGORITHM_BYTES).toString() !== "ED") return false;
  if (!key.subarray(ALGORITHM_BYTES, ID_ENDS_AT).equals(signature.subarray(ALGORITHM_BYTES, ID_ENDS_AT))) return false;
  const trusted = trustedLine.slice(trustedPrefix.length);
  if (name !== undefined && !trusted.split(/\s+/).includes(`file:${name}`)) return false;
  const verifier = verifierOf(key.subarray(ID_ENDS_AT));
  const bare = signature.subarray(ID_ENDS_AT);
  return (
    verify(null, blake2b(said), verifier, bare) &&
    verify(null, Buffer.concat([bare, Buffer.from(trusted)]), verifier, Buffer.from(global, "base64"))
  );
};

const holdsTo = (name: string, said: unknown, server: unknown): boolean => {
  if (name === "ttl_days") {
    const days = server as number[];
    return Array.isArray(said) && said.length > 0 && said.every((one) => days.includes(one));
  }
  if (name === "upload_waits_minutes") {
    const waits = server as number[];
    return Array.isArray(said) && said.length === waits.length && said.every((one, at) => one >= (waits[at] ?? 0));
  }
  if (typeof server === "number") return typeof said === "number" && said >= 0 && said <= server;
  return said === server;
};

// The file may ask for less than the server takes, never for more: a number there that it would refuse fails its reader.
export const pastTheServer = (said: Record<string, unknown>, server: Published): string[] => {
  const held = server as Record<string, unknown>;
  const { serial: _serial, uploads_halted_until: _halted, ...numbers } = said;
  const unknown = Object.keys(numbers).filter((name) => !Object.hasOwn(held, name));
  const wrong = Object.keys(held).filter((name) => !holdsTo(name, said[name], held[name]));
  return [...unknown, ...wrong];
};

const haltedUntil = (haltedDays: string | undefined, kept: unknown, nowSeconds: number): number | null => {
  if (haltedDays === undefined) return typeof kept === "number" && kept > nowSeconds ? kept : null;
  const days = Number(haltedDays);
  if (!Number.isInteger(days) || days < 0 || days > HALTED_DAYS_AT_MOST) {
    throw new Error(`uploads halt for 0 to ${HALTED_DAYS_AT_MOST} whole days`);
  }
  return days === 0 ? null : nowSeconds + days * SECONDS_IN_A_DAY;
};

export const createKeys = (keyFile: string, files: LimitsFiles = PUBLISHED): string => {
  if (existsSync(files.publicKey)) {
    throw new Error(
      `${files.publicKey} is the key Tisty is built with. Every copy built with it would stop hearing the limits, so remove it by hand if that is what you want.`,
    );
  }
  const { secret, publicKey } = newKeys();
  writeFileSync(keyFile, `${secret}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(files.publicKey, `${publicKey}\n`);
  return publicKey;
};

export const signLimits = (
  keyFile: string,
  haltedDays: string | undefined,
  now: number,
  server: Published = publishedLimits(LEVEL_ONE),
  files: LimitsFiles = PUBLISHED,
): void => {
  const current = existsSync(files.limits)
    ? (JSON.parse(readFileSync(files.limits, "utf8")) as Record<string, unknown>)
    : {};
  const { serial = 0, uploads_halted_until: kept, ...numbers } = current;
  const until = haltedUntil(haltedDays, kept, Math.floor(now / 1000));
  const next = {
    serial: (serial as number) + 1,
    ...server,
    ...numbers,
    ...(until === null ? {} : { uploads_halted_until: until }),
  };
  const past = pastTheServer(next, server);
  if (past.length > 0) throw new Error(`the server would not hold to these: ${past.join(", ")}`);

  const said = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  const name = basename(files.limits);
  const signature = signedFile(said, name, readFileSync(keyFile, "utf8").trim(), now);
  if (!holdsSignature(said, signature, readFileSync(files.publicKey, "utf8"), name)) {
    throw new Error(`this is not the key of ${files.publicKey}, so nothing was written`);
  }
  writeFileSync(files.limits, said);
  writeFileSync(`${files.limits}.minisig`, signature);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [what, keyFile, haltedDays] = process.argv.slice(2);
  if (what === "new" && keyFile) {
    console.log(createKeys(keyFile));
  } else if (what === "sign" && keyFile) {
    signLimits(keyFile, haltedDays, Date.now());
    console.log(`signed ${PUBLISHED.limits}`);
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}
