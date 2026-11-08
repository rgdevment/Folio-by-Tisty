import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN } from "../src/core/checked-domain.ts";
import type { Maker } from "../src/core/look-alike.ts";
import { dnsLookup, type Lookup, recordName, retried, txtFaults } from "./dns.ts";

const ROOT = /^[A-Za-z0-9_-]{43}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const TRIES = 5;
const BETWEEN_TRIES_MS = 60_000;

const shapeFaults = ({ root, name, domain }: Record<string, unknown>): string[] => [
  ...(typeof root === "string" && ROOT.test(root) ? [] : ["maker.root is not a root"]),
  ...(name === undefined || (typeof name === "string" && NAME.test(name)) ? [] : ["maker.name is not a name"]),
  ...(domain === undefined || (typeof domain === "string" && DOMAIN.test(domain))
    ? []
    : ["maker.domain is not a lowercase ASCII domain"]),
];

export const makerFaults = (maker: unknown): string[] => {
  if (maker === undefined) return [];
  if (typeof maker !== "object" || maker === null || Array.isArray(maker)) return ["maker is not an object"];
  const said = maker as Record<string, unknown>;
  const unknown = Object.keys(said).filter((key) => !["root", "name", "domain"].includes(key));
  return [...unknown.map((key) => `maker.${key} is not something the maker has`), ...shapeFaults(said)];
};

export const domainFaults = async ({ root, domain }: Maker, lookup: Lookup): Promise<string[]> =>
  domain === undefined ? [] : txtFaults(domain, root, lookup);

export const makerIn = (limitsFile: string): Maker | undefined =>
  (JSON.parse(readFileSync(limitsFile, "utf8")) as { maker?: Maker }).maker;

const watch = async (): Promise<void> => {
  const maker = makerIn("docs/limits.json");
  if (maker?.domain === undefined) {
    console.log("ok the maker names no domain");
    return;
  }
  const faults = await retried(() => domainFaults(maker, dnsLookup), TRIES, BETWEEN_TRIES_MS);
  if (faults.length === 0) console.log(`ok ${recordName(maker.domain)} names the maker's root`);
  for (const fault of faults) console.log(`::error::${fault}`);
  if (faults.length > 0) process.exitCode = 1;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await watch();
