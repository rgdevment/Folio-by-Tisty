import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { holdsSignature } from "./limits-key.ts";

const LIMITS_AT = "https://raw.githubusercontent.com/rgdevment/Folio-by-Tisty/limits";
const TERMS_AT = "https://raw.githubusercontent.com/rgdevment/Folio-by-Tisty/main/docs";
const TRIES = 15;
const BETWEEN_TRIES_MS = 60_000;

export interface Published {
  limits: Buffer;
  signature: string;
  es: Buffer;
  en: Buffer;
}

const sha256 = (said: Buffer): string => createHash("sha256").update(said).digest("hex");

const parsed = (said: Buffer): { serial?: unknown; terms?: { es?: unknown; en?: unknown } } | null => {
  try {
    return JSON.parse(said.toString());
  } catch {
    return null;
  }
};

export const publishedFaults = (published: Published, publicKey: string, serialHere: number): string[] => {
  const said = parsed(published.limits);
  if (said === null) return ["limits.json is not JSON"];
  const serial = typeof said.serial === "number" ? said.serial : 0;
  return [
    ...(holdsSignature(published.limits, published.signature, publicKey, "limits.json")
      ? []
      : ["limits.json does not hold to its signature under docs/limits.pub"]),
    ...(serial >= serialHere ? [] : [`limits.json says serial ${serial}, and the limits branch has ${serialHere}`]),
    ...(said.terms?.es === sha256(published.es) ? [] : ["TERMINOS.md is not the text limits.json names"]),
    ...(said.terms?.en === sha256(published.en) ? [] : ["TERMS.md is not the text limits.json names"]),
  ];
};

const fetched = async (at: string, name: string): Promise<Buffer> => {
  const answer = await fetch(`${at}/${name}`, { redirect: "error" });
  if (!answer.ok) throw new Error(`${name} answered ${answer.status}`);
  return Buffer.from(await answer.arrayBuffer());
};

const publishedNow = async (): Promise<Published> => {
  const [limits, signature, es, en] = await Promise.all([
    fetched(LIMITS_AT, "limits.json"),
    fetched(LIMITS_AT, "limits.json.minisig"),
    fetched(TERMS_AT, "TERMINOS.md"),
    fetched(TERMS_AT, "TERMS.md"),
  ]);
  return { limits, signature: signature.toString(), es, en };
};

// A cache holds each file five minutes on its own, so a while of faults is expected; a quarter of an hour is not.
const watch = async (): Promise<void> => {
  const publicKey = readFileSync("docs/limits.pub", "utf8");
  const serialHere = (parsed(readFileSync(".limits/limits.json"))?.serial as number | undefined) ?? 0;
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    const faults = await publishedNow().then(
      (published) => publishedFaults(published, publicKey, serialHere),
      (error: unknown) => [String(error)],
    );
    if (faults.length === 0) {
      console.log(`ok what Tisty reads holds, at serial ${serialHere} or later`);
      return;
    }
    console.log(`try ${attempt} of ${TRIES}: ${faults.join("; ")}`);
    if (attempt < TRIES) await new Promise((done) => setTimeout(done, BETWEEN_TRIES_MS));
    else {
      for (const fault of faults) console.log(`::error::${fault}`);
      process.exitCode = 1;
    }
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await watch();
