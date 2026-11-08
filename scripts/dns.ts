import { Resolver } from "node:dns/promises";

const TXT_PREFIX = "tisty-root=";
export const RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);

export type Lookup = (resolver: string, name: string) => Promise<string[] | null>;

export const recordName = (domain: string): string => `_tisty.${domain}`;

// Straight to each resolver over UDP: a local filter that blocks DNS over HTTPS must not stop the signing.
export const dnsLookup: Lookup = async (server, name) => {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers([server]);
  try {
    return (await resolver.resolveTxt(name)).map((pieces) => pieces.join(""));
  } catch (error) {
    return NO_RECORD.has((error as { code?: string }).code ?? "") ? [] : null;
  }
};

const rootsIn = (texts: string[]): string[] =>
  texts.filter((text) => text.startsWith(TXT_PREFIX)).map((text) => text.slice(TXT_PREFIX.length));

// Never the record's own words in a fault: the domain's owner writes them, and the faults reach public logs.
export const txtFaults = async (domain: string, root: string, lookup: Lookup): Promise<string[]> => {
  const answers = await Promise.all(RESOLVERS.map((resolver) => lookup(resolver, recordName(domain))));
  return answers.flatMap((texts, at) => {
    const asked = RESOLVERS[at];
    if (texts === null) return [`${asked} could not be asked about ${recordName(domain)}`];
    const roots = rootsIn(texts);
    if (roots.length === 1 && roots[0] === root) return [];
    if (roots.length > 1) return [`${recordName(domain)} names more than one root, as ${asked} sees it`];
    return [`${recordName(domain)} does not name the root, as ${asked} sees it`];
  });
};

export const retried = async (
  faultsNow: () => Promise<string[]>,
  tries: number,
  betweenMs: number,
): Promise<string[]> => {
  for (let attempt = 1; ; attempt += 1) {
    const faults = await faultsNow();
    if (faults.length === 0 || attempt === tries) return faults;
    console.log(`try ${attempt} of ${tries}: ${faults.length} not holding`);
    await new Promise((done) => setTimeout(done, betweenMs));
  }
};
