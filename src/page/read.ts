import type { Document, Review, Reviewed, Revocation, Served, Verdict } from "@tisty/contracts";
import { type Bytes, fromBase64Url } from "../core/bytes";
import { type Standing, standingOf, stillSpeaks } from "../core/look-alike";
import { momentOf } from "../core/moment";
import { editorHolds, refuse } from "../rules/envelope";
import { isChecked, type ShardLoader } from "./checked";
import { MAKER } from "./maker";
import { documentIn, openEnvelope } from "./open";
import { keptBy, printOf } from "./reviews";
import { fingerprintOf, verdictOf, worseOf } from "./verdict";

export interface Arrived {
  bytes: Bytes;
  arrivedAt: number;
  diesOn: number;
  version?: number;
  revocations?: Revocation[];
  reviewed?: Reviewed;
  reviewedAt?: number;
}

export interface Opened {
  held: Document;
  pictures: Bytes[];
  verdict: Verdict;
  fingerprint: string;
  ownerFingerprint: string | null;
  signerStanding: Standing;
  ownerStanding: Standing;
  editors: readonly ShownEditor[];
  diesOn: number;
  owner: string;
  print: Bytes;
  ownerKeeps: readonly Review[];
}

export interface ShownEditor {
  name: string;
  standing: Standing;
}

const FIRST_PICTURE_PART = 2;

export const keyIn = (said: string): Bytes | undefined => {
  if (said === "") return undefined;
  try {
    return fromBase64Url(said);
  } catch {
    return refuse("key", "this link brings no key that can be read");
  }
};

export const standingFor = async (
  root: string,
  verdict: Verdict,
  alias: string | undefined,
  load?: ShardLoader,
  shards?: ReadonlySet<string>,
): Promise<Standing> => {
  const standing = standingOf(root, verdict, alias, MAKER);
  if (standing !== "plain" || !stillSpeaks(verdict)) return standing;
  return (await isChecked(root, alias, load, shards)) ? "checked" : standing;
};

// One per root, chosen among those that hold, so an entry that fails cannot hide a person's real one.
export const editorsOf = async ({ id, editors = [] }: Document, served: Served): Promise<ShownEditor[]> => {
  const verdicts = await Promise.all(
    editors.map(async (one) => (one.in === id && (await editorHolds(one)) ? verdictOf(one, served) : "refused")),
  );
  const roots = new Set<string>();
  return editors.flatMap((one, at) => {
    const verdict = verdicts[at] as Verdict;
    if (!stillSpeaks(verdict) || roots.has(one.root)) return [];
    roots.add(one.root);
    return [{ name: one.name, standing: standingOf(one.root, verdict, one.name, MAKER) }];
  });
};

const servedOf = ({ arrivedAt, revocations = [], reviewed, reviewedAt }: Arrived): Served => ({
  received: momentOf(arrivedAt),
  revocations,
  ...(reviewed ? { reviewed } : {}),
  ...(reviewedAt ? { reviewed_received: momentOf(reviewedAt) } : {}),
});

export const openLink = async (id: string, linkKey: string, arrived: Arrived, load?: ShardLoader): Promise<Opened> => {
  const key = keyIn(linkKey);
  const open = await openEnvelope(arrived.bytes, { id, kind: "main" }, key);
  const held = await documentIn(open);
  const served = servedOf(arrived);
  const { signature, manifest } = open;
  const signer = await verdictOf(signature, served);
  const owner = manifest.owner;
  const ownerRoot = owner?.root ?? signature.root;
  const ownerVerdict = owner ? await verdictOf(owner, served) : signer;
  const [signerStanding, ownerStanding, editors, ownerKeeps, print] = await Promise.all([
    standingFor(signature.root, signer, held.signed_as, load),
    standingFor(ownerRoot, ownerVerdict, held.owner_name, load),
    editorsOf(held, served),
    keptBy(id, ownerRoot, key, held.reviews ?? [], served),
    printOf(open.opened),
  ]);
  // held.editors goes unshown until each entry has its own check under signing.editor: unchecked, one could name someone who never edited it.
  return {
    held,
    pictures: open.opened.slice(FIRST_PICTURE_PART),
    verdict: worseOf(signer, ownerVerdict),
    fingerprint: await fingerprintOf(signature.root),
    ownerFingerprint: owner && owner.root !== signature.root ? await fingerprintOf(owner.root) : null,
    signerStanding,
    ownerStanding,
    editors,
    diesOn: arrived.diesOn,
    owner: ownerRoot,
    print,
    ownerKeeps,
  };
};
