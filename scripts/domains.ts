import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN, PROOF, proofOf, SHARD_BYTES_AT_MOST, shardOf } from "../src/core/checked-domain.ts";
import { dnsLookup, type Lookup, retried, txtFaults } from "./dns.ts";
import { holdsSignature, signedFile } from "./limits-key.ts";

const ROOT = /^[A-Za-z0-9_-]{43}$/;
const SHARD_FILE = /^[0-9a-f]{2}\.json$/;
export const SHARDS = "docs/domains";
const PUBLIC_KEY = "docs/limits.pub";
const TRIES = 5;
const BETWEEN_TRIES_MS = 60_000;
const ASKED_AT_ONCE = 16;
const USAGE =
  "node scripts/domains.ts check <domain> <root> | build <private list> | sign <key file> | watch (reads DOMAINS_CLEAR)";

export interface Approved {
  domain: string;
  root: string;
}

export const approvedIn = (list: string): Approved[] =>
  list
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [domain = "", root = ""] = line.split(/\s+/);
      return { domain, root };
    });

export const listFaults = (approved: Approved[]): string[] => {
  const shapes = approved.flatMap(({ domain, root }, at) => [
    ...(DOMAIN.test(domain) ? [] : [`line ${at + 1}: not a lowercase ASCII domain`]),
    ...(ROOT.test(root) ? [] : [`line ${at + 1}: not a root`]),
  ]);
  const twice = (values: string[], what: string) =>
    values.filter((value, at) => values.indexOf(value) !== at).map((value) => `${value} has more than one ${what}`);
  return [
    ...shapes,
    ...twice(
      approved.map(({ domain }) => domain),
      "root",
    ),
    ...twice(
      approved.map(({ root }) => root),
      "domain",
    ),
  ];
};

// A few at a time, so the resolvers never see a flood and blame good records for their own limits.
const inTurns = async <T>(approved: Approved[], ask: (one: Approved, at: number) => Promise<T[]>): Promise<T[]> => {
  const answers: T[] = [];
  for (let start = 0; start < approved.length; start += ASKED_AT_ONCE) {
    const turn = approved.slice(start, start + ASKED_AT_ONCE);
    answers.push(...(await Promise.all(turn.map((one, at) => ask(one, start + at)))).flat());
  }
  return answers;
};

export const dnsFaults = (approved: Approved[], lookup: Lookup): Promise<string[]> =>
  inTurns(approved, ({ domain, root }) => txtFaults(domain, root, lookup));

// Lines of the private list, never its domains: the watch's output is public.
export const failingLines = (approved: Approved[], lookup: Lookup): Promise<string[]> =>
  inTurns(approved, async ({ domain, root }, at) =>
    (await txtFaults(domain, root, lookup)).length > 0 ? [`line ${at + 1}`] : [],
  );

export const shardsOf = async (approved: Approved[]): Promise<Map<string, string>> => {
  const proofs = (await Promise.all(approved.map(({ domain, root }) => proofOf(root, domain)))).sort();
  const shards = new Map<string, string[]>();
  for (const proof of proofs) shards.set(shardOf(proof), [...(shards.get(shardOf(proof)) ?? []), proof]);
  const written = new Map<string, string>();
  for (const [shard, held] of shards) {
    const said = `${JSON.stringify(held, null, 1)}\n`;
    if (Buffer.byteLength(said) > SHARD_BYTES_AT_MOST) throw new Error(`domains/${shard}.json passes 70 KB`);
    written.set(shard, said);
  }
  return written;
};

export const writeShards = (shards: Map<string, string>, dir = SHARDS): void => {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (!shards.has(name.slice(0, 2))) rmSync(join(dir, name));
  }
  for (const [shard, said] of shards) {
    const file = join(dir, `${shard}.json`);
    if (existsSync(file) && readFileSync(file, "utf8") === said) continue;
    writeFileSync(file, said);
    rmSync(`${file}.minisig`, { force: true });
  }
};

export const signShards = (keyFile: string, now: number, dir = SHARDS, publicKeyFile = PUBLIC_KEY): number => {
  const secret = readFileSync(keyFile, "utf8").trim();
  const publicKey = readFileSync(publicKeyFile, "utf8");
  const names = readdirSync(dir).filter((name) => SHARD_FILE.test(name));
  for (const name of names) {
    const said = readFileSync(join(dir, name));
    const signature = signedFile(said, `domains/${name}`, secret, now);
    if (!holdsSignature(said, signature, publicKey, `domains/${name}`)) {
      throw new Error(`this is not the key of ${publicKeyFile}, so nothing was written`);
    }
    writeFileSync(join(dir, `${name}.minisig`), signature);
  }
  return names.length;
};

export const shardFaults = (
  dir = SHARDS,
  publicKey = existsSync(PUBLIC_KEY) ? readFileSync(PUBLIC_KEY, "utf8") : "",
): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".minisig"))
    .flatMap((name) => {
      if (!SHARD_FILE.test(name)) return [`domains/${name} is not a shard`];
      const said = readFileSync(join(dir, name));
      const held: unknown = JSON.parse(said.toString());
      const proofs = Array.isArray(held) ? held : [];
      const signature = existsSync(join(dir, `${name}.minisig`))
        ? readFileSync(join(dir, `${name}.minisig`), "utf8")
        : "";
      return [
        ...(Array.isArray(held) && held.length > 0 ? [] : [`domains/${name} is not a list of proofs`]),
        ...(proofs.every((one) => typeof one === "string" && PROOF.test(one) && one.startsWith(name.slice(0, 2)))
          ? []
          : [`domains/${name} holds a proof that is not its own`]),
        ...(said.length <= SHARD_BYTES_AT_MOST ? [] : [`domains/${name} passes 70 KB`]),
        ...(holdsSignature(said, signature, publicKey, `domains/${name}`) ? [] : [`domains/${name} is not signed`]),
      ];
    });
};

const run = async ([what, first, second]: string[]): Promise<void> => {
  if (what === "check" && first && second) {
    const faults = await txtFaults(first, second, dnsLookup);
    console.log(faults.length === 0 ? `ok ${first} names that root` : faults.join("\n"));
    if (faults.length > 0) process.exitCode = 1;
  } else if (what === "build" && first) {
    const approved = approvedIn(readFileSync(first, "utf8"));
    const faults = [...listFaults(approved), ...(await dnsFaults(approved, dnsLookup))];
    if (faults.length > 0) throw new Error(`nothing was written:\n${faults.join("\n")}`);
    const shards = await shardsOf(approved);
    writeShards(shards);
    console.log(`wrote ${approved.length} domains in ${shards.size} shards: sign them next`);
  } else if (what === "sign" && first) {
    console.log(`signed ${signShards(first, Date.now())} shards`);
  } else if (what === "watch") {
    const approved = approvedIn(process.env.DOMAINS_CLEAR ?? "");
    const failing = await retried(() => failingLines(approved, dnsLookup), TRIES, BETWEEN_TRIES_MS);
    console.log(`${approved.length - failing.length} of ${approved.length} domains hold`);
    if (failing.length > 0) {
      console.log(`::error::${failing.length} do not hold, at ${failing.join(", ")} of the private list`);
      process.exitCode = 1;
    }
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv.slice(2));
