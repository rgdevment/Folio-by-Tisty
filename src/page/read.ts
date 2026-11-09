import type { Document, Revocation, Verdict } from "@tisty/contracts";
import { type Bytes, fromBase64Url } from "../core/bytes";
import { type Standing, standingOf, stillSpeaks } from "../core/look-alike";
import { momentOf } from "../core/moment";
import { refuse } from "../rules/envelope";
import { isChecked, type ShardLoader } from "./checked";
import { MAKER } from "./maker";
import { documentIn, openEnvelope } from "./open";
import { fingerprintOf, verdictOf, worseOf } from "./verdict";

export interface Arrived {
  bytes: Bytes;
  arrivedAt: number;
  diesOn: number;
  version?: number;
  revocations?: Revocation[];
}

export interface Opened {
  held: Document;
  pictures: Bytes[];
  verdict: Verdict;
  fingerprint: string;
  ownerFingerprint: string | null;
  signerStanding: Standing;
  ownerStanding: Standing;
  diesOn: number;
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

export const openLink = async (id: string, linkKey: string, arrived: Arrived, load?: ShardLoader): Promise<Opened> => {
  const open = await openEnvelope(arrived.bytes, { id, kind: "main" }, keyIn(linkKey));
  const held = await documentIn(open);
  const served = { received: momentOf(arrived.arrivedAt), revocations: arrived.revocations ?? [] };
  const { signature, manifest } = open;
  const signer = await verdictOf(signature, served);
  const owner = manifest.owner;
  const ownerVerdict = owner ? await verdictOf(owner, served) : signer;
  const [signerStanding, ownerStanding] = await Promise.all([
    standingFor(signature.root, signer, held.signed_as, load),
    standingFor(owner?.root ?? signature.root, ownerVerdict, held.owner_name, load),
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
    diesOn: arrived.diesOn,
  };
};
