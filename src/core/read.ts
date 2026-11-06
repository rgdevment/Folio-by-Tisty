import type { Revocation } from "@tisty/contracts";
import { isBelowVersion } from "../rules/envelope";
import { dayOf, type Limits } from "./limits";
import { netDigest } from "./net";
import { askForProof, type Refused, tooFast } from "./refused";
import { proofIsFresh } from "./start";
import type { Reading, Shown, Store, Version } from "./store";

export interface Asked {
  id: string;
  ip: string;
  now: number;
  proof?: string;
}

export interface Asking {
  id: string;
  ip: string;
  now: number;
}

export interface Limiter {
  allows(key: string): Promise<boolean>;
}

export interface ReadTools {
  store: Store;
  limiter: Limiter;
  limits: Limits;
  secret: string;
  dayKey: (today: number) => Promise<string>;
}

export interface SyncTools extends ReadTools {
  syncLimiter: Limiter;
}

export interface Served {
  served: true;
  version: Version;
  diesOn: number;
  body: ReadableStream;
  revocations: Revocation[];
  // What is written once the answer left, so a read never waits for a write (decision 105).
  note?: Reading;
}

const refusalOfState = (shown: Shown | null, { oldestContractServed: floor }: Limits): Refused | null => {
  if (!shown?.version) return { refused: "missing" };
  if (shown.blockedAt !== null) return { refused: "blocked" };
  if (!shown.alive) return { refused: "missing" };
  if (floor !== null && isBelowVersion(shown.version.contract, floor)) return { refused: "outdated" };
  return shown.pausedAt === null ? null : { refused: "paused" };
};

export type ServedFiles = Pick<Served, "served" | "body" | "note">;

interface AdmittedReader {
  shown: Shown & { version: Version };
  note?: Reading;
}

export const latestVersion = async (
  { id, ip, now }: Asking,
  { store, limiter, syncLimiter, limits, dayKey }: SyncTools,
): Promise<{ version: number; hash: string } | Refused> => {
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  if (!(await limiter.allows(net)) || !(await syncLimiter.allows(`${net}|${id}`))) return tooFast(now);
  const shown = await store.shown(id, today);
  const refused = refusalOfState(shown, limits);
  if (refused || !shown?.version) return refused ?? { refused: "missing" };
  return { version: shown.version.n, hash: shown.version.hash };
};

const admittedReader = async ({ id, ip, now, proof }: Asked, tools: ReadTools): Promise<AdmittedReader | Refused> => {
  const { store, limiter, limits, secret, dayKey } = tools;
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  if (!(await limiter.allows(net))) return tooFast(now);

  const shown = await store.shown(id, today);
  const refused = refusalOfState(shown, limits);
  if (refused || !shown?.version) return refused ?? { refused: "missing" };
  // Only a read stops here: the button still sees its version, and a new one is what lifts it (decision 153).
  if (shown.fixBy !== null && today > shown.fixBy) return { refused: "blocked" };

  const scope = `read|${id}|${net}`;
  const proved = proof !== undefined && (await proofIsFresh(secret, scope, proof, limits.proofBits, now));
  const reading: Reading = {
    owner: shown.owner,
    reader: net,
    doc: id,
    hour: new Date(now).getUTCHours(),
    proved,
  };
  const admitted = await store.admit(reading, today);
  if (admitted === "over") return askForProof(secret, scope, limits.proofBits, now);
  return { shown: { ...shown, version: shown.version }, ...(admitted === "new" ? { note: reading } : {}) };
};

export const readDoc = async (asked: Asked, tools: ReadTools): Promise<Served | Refused> => {
  const reader = await admittedReader(asked, tools);
  if ("refused" in reader) return reader;
  const { shown, note } = reader;
  const body = await tools.store.envelope(asked.id, shown.version);
  if (!body) return { refused: "missing" };
  return {
    served: true,
    version: shown.version,
    diesOn: shown.diesOn,
    body,
    revocations: shown.revocations,
    ...(note ? { note } : {}),
  };
};

export const readFiles = async (asked: Asked & { hash: string }, tools: ReadTools): Promise<ServedFiles | Refused> => {
  const reader = await admittedReader(asked, tools);
  if ("refused" in reader) return reader;
  if (reader.shown.version.files !== asked.hash) return { refused: "missing" };
  const body = await tools.store.filesOf(asked.id, asked.hash);
  if (!body) return { refused: "missing" };
  return { served: true, body, ...(reader.note ? { note: reader.note } : {}) };
};
