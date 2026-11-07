import { dayOf } from "./limits";
import { netDigest } from "./net";
import type { Limiter, Served, ServedFiles } from "./read";
import { type Refused, tooFast } from "./refused";
import { tokenHash } from "./start";
import type { OpenedCase, Store } from "./store";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface CaseAsked {
  id: string;
  token: string;
  ip: string;
  now: number;
}

export interface CaseTools {
  store: Store;
  limiter: Limiter;
  dayKey: (today: number) => Promise<string>;
}

const openedCase = async (
  { id, token, ip, now }: CaseAsked,
  { store, limiter, dayKey }: CaseTools,
): Promise<OpenedCase | Refused> => {
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  if (!(await limiter.allows(net))) return tooFast(now);
  if (!TOKEN.test(token)) return { refused: "missing" };
  return (await store.openedCase(id, await tokenHash(token), today, now)) ?? { refused: "missing" };
};

export const readCase = async (asked: CaseAsked, tools: CaseTools): Promise<Served | Refused> => {
  const opened = await openedCase(asked, tools);
  if ("refused" in opened) return opened;
  const body = await tools.store.envelope(asked.id, opened.version);
  if (!body) return { refused: "missing" };
  return { served: true, version: opened.version, diesOn: opened.diesOn, body, revocations: opened.revocations };
};

export const readCaseFiles = async (
  asked: CaseAsked & { hash: string },
  tools: CaseTools,
): Promise<ServedFiles | Refused> => {
  const opened = await openedCase(asked, tools);
  if ("refused" in opened) return opened;
  if (opened.version.files !== asked.hash) return { refused: "missing" };
  const body = await tools.store.filesOf(asked.id, asked.hash);
  return body ? { served: true, body } : { refused: "missing" };
};

export const readCaseRecords = async (asked: CaseAsked, tools: CaseTools): Promise<{ sealed: string } | Refused> => {
  const opened = await openedCase(asked, tools);
  if ("refused" in opened) return opened;
  return opened.sealedRecords === null ? { refused: "missing" } : { sealed: opened.sealedRecords };
};
