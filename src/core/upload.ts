import type { Envelope, EnvelopeKind, Owner } from "@tisty/contracts";
import { EnvelopeRefused, isBelowVersion, type ReadEnvelope, readEnvelope } from "../rules/envelope";
import { type Bytes, sha256 } from "./bytes";
import { DAY_MS, dayOf, type Limits } from "./limits";
import { netDigest } from "./net";
import type { ReadTools } from "./read";
import { askForProof, type Refused, tooFast } from "./refused";
import { hourEnds, hourOf, proofIsFresh, startHolds, toBase64Url, tokenHash } from "./start";
import type { AcceptedTerms, Created, Held, Stage, Uploaded } from "./store";
import { listFreesAt, uploadAllowedAt } from "./versions";

export interface FirstUpload {
  start: string;
  proof: string;
  adminToken: string;
  ttlDays: number;
  anchor?: string;
}

export interface Uploading {
  id: string;
  ip: string;
  now: number;
  bytes: () => Promise<Bytes | null>;
  first?: FirstUpload;
  files?: string;
}

export interface UploadTools extends ReadTools {
  sharingOpen: boolean;
  termsVersion: string;
}

// One ahead while a deploy catches up with the signed file, and one behind while readers' caches do: nobody waits on either.
const termsAccepted = ({ terms }: Envelope, { termsVersion }: UploadTools): string | null => {
  if (terms === undefined) return null;
  const said = BigInt(terms);
  const inForce = BigInt(termsVersion);
  return said >= inForce - 1n && said <= inForce + 1n ? terms : null;
};

export type UploadAnswer = { stored: true; version: number; filesWanted?: true } | Refused;

export type FilesUploadAnswer = { stored: true; hash: string } | Refused;

const FILES_HASH = /^[A-Za-z0-9_-]{43}$/;
const FILES_ENVELOPE_FRAME_BYTES = 32_768;

export const filesEnvelopeBytesAtMost = ({ filesBytesAtMost }: Limits): number =>
  filesBytesAtMost + FILES_ENVELOPE_FRAME_BYTES;

const ownerMarkOf = ({ machine, name_tag: nameTag }: Owner): string => `${machine}.${nameTag}`;

const withinTops = ({ parts }: Envelope, limits: Limits): boolean => {
  const pictures = parts.filter((one) => one.name === "picture");
  const biggest = (name: string): number =>
    Math.max(0, ...parts.filter((one) => one.name === name).flatMap((one) => [one.sealed_size, one.open_size]));
  return (
    pictures.length <= limits.picturesAtMost &&
    biggest("picture") <= limits.pictureBytesAtMost &&
    pictures.reduce((sum, one) => sum + one.sealed_size, 0) <= limits.picturesBytesAtMost &&
    biggest("first") <= limits.firstBytesAtMost &&
    biggest("rest") <= limits.restBytesAtMost
  );
};

const filesWithinTops = ({ parts }: Envelope, limits: Limits): boolean =>
  parts.length <= limits.filesAtMost &&
  parts.reduce((sum, one) => sum + one.sealed_size, 0) <= limits.filesBytesAtMost &&
  parts.reduce((sum, one) => sum + one.open_size, 0) <= limits.filesBytesAtMost;

const readOrRefuse = async (id: string, bytes: Bytes, kind: EnvelopeKind = "main"): Promise<ReadEnvelope | Refused> => {
  try {
    const read = await readEnvelope(bytes, { id, kind });
    return read.manifest.sealed ? read : { refused: "envelope", why: "damaged" };
  } catch (error) {
    if (error instanceof EnvelopeRefused) return { refused: "envelope", why: error.refusal };
    throw error;
  }
};

const REFUSAL_OF_CREATED: Partial<Record<Created, Refused["refused"]>> = {
  taken: "not_yours",
  shares_full: "shares_full",
  languages_full: "languages_full",
  no_anchor: "bad_upload",
  bad_ttl: "bad_upload",
};

const mayShare = async (
  { id, now }: Uploading,
  first: FirstUpload,
  { limits, secret }: ReadTools,
): Promise<Refused | null> => {
  if (!first.adminToken || !(await startHolds(secret, id, first.start, now))) return { refused: "bad_upload" };
  const proved = await proofIsFresh(secret, id, first.proof, limits.proofBits, now);
  return proved ? null : askForProof(secret, id, limits.proofBits, now);
};

