import type { Document, Revocation, Verdict } from "@tisty/contracts";
import { type Bytes, fromBase64Url } from "../core/bytes";
import { momentOf } from "../core/moment";
import { refuse } from "../rules/envelope";
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
  return {
    held,
    pictures: open.opened.slice(FIRST_PICTURE_PART),
    verdict: owner ? worseOf(signer, await verdictOf(owner, served)) : signer,
    fingerprint: await fingerprintOf(signature.root),
    ownerFingerprint: owner && owner.root !== signature.root ? await fingerprintOf(owner.root) : null,
    diesOn: arrived.diesOn,
  };
};
