import type { Served, Signature, Verdict } from "@tisty/contracts";
import { check } from "@tisty/contracts/check";
import { fromBase64Url, sha256, words } from "../core/bytes";
import { revocationHolds } from "../rules/envelope";

const FINGERPRINT_BYTES = 9;
const FINGERPRINT_DROPPED_BITS = 6n;
const FINGERPRINT_DIGITS = 20;
const FINGERPRINT_GROUP = /.{5}/g;

// What the page says of a signature that holds. The moments are in one form, so they sort as they read (decision 134).
export const verdictOf = async (
  { root, machine }: Pick<Signature, "root" | "machine">,
  { received, revocations = [] }: Served,
): Promise<Verdict> => {
  const counting: string[] = [];
  for (const one of revocations) {
    if (
      check("revocation", one).length === 0 &&
      one.root === root &&
      one.machine === machine &&
      (await revocationHolds(one))
    ) {
      counting.push(one.at);
    }
  }
  const [earliest] = counting.sort();
  if (earliest === undefined) return "holds";
  return received !== undefined && received < earliest ? "retired" : "doubtful";
};

const FROM_BEST_TO_WORST: Verdict[] = ["holds", "retired", "doubtful", "unreadable", "refused"];

export const worseOf = (one: Verdict, other: Verdict): Verdict =>
  FROM_BEST_TO_WORST.indexOf(one) >= FROM_BEST_TO_WORST.indexOf(other) ? one : other;

export const fingerprintOf = async (root: string): Promise<string> => {
  const digest = await sha256(words("tisty-share.person.v1\0"), fromBase64Url(root));
  const hex = [...digest.subarray(0, FINGERPRINT_BYTES)].map((one) => one.toString(16).padStart(2, "0")).join("");
  const number = BigInt(`0x${hex}`) >> FINGERPRINT_DROPPED_BITS;
  return (number.toString().padStart(FINGERPRINT_DIGITS, "0").match(FINGERPRINT_GROUP) ?? []).join(" ");
};
