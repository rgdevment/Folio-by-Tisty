import type { Envelope, EnvelopeKind, Owner } from "@tisty/contracts";
import { EnvelopeRefused, isBelowVersion, type ReadEnvelope, readEnvelope } from "../rules/envelope";
import { type Bytes, sha256 } from "./bytes";
import { DAY_MS, dayOf, type Limits } from "./limits";
import { netDigest } from "./net";
import type { ReadTools } from "./read";
import { askForProof, type Refused, tooFast } from "./refused";
import { hourEnds, hourOf, proofIsFresh, startHolds, toBase64Url, tokenHash } from "./start";
import type { Created, Held, Uploaded } from "./store";
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

const mayUpload = ({ manifest, signature }: ReadEnvelope, held: Held): boolean => {
  const owner = manifest.owner as Owner;
  if (owner.root !== held.owner || (owner.permit ?? null) !== held.permit) return false;
  return signature.root === held.owner || ownerMarkOf(owner) === held.ownerMark;
};

const stopped = (held: Held): Refused | null => {
  if (held.blocked) return { refused: "blocked" };
  return held.paused ? { refused: "paused" } : null;
};

const notNext = (held: Held, version: number): Refused | null =>
  stopped(held) ?? (version === held.latest + 1 ? null : { refused: "behind" });

const netIfOpen = async ({ ip, now }: Uploading, { store, limiter, dayKey }: ReadTools): Promise<string | Refused> => {
  const net = await netDigest(await dayKey(dayOf(now)), ip);
  if (!(await limiter.allows(net))) return tooFast(now);
  const stage = await store.stage();
  return stage === "no_uploads" || stage === "blocked" ? { refused: "uploads_off" } : net;
};

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
    case "list_full":
      return { refused: "quota", until: now + DAY_MS };
  }
};

const uploadVersion = async (uploading: Uploading, tools: ReadTools): Promise<UploadAnswer> => {
  const { id, now, first, files } = uploading;
  const { store, limits } = tools;
  if (files !== undefined && !FILES_HASH.test(files)) return { refused: "bad_upload" };
  const today = dayOf(now);
  const net = await netIfOpen(uploading, tools);
  if (typeof net !== "string") return net;
  let held = await store.held(id);
  const sharing = first && (!held || held.latest === 0) ? first : null;
  if (!held && !sharing) return { refused: "missing" };
  if (sharing) {
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
  if (held?.latest === manifest.version && held.versions.at(-1)?.hash === hash) {
    return { stored: true, version: manifest.version };
  }
  if (await store.isRevoked(signature.root, signature.machine, now)) return { refused: "revoked" };
  if (sharing) {
    if (manifest.version !== 1) return { refused: "behind" };
    const refused = await share(uploading, sharing, read, net, tools);
    if (refused) return refused;
    held = await store.held(id);
  }
  if (!held) return { refused: "missing" };
  if (!mayUpload(read, held)) return { refused: "not_yours" };
  const stopped = notNext(held, manifest.version);
  if (stopped) return stopped;
  const listFreed = listFreesAt(held.versions, now, limits);
  if (listFreed !== null) return { refused: "quota", until: listFreed };

  const allowedAt = uploadAllowedAt(held.versions, signature.root, now, limits);
  if (allowedAt > now) return { refused: "slow", until: allowedAt };
  if (!(await store.takeHourly(net, "upload", hourOf(now), limits.uploadsAnHour))) {
    return { refused: "quota", until: hourEnds(now) };
  }

  const owner = manifest.owner as Owner;
  const uploaded = await store.upload(
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
      ...(files === undefined ? {} : { files }),
    },
    today,
    held,
  );
  return answerOf(uploaded, manifest.version, now);
};

export const uploadDoc = async (uploading: Uploading, tools: ReadTools): Promise<UploadAnswer> => {
  const answer = await uploadVersion(uploading, tools);
  if ("refused" in answer || uploading.files === undefined) return answer;
  const arrived = await tools.store.hasFiles(uploading.id, uploading.files);
  return arrived ? answer : { ...answer, filesWanted: true };
};

export const uploadFiles = async (uploading: Uploading, tools: ReadTools): Promise<FilesUploadAnswer> => {
  const { id, now } = uploading;
  const { store, limits } = tools;
  const net = await netIfOpen(uploading, tools);
  if (typeof net !== "string") return net;
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
  if (await store.hasFiles(id, hash)) return { stored: true, hash };
  if (!(await store.takeHourly(net, "upload", hourOf(now), limits.uploadsAnHour))) {
    return { refused: "quota", until: hourEnds(now) };
  }
  const kept = await store.keepFiles({ id, hash, body: bytes, net }, dayOf(now));
  return kept === "stored" ? { stored: true, hash } : { refused: "quota", until: now + DAY_MS };
};
