import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = /^[A-Za-z0-9_-]{43}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const TXT_PREFIX = "tisty-root=";
const RESOLVERS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];
const TRIES = 5;
const BETWEEN_TRIES_MS = 60_000;

export interface Maker {
  root: string;
  name?: string;
  domain?: string;
}

export type Lookup = (resolver: string, name: string) => Promise<string[] | null>;

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

export const recordName = (domain: string): string => `_tisty.${domain}`;

export const textsOf = (answer: unknown): string[] => {
  const records = (answer as { Answer?: { type?: number; data?: string }[] }).Answer ?? [];
  return records
    .filter((one) => one.type === 16 && typeof one.data === "string")
    .map((one) => [...(one.data as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, piece]) => piece).join(""));
};

export const dohLookup: Lookup = async (resolver, name) => {
  try {
    const answer = await fetch(`${resolver}?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: "application/dns-json" },
      redirect: "error",
    });
    if (!answer.ok) return null;
    const said = (await answer.json()) as { Status?: number };
    return said.Status === 0 || said.Status === 3 ? textsOf(said) : null;
  } catch {
    return null;
  }
};

const rootsIn = (texts: string[]): string[] =>
  texts.filter((text) => text.startsWith(TXT_PREFIX)).map((text) => text.slice(TXT_PREFIX.length));

// Never the record's own words in a fault: the domain's owner writes them, and the faults reach public logs.
export const domainFaults = async ({ root, domain }: Maker, lookup: Lookup): Promise<string[]> => {
  if (domain === undefined) return [];
  const answers = await Promise.all(RESOLVERS.map((resolver) => lookup(resolver, recordName(domain))));
  return answers.flatMap((texts, at) => {
    const asked = new URL(RESOLVERS[at] ?? "").host;
    if (texts === null) return [`${asked} could not be asked about ${recordName(domain)}`];
    const roots = rootsIn(texts);
    if (roots.length === 1 && roots[0] === root) return [];
    if (roots.length > 1) return [`${recordName(domain)} names more than one root, as ${asked} sees it`];
    return [`${recordName(domain)} does not name the maker's root, as ${asked} sees it`];
  });
};

export const makerIn = (limitsFile: string): Maker | undefined =>
  (JSON.parse(readFileSync(limitsFile, "utf8")) as { maker?: Maker }).maker;

const watch = async (): Promise<void> => {
  const maker = makerIn("docs/limits.json");
  if (maker?.domain === undefined) {
    console.log("ok the maker names no domain");
    return;
  }
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    const faults = await domainFaults(maker, dohLookup);
    if (faults.length === 0) {
      console.log(`ok ${recordName(maker.domain)} names the maker's root`);
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
