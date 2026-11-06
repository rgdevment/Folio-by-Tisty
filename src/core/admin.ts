import { dayOf } from "./limits";
import { netDigest } from "./net";
import { type Refused, tooFast } from "./refused";
import type { ReportTools } from "./report";
import { hourOf, sameText, tokenHash } from "./start";
import type { DocStatus, Store } from "./store";

export type AdminAction = "status" | "pause" | "resume" | "stop" | "appeal" | "permit";

export interface Administering {
  id: string;
  ip: string;
  now: number;
  token: string;
  action: AdminAction;
  permit?: string | null;
}

export type AdminTools = Pick<ReportTools, "store" | "limiter" | "dayKey">;
export type AdminAnswer = { done: true } | { status: DocStatus } | Refused;

const CHANGES: Record<"pause" | "resume" | "stop", (store: Store, id: string, today: number) => Promise<void>> = {
  pause: (store, id, today) => store.pause(id, today),
  resume: (store, id, today) => store.resume(id, today),
  stop: (store, id, today) => store.stop(id, today),
};

const appeal = async (
  id: string,
  { blockedAt, appealedAt }: DocStatus,
  today: number,
  now: number,
  { store }: AdminTools,
): Promise<AdminAnswer> => {
  if (blockedAt === null) return { refused: "not_blocked" };
  if (appealedAt !== null) return { refused: "appealed" };
  await store.appeal(id, today, hourOf(now));
  return { done: true };
};

export const setPermitHolds = (said: unknown): said is { permit: string | null } => {
  if (typeof said !== "object" || said === null || !("permit" in said)) return false;
  const { permit } = said as { permit: unknown };
  return permit === null || (typeof permit === "string" && /^[A-Za-z0-9_-]{43}$/.test(permit));
};

export const administer = async (
  { id, ip, now, token, action, permit = null }: Administering,
  tools: AdminTools,
): Promise<AdminAnswer> => {
  const { store, limiter, dayKey } = tools;
  const today = dayOf(now);
  if (!(await limiter.allows(await netDigest(await dayKey(today), ip)))) return tooFast(now);
  const owned = await store.owned(id, today);
  // A wrong token and a missing document look the same, so the admin link is the only way to learn anything.
  if (!owned || !sameText(await tokenHash(token), owned.adminHash)) return { refused: "missing" };

  if (action === "status") return { status: owned.status };
  if (action === "appeal") return appeal(id, owned.status, today, now, tools);
  if (owned.status.blockedAt !== null) return { refused: "blocked" };
  if (action === "permit") await store.setPermit(id, permit);
  else await CHANGES[action](store, id, today);
  return { done: true };
};