const share = async (
  { id, now }: Uploading,
  first: FirstUpload,
  { manifest }: ReadEnvelope,
  net: string,
  { store }: ReadTools,
): Promise<Refused | null> => {
  const owner = manifest.owner as Owner;
  const created = await store.create(
    {
      id,
      owner: owner.root,
      adminHash: await tokenHash(first.adminToken),
      ttlDays: first.ttlDays,
      net,
      ownerMark: ownerMarkOf(owner),
      ...(owner.permit === undefined ? {} : { permit: owner.permit }),
      ...(first.anchor === undefined ? {} : { anchor: first.anchor }),
    },
    dayOf(now),
  );
  if (created === "quota") return { refused: "quota", until: hourEnds(now) };
  const refused = REFUSAL_OF_CREATED[created];
  return refused ? ({ refused } as Refused) : null;
};

interface KeyAdmission {
  admit(roots: string[], accepted: AcceptedTerms): Promise<Refused | null>;
  keep(): Promise<void>;
  giveBack(): Promise<void>;
}

// The slot is taken first so parallel requests cannot pass the day's top, and returned unless a version is stored.
const keyAdmission = (net: string, today: number, { store }: ReadTools): KeyAdmission => {
  let fresh: string[] = [];
  let toWrite: AcceptedTerms | undefined;
  return {
    admit: async (roots, accepted) => {
      for (const root of new Set(roots)) {
        const { said, terms } = await store.admitKey(root, net, today);
        if (said === "blocked") return { refused: "key_blocked" };
        if (said === "full") return { refused: "quota", until: (today + 1) * DAY_MS };
        if (said === "new") fresh.push(root);
        if (root === accepted.root && (terms === null || BigInt(accepted.version) > BigInt(terms))) toWrite = accepted;
      }
      return null;
    },
    keep: async () => {
      await store.keepKeys(fresh, today, toWrite);
      fresh = [];
      toWrite = undefined;
    },
    giveBack: async () => {
      if (fresh.length > 0) await store.giveKeysBack(fresh.length, net, today);
      fresh = [];
    },
  };
};

const mayUpload = ({ manifest, signature }: ReadEnvelope, held: Held): boolean => {
  const owner = manifest.owner as Owner;
  if (owner.root !== held.owner || (owner.permit ?? null) !== held.permit) return false;
  return signature.root === held.owner || ownerMarkOf(owner) === held.ownerMark;
};

const stopped = (held: Held, byOwner = false): Refused | null => {
  if (held.correctable && byOwner) return null;
  if (held.blocked) return { refused: "blocked" };
  return held.paused ? { refused: "paused" } : null;
};

const notNext = (held: Held, version: number, byOwner: boolean): Refused | null =>
  stopped(held, byOwner) ?? (version === held.latest + 1 ? null : { refused: "behind" });

interface OpenTo {
  net: string;
  stage: Stage;
}

const openTo = async ({ ip, now }: Uploading, { store, limiter, dayKey }: ReadTools): Promise<OpenTo | Refused> => {
  const net = await netDigest(await dayKey(dayOf(now)), ip);
  if (!(await limiter.allows(net))) return tooFast(now);
  const stage = await store.stage();
  return stage === "no_uploads" || stage === "blocked" ? { refused: "uploads_off" } : { net, stage };
};

const rootsOf = ({ manifest, signature }: ReadEnvelope): string[] => [(manifest.owner as Owner).root, signature.root];

// A key costs nothing to make, so the owner's counts as much as the signer's, or one old signer opens the way to all.
const newRootsOf = (read: ReadEnvelope, now: number, { store, limits }: ReadTools): Promise<string[]> =>
  store.newRootsOf(rootsOf(read), dayOf(now) - limits.daysAKeyIsNew);

// Until a key earns more, what it holds open is what limits it, however its documents spend it.
const roomRefused = async (
  owner: string,
  id: string,
  arriving: number,
  now: number,
  { store, limits }: ReadTools,
): Promise<Refused | null> => {
  const held = await store.heldByOwner(owner, dayOf(now), id);
  const atMost = limits.keyBytesAtMost;
  return held + arriving > atMost ? { refused: "room_full", held, arriving, atMost } : null;
};

const takeUploadHour = async (net: string, now: number, { store, limits }: ReadTools): Promise<Refused | null> =>
  (await store.takeHourly(net, "upload", hourOf(now), limits.uploadsAnHour))
    ? null
    : { refused: "quota", until: hourEnds(now) };

