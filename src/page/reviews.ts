import type { Review, Served, Translation } from "@tisty/contracts";
import { check } from "@tisty/contracts/check";
import { type Bytes, bigEndian, fromBase64Url, sameBytes, sha256, words } from "../core/bytes";
import { stillSpeaks } from "../core/look-alike";
import { certified, machineSigned, reviewedHolds, signedRow, sized } from "../rules/envelope";
import { macHolds } from "./open";
import { verdictOf } from "./verdict";

export interface HeldLanguage {
  document: string;
  lang: string;
  print: Bytes;
  ownersOwn: boolean;
}

const LANGUAGE_REVIEW = "language-review";

const reviewSaid = (anchor: string, review: Review): Bytes[] => {
  const { of, seq, kept, document = "", lang = "", title = "", key = "", print = "" } = review;
  const naming = [...sized(document), ...sized(lang), ...sized(title), fromBase64Url(key), fromBase64Url(print)];
  return [...sized(anchor), fromBase64Url(of), bigEndian(seq), Uint8Array.of(kept ? 1 : 0), ...(kept ? naming : [])];
};

const namesItsLanguage = (anchorKey: Bytes | undefined, { of, document = "" }: Review): Promise<boolean> =>
  anchorKey === undefined
    ? Promise.resolve(false)
    : macHolds(anchorKey, of, words("tisty-language-review\0"), words(document));

export const reviewHolds = async (anchor: string, owner: string, anchorKey: Bytes | undefined, review: Review) => {
  try {
    return (
      check("review", review).length === 0 &&
      review.root === owner &&
      (await certified(review)) &&
      (await machineSigned(review, LANGUAGE_REVIEW, ...reviewSaid(anchor, review))) &&
      (!review.kept || (await namesItsLanguage(anchorKey, review)))
    );
  } catch {
    return false;
  }
};

const byteOrder = (one: Bytes, other: Bytes): number => {
  const at = one.findIndex((byte, place) => byte !== other[place]);
  return at === -1 ? one.length - other.length : (one[at] as number) - (other[at] ?? -1);
};

const reviewsHash = async (anchor: string, reviews: readonly Review[]): Promise<Bytes> => {
  const rows = reviews.map((one) => signedRow(one, LANGUAGE_REVIEW, ...reviewSaid(anchor, one)));
  const each = await Promise.all(rows.map((row) => sha256(...row)));
  return sha256(words("tisty-language-reviews\0"), ...each.sort(byteOrder));
};

// Only while the served word names these very reviews and its machine still answers for the owner (contract, review.counts).
export const reviewsCount = async (anchor: string, owner: string, reviews: readonly Review[], served: Served) => {
  const { reviewed: head, reviewed_received: received, revocations = [] } = served;
  try {
    if (head?.anchor !== anchor || head.root !== owner || !(await reviewedHolds(head))) return false;
    const weighed = await verdictOf(head, received === undefined ? { revocations } : { received, revocations });
    return stillSpeaks(weighed) && sameBytes(fromBase64Url(head.reviews), await reviewsHash(anchor, reviews));
  } catch {
    return false;
  }
};

const newer = (one: Review, was: Review | undefined): boolean =>
  !was ||
  one.seq > was.seq ||
  (one.seq === was.seq && byteOrder(fromBase64Url(one.machine), fromBase64Url(was.machine)) > 0);

export const keptBy = async (
  anchor: string,
  owner: string,
  anchorKey: Bytes | undefined,
  reviews: readonly Review[],
  served: Served,
): Promise<Review[]> => {
  if (!(await reviewsCount(anchor, owner, reviews, served))) return [];
  const latest = new Map<string, Review>();
  for (const one of reviews) {
    if (newer(one, latest.get(one.of)) && (await reviewHolds(anchor, owner, anchorKey, one))) latest.set(one.of, one);
  }
  return [...latest.values()].filter((one) => one.kept);
};

export const reachedBy = (map: readonly Translation[], kept: readonly Review[]): Translation[] => {
  const signed = kept.map(({ document = "", lang = "", key = "", title }) => ({
    document,
    lang,
    key,
    ...(title === undefined ? {} : { title }),
  }));
  const reviewed = new Set(signed.map((one) => one.document));
  return [...signed, ...map.filter((one) => !one.pending && !reviewed.has(one.document))];
};

export const shows = ({ document, lang, print, ownersOwn }: HeldLanguage, kept: readonly Review[]): boolean =>
  ownersOwn ||
  kept.some(
    (one) => one.document === document && one.lang === lang && sameBytes(fromBase64Url(one.print ?? ""), print),
  );

export const printOf = async (opened: readonly Bytes[]): Promise<Bytes> =>
  sha256(words("tisty-language-print\0"), ...(await Promise.all(opened.map((one) => sha256(one)))));
