import { dayOf, type Limits, levelOfReport } from "./limits";
import { netDigest } from "./net";
import type { ReadTools } from "./read";
import { askForProof, type Refused } from "./refused";
import { holdsALink, isSealedLink } from "./sealed-link";
import { hourEnds, hourOf, proofIsFresh } from "./start";

export interface ReportTools extends ReadTools {
  evidenceKey: (today: number) => Promise<string>;
}

export interface Said {
  category: string;
  detail?: string;
  sealedLink?: string;
  version?: number;
}

export interface Reporting {
  id: string;
  ip: string;
  asn: number;
  now: number;
  said: Said;
  proof?: string;
}

const isTextUpTo = (value: unknown, atMost: number): boolean =>
  value === undefined || (typeof value === "string" && value.length <= atMost);

// A light report needs nobody to read the document, and a link in the clear would hand its key to the database.
const linkIsTaken = (link: unknown, category: string, limits: Limits): boolean =>
  link === undefined ||
  (levelOfReport(category) !== "light" && isTextUpTo(link, limits.sealedLinkAtMost) && isSealedLink(link as string));

// In the clear for good, so it must not carry what the seal exists to keep out of the database.
const detailIsTaken = (detail: unknown, limits: Limits): boolean =>
  isTextUpTo(detail, limits.reportDetailAtMost) && !holdsALink(String(detail ?? ""));

const versionIsTaken = (version: unknown): boolean =>
  version === undefined || (Number.isSafeInteger(version) && (version as number) > 0);

export const saidOf = (body: unknown, limits: Limits): Said | null => {
  if (typeof body !== "object" || body === null) return null;
  const { category, detail, sealedLink, version } = body as Record<string, unknown>;
  if (typeof category !== "string" || levelOfReport(category) === null) return null;
  if (!detailIsTaken(detail, limits) || !linkIsTaken(sealedLink, category, limits) || !versionIsTaken(version)) {
    return null;
  }
  return {
    category,
    ...(detail === undefined ? {} : { detail: detail as string }),
    ...(sealedLink === undefined ? {} : { sealedLink: sealedLink as string }),
    ...(version === undefined ? {} : { version: version as number }),
  };
};

// Nothing is written before the proof, so a flood of reports costs no rows (decision 41).
export const reportDoc = async (
  { id, ip, asn, now, said, proof }: Reporting,
  { store, limits, secret, dayKey, evidenceKey }: ReportTools,
): Promise<{ received: true } | Refused> => {
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  const scope = `report|${id}|${net}`;
  const proved = proof !== undefined && (await proofIsFresh(secret, scope, proof, limits.proofBits, now));
  if (!proved) return askForProof(secret, scope, limits.proofBits, now);
  if (!(await store.takeHourly(net, "report", hourOf(now), limits.reportsAnHour))) {
    return { refused: "quota", until: hourEnds(now) };
  }

  const reporter = await netDigest(await evidenceKey(today), ip);
  await store.report({ doc: id, net: reporter, asn, ...said }, today, hourOf(now));
  return { received: true };
};