const answerOf = (uploaded: Uploaded, version: number, now: number): UploadAnswer => {
  switch (uploaded) {
    case "stored":
    case "same":
      return { stored: true, version };
    case "behind":
      return { refused: "behind" };
    case "missing":
    case "blocked":
    case "paused":
      return { refused: uploaded };
    case "quota":
      return { refused: "quota", until: hourEnds(now) };
    case "new_keys_full":
      return { refused: "uploads_off" };
    case "list_full":
      return { refused: "quota", until: now + DAY_MS };
    case "room_full":
      return { refused: "behind" };
  }
};

const storeVersion = async (
  uploading: Uploading,
  { net, stage }: OpenTo,
  keys: KeyAdmission,
  tools: UploadTools,
): Promise<UploadAnswer> => {
  const { id, now, first, files } = uploading;
  const { store, limits } = tools;
  const today = dayOf(now);
  let held = await store.held(id);
  const sharing = first && (!held || held.latest === 0) ? first : null;
  if (!held && !sharing) return { refused: "missing" };
  if (sharing) {
    if (!tools.sharingOpen) return { refused: "uploads_off" };
    const refused = await mayShare(uploading, sharing, tools);
    if (refused) return refused;
  }
  const bytes = await uploading.bytes();
  if (!bytes || bytes.length > limits.envelopeBytesAtMost) return { refused: "too_big" };

  const read = await readOrRefuse(id, bytes);
  if ("refused" in read) return read;
  const { manifest, signature } = read;
  if (!withinTops(manifest, limits)) return { refused: "too_big" };
  const floor = limits.oldestContractTaken;
  if (floor !== null && isBelowVersion(manifest.contract, floor)) return { refused: "outdated" };

  const hash = toBase64Url(await sha256(bytes));
  const version = termsAccepted(manifest, tools);
  const roots = rootsOf(read);
  const accepted = { root: signature.root, version: version ?? "", hour: hourOf(now) };
  if (held?.latest === manifest.version && held.versions.at(-1)?.hash === hash) {
    // A retry may be all that is left of an upload whose record was lost after its version was kept.
    if (version !== null && !(await keys.admit(roots, accepted))) await keys.keep();
    return { stored: true, version: manifest.version };
  }
  if (await store.isRevoked(signature.root, signature.machine, now)) return { refused: "revoked" };
  if (version === null) return { refused: "terms", version: tools.termsVersion };
  // The terms promise that an owner's own version lifts a block, however new the key.
  const correcting = held?.correctable && signature.root === held.owner;
  const fresh = correcting ? [] : await newRootsOf(read, now, tools);
  const newKey = fresh.length > 0;
  const sameFiles = files !== undefined && files === held?.versions.at(-1)?.files;
  const filesBytes =
    files === undefined ? 0 : sameFiles ? (held?.filesBytes ?? 0) : ((await store.filesBytes(id, files)) ?? 0);
  if (newKey && stage === "new_keys_off") return { refused: "uploads_off" };
  if (sharing) {
    if (manifest.version !== 1) return { refused: "behind" };
    // Before anything is written, or a refused first version could be sent again for free.
    const hourSpent = await takeUploadHour(net, now, tools);
    if (hourSpent) return hourSpent;
    const full = await keys.admit(roots, accepted);
    if (full) return full;
    const noRoom = await roomRefused((manifest.owner as Owner).root, id, bytes.length + filesBytes, now, tools);
    if (noRoom) return noRoom;
    const refused = await share(uploading, sharing, read, net, tools);
    if (refused) return refused;
    held = await store.held(id);
  }
  if (!held) return { refused: "missing" };
  if (!mayUpload(read, held)) return { refused: "not_yours" };
  const refusedNext = notNext(held, manifest.version, signature.root === held.owner);
  if (refusedNext) return refusedNext;
  const listFreed = listFreesAt(held.versions, now, limits);
  if (listFreed !== null) return { refused: "quota", until: listFreed };

  const allowedAt = uploadAllowedAt(held.versions, signature.root, now, limits);
  if (allowedAt > now) return { refused: "slow", until: allowedAt };
  if (!sharing) {
    const hourSpent = await takeUploadHour(net, now, tools);
    if (hourSpent) return hourSpent;
    // Its owner's key too, or a blocked owner's documents would carry on through an edit link.
    const full = await keys.admit([held.owner, signature.root], accepted);
    if (full) return full;
    const noRoom = correcting ? null : await roomRefused(held.owner, id, bytes.length + filesBytes, now, tools);
    if (noRoom) return noRoom;
  }

  const owner = manifest.owner as Owner;
  const storing = store.upload(
    {
      id,
      n: manifest.version,
      hash,
      body: bytes,
      net,
      at: now,
      signer: signature.root,
      machine: signature.machine,
      contract: manifest.contract,
      byOwner: signature.root === held.owner,
      permit: held.permit,
      ownerMark: ownerMarkOf(owner),
      newKey,
      ...(files === undefined ? {} : { files }),
      filesBytes,
      ...(correcting ? {} : { roomAtMost: limits.keyBytesAtMost }),
    },
    today,
    held,
  );
  // A first version that failed midway must not keep a share of its key for days.
  const uploaded = sharing
    ? await storing.catch(async (error: unknown) => {
        await store.forgetUnsent(id, net, today);
        throw error;
      })
    : await storing;
  // Checked again in the write itself, so uploads sent at once cannot each see the room empty.
  if (uploaded === "room_full") {
    if (sharing) await store.forgetUnsent(id, net, today);
    return (await roomRefused(held.owner, id, bytes.length + filesBytes, now, tools)) ?? { refused: "behind" };
  }
  if (sharing && uploaded !== "stored" && uploaded !== "same") await store.forgetUnsent(id, net, today);
  // Kept only once a version is, so a request that stores nothing leaves no key to age.
  if (uploaded === "stored") await keys.keep();
  return answerOf(uploaded, manifest.version, now);
};

