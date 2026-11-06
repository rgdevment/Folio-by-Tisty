import type { Revocation } from "@tisty/contracts";
import { check } from "@tisty/contracts/check";
import { revocationHolds } from "../rules/envelope";
import { dayOf, type Limits } from "./limits";
import { netDigest } from "./net";
import type { ReadTools } from "./read";
import { type Refused, tooFast } from "./refused";
import { hourEnds, hourOf } from "./start";

export const saidRevocations = (said: unknown, limits: Limits): Revocation[] | null => {
  if (!Array.isArray(said) || said.length === 0 || said.length > limits.revocationsAtOnce) return null;
  return said.every((one) => check("revocation", one).length === 0) ? (said as Revocation[]) : null;
};

export const takeRevocations = async (
  { said, ip, now }: { said: unknown; ip: string; now: number },
  { store, limiter, limits, dayKey }: ReadTools,
): Promise<{ done: true } | Refused> => {
  const net = await netDigest(await dayKey(dayOf(now)), ip);
  if (!(await limiter.allows(net))) return tooFast(now);
  const revocations = saidRevocations(said, limits);
  if (!revocations) return { refused: "bad_revocation" };
  const held = await Promise.all(revocations.map((one) => revocationHolds(one).catch(() => false)));
  if (held.includes(false)) return { refused: "bad_revocation" };
  if (!(await store.takeHourly(net, "revocation", hourOf(now), limits.revocationsAnHour, revocations.length))) {
    return { refused: "quota", until: hourEnds(now) };
  }
  if (!(await store.haveSigned(revocations.map((one) => one.root)))) return { refused: "bad_revocation" };
  await store.revoke(revocations);
  return { done: true };
};
