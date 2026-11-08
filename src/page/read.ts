import type { Document, Revocation, Verdict } from "@tisty/contracts";
import { type Bytes, fromBase64Url } from "../core/bytes";
import { type Standing, standingOf } from "../core/look-alike";
import { momentOf } from "../core/moment";
import { refuse } from "../rules/envelope";
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

export const openLink = async (id: string, linkKey: string, arrived: Arrived): Promise<Opened> => {
  const open = await openEnvelope(arrived.bytes, { id, kind: "main" }, keyIn(linkKey));
  const held = await documentIn(open);
  const served = { received: momentOf(arrived.arrivedAt), revocations: arrived.revocations ?? [] };
  const { signature, manifest } = open;
  const signer = await verdictOf(signature, served);
  const owner = manifest.owner;
  const ownerVerdict = owner ? await verdictOf(owner, served) : signer;
  return {
    held,
    pictures: open.opened.slice(FIRST_PICTURE_PART),
    verdict: worseOf(signer, ownerVerdict),
    fingerprint: await fingerprintOf(signature.root),
    ownerFingerprint: owner && owner.root !== signature.root ? await fingerprintOf(owner.root) : null,
    signerStanding: standingOf(signature.root, signer, held.signed_as, MAKER),
    ownerStanding: standingOf(owner?.root ?? signature.root, ownerVerdict, held.owner_name, MAKER),
    diesOn: arrived.diesOn,
  };
};