const uploadVersion = async (uploading: Uploading, tools: UploadTools): Promise<UploadAnswer> => {
  const { files, now } = uploading;
  if (files !== undefined && !FILES_HASH.test(files)) return { refused: "bad_upload" };
  const open = await openTo(uploading, tools);
  if ("refused" in open) return open;
  const keys = keyAdmission(open.net, dayOf(now), tools);
  try {
    return await storeVersion(uploading, open, keys, tools);
  } finally {
    await keys.giveBack();
  }
};

export const uploadDoc = async (uploading: Uploading, tools: UploadTools): Promise<UploadAnswer> => {
  const answer = await uploadVersion(uploading, tools);
  if ("refused" in answer || uploading.files === undefined) return answer;
  const arrived = (await tools.store.filesBytes(uploading.id, uploading.files)) !== null;
  return arrived ? answer : { ...answer, filesWanted: true };
};

export const uploadFiles = async (uploading: Uploading, tools: ReadTools): Promise<FilesUploadAnswer> => {
  const { id, now } = uploading;
  const { store, limits } = tools;
  const open = await openTo(uploading, tools);
  if ("refused" in open) return open;
  const { net } = open;
  const held = await store.held(id);
  if (!held) return { refused: "missing" };
  const stoppedHere = stopped(held);
  if (stoppedHere) return stoppedHere;

  const bytes = await uploading.bytes();
  if (!bytes || bytes.length > filesEnvelopeBytesAtMost(limits)) return { refused: "too_big" };
  const read = await readOrRefuse(id, bytes, "files");
  if ("refused" in read) return read;
  const { manifest, manifestBytes, index, signature } = read;
  if (!filesWithinTops(manifest, limits)) return { refused: "too_big" };
  const floor = limits.oldestContractTaken;
  if (floor !== null && isBelowVersion(manifest.contract, floor)) return { refused: "outdated" };
  if (await store.isRevoked(signature.root, signature.machine, now)) return { refused: "revoked" };
  if (!mayUpload(read, held)) return { refused: "not_yours" };

  const hash = toBase64Url(await sha256(manifestBytes, index));
  if (held.versions.at(-1)?.files !== hash) return { refused: "behind" };
  if ((await store.filesBytes(id, hash)) !== null) return { stored: true, hash };
  const newKey = (await newRootsOf(read, now, tools)).length > 0;
  // A blocked key uploads nothing more, attachments included, and neither does an edit link of its documents.
  if (await store.anyBlocked([held.owner, signature.root])) return { refused: "key_blocked" };
  const hourSpent = await takeUploadHour(net, now, tools);
  if (hourSpent) return hourSpent;
  const latestBytes = held.versions.at(-1)?.bytes ?? 0;
  const noRoom = await roomRefused(held.owner, id, latestBytes + bytes.length, now, tools);
  if (noRoom) return noRoom;
  const kept = await store.keepFiles({ id, hash, body: bytes, net, latest: held.latest, newKey }, dayOf(now));
  return kept === "stored" ? { stored: true, hash } : { refused: "quota", until: now + DAY_MS };
};
