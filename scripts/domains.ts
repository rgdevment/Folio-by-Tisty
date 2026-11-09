import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN, PROOF, proofOf, SHARD_BYTES_AT_MOST, shardOf } from "../src/core/checked-domain.ts";
import { dnsLookup, type Lookup, retried, txtFaults } from "./dns.ts";
import { holdsSignature, signedFile } from "./limits-key.ts";

const ROOT = /^[A-Za-z0-9_-]{43}$/;
const SHARD_FILE = /^[0-9a-f]{2}\.json$/;
const SHARD_OR_SIGNATURE = /^[0-9a-f]{2}\.json(\.minisig)?$/;
const HOSTS = "hosts.json";
const PUBLIC_KEY = "docs/limits.pub";
const TRIES = 5;
const BETWEEN_TRIES_MS = 60_000;
const ASKED_AT_ONCE = 16;
const USAGE =
  "node scripts/domains.ts check <domain> <root> | build <private list> <domains branch> | hosts <private domain> <serial> <domains branch> | sign <key file> <domains branch> | verify <domains branch> | watch (reads DOMAINS_CLEAR)";

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

export interface Hosts {
  serial: number;
  private: string;
}

const hostsIn = (said: string): Hosts | null => {
  try {
    const held: unknown = JSON.parse(said);
    if (typeof held !== "object" || held === null || Array.isArray(held)) return null;
    const { serial, private: domain, ...rest } = held as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || !Number.isSafeInteger(serial) || (serial as number) < 0) return null;
    return typeof domain === "string" && DOMAIN.test(domain) ? { serial: serial as number, private: domain } : null;
  } catch {
    return null;
  }
};

// Tisty keeps the highest serial it has read, so a lower one would reach nobody who already has one.
export const writeHosts = (hosts: Hosts, dir: string): void => {
  const said = `${JSON.stringify({ serial: hosts.serial, private: hosts.private }, null, 1)}\n`;
  if (!hostsIn(said)) throw new Error("not a domain and a serial from 0 up, so nothing was written");
  const file = join(dir, HOSTS);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before === said) return;
  const kept = before === null ? null : hostsIn(before);
  if (kept && hosts.serial <= kept.serial)
    throw new Error(`the serial must pass ${kept.serial}, so nothing was written`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, said);
  rmSync(`${file}.minisig`, { force: true });
};

// Only shards and their signatures, since the folder is a checkout of the domains branch and holds its .git.
export const writeShards = (shards: Map<string, string>, dir: string): void => {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (SHARD_OR_SIGNATURE.test(name) && !shards.has(name.slice(0, 2))) rmSync(join(dir, name));
  }
  for (const [shard, said] of shards) {
    const file = join(dir, `${shard}.json`);
    if (existsSync(file) && readFileSync(file, "utf8") === said) continue;
    writeFileSync(file, said);
    rmSync(`${file}.minisig`, { force: true });
  }
};

export const signBranch = (keyFile: string, now: number, dir: string, publicKeyFile = PUBLIC_KEY): number => {
  const secret = readFileSync(keyFile, "utf8").trim();
  const publicKey = readFileSync(publicKeyFile, "utf8");
  const names = readdirSync(dir).filter((name) => SHARD_FILE.test(name) || name === HOSTS);
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

const signatureOf = (dir: string, name: string): string =>
  existsSync(join(dir, `${name}.minisig`)) ? readFileSync(join(dir, `${name}.minisig`), "utf8") : "";

const shardFaults = (dir: string, name: string, publicKey: string): string[] => {
  const said = readFileSync(join(dir, name));
  const held: unknown = JSON.parse(said.toString());
  const proofs = Array.isArray(held) ? held : [];
  return [
    ...(Array.isArray(held) && held.length > 0 ? [] : [`domains/${name} is not a list of proofs`]),
    ...(proofs.every((one) => typeof one === "string" && PROOF.test(one) && one.startsWith(name.slice(0, 2)))
      ? []
      : [`domains/${name} holds a proof that is not its own`]),
    ...(said.length <= SHARD_BYTES_AT_MOST ? [] : [`domains/${name} passes 70 KB`]),
    ...(holdsSignature(said, signatureOf(dir, name), publicKey, `domains/${name}`)
      ? []
      : [`domains/${name} is not signed`]),
  ];
};

const hostsFaults = (dir: string, publicKey: string): string[] => {
  const said = readFileSync(join(dir, HOSTS));
  return [
    ...(hostsIn(said.toString()) ? [] : [`domains/${HOSTS} is not a serial and a private domain`]),
    ...(holdsSignature(said, signatureOf(dir, HOSTS), publicKey, `domains/${HOSTS}`)
      ? []
      : [`domains/${HOSTS} is not signed`]),
  ];
};

export const branchFaults = (
  dir: string,
  publicKey = existsSync(PUBLIC_KEY) ? readFileSync(PUBLIC_KEY, "utf8") : "",
): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".minisig") && !name.startsWith("."))
    .flatMap((name) => {
      if (name === HOSTS) return hostsFaults(dir, publicKey);
      if (SHARD_FILE.test(name)) return shardFaults(dir, name, publicKey);
      return [`domains/${name} is neither a shard nor ${HOSTS}`];
    });
};

const run = async ([what, first, second, third]: string[]): Promise<void> => {
  if (what === "check" && first && second) {
    const faults = await txtFaults(first, second, dnsLookup);
    console.log(faults.length === 0 ? `ok ${first} names that root` : faults.join("\n"));
    if (faults.length > 0) process.exitCode = 1;
  } else if (what === "build" && first && second) {
    const approved = approvedIn(readFileSync(first, "utf8"));
    const faults = [...listFaults(approved), ...(await dnsFaults(approved, dnsLookup))];
    if (faults.length > 0) throw new Error(`nothing was written:\n${faults.join("\n")}`);
    const shards = await shardsOf(approved);
    writeShards(shards, second);
    console.log(`wrote ${approved.length} domains in ${shards.size} shards: sign them next`);
  } else if (what === "hosts" && first && second && third) {
    writeHosts({ private: first, serial: Number(second) }, third);
    console.log(`wrote ${HOSTS} with ${first} at serial ${second}: sign it next`);
  } else if (what === "sign" && first && second) {
    console.log(`signed ${signBranch(first, Date.now(), second)} files`);
  } else if (what === "verify" && first) {
    const faults = branchFaults(first);
    console.log(faults.length === 0 ? "ok the shards and hosts hold, signed with the limits key" : faults.join("\n"));
    if (faults.length > 0) process.exitCode = 1;
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
