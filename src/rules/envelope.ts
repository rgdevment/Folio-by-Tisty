import type { Envelope, EnvelopeKind, Opening, Owner, Signature } from "@tisty/contracts";
import { check, VERSION } from "@tisty/contracts/check";
import { type Bytes, bigEndian, fromBase64Url, joined, sameBytes, sha256, words } from "../core/bytes";

export type EnvelopeRefusal = "newer" | "older" | "damaged" | "unsigned" | "key";

export class EnvelopeRefused extends Error {
  readonly refusal: EnvelopeRefusal;

  constructor(refusal: EnvelopeRefusal, says: string) {
    super(says);
    this.refusal = refusal;
  }
}

export const refuse = (refusal: EnvelopeRefusal, says: string): never => {
  throw new EnvelopeRefused(refusal, says);
};

export type Asked = Pick<Opening, "id" | "kind">;

export interface ReadEnvelope {
  manifest: Envelope;
  manifestBytes: Bytes;
  signature: Signature;
  index: Bytes;
  parts: Bytes[];
}

const MARK = words("TENV");
const HASH_BYTES = 32;
const MANIFEST_BYTES_AT_MOST = 16384;
const SIGNATURE_BYTES_AT_MOST = 2048;
const LENGTH_BYTES = 4;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
export const jsonIn = <T>(bytes: Bytes): T => JSON.parse(decoder.decode(bytes)) as T;

const FIRST_SHARED = { major: 1, minor: 2 };
const ONE_SPELLING = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.|$)/;

const numbersOf = (version: string): { major: number; minor: number } | null => {
  const [, major, minor] = ONE_SPELLING.exec(version) ?? [];
  return major === undefined || minor === undefined ? null : { major: Number(major), minor: Number(minor) };
};

const OURS = numbersOf(VERSION);

// Read first of all: a newer version may say what this one would call damaged (decision 154).
const weighVersion = (said: unknown): void => {
  if (typeof said !== "string") refuse("damaged", "it says no version");
  const version = said as string;
  if (version.includes("-") || VERSION.includes("-")) {
    if (version !== VERSION) refuse("older", `a draft opens only under itself: ${version}`);
    return;
  }
  const numbers = numbersOf(version);
  if (!numbers || !OURS) throw new EnvelopeRefused("damaged", `not a version: ${version}`);
  if (numbers.major > OURS.major) refuse("newer", `written under a newer version: ${version}`);
  if (numbers.major < OURS.major) refuse("older", `written under an older version: ${version}`);
  if (numbers.major === FIRST_SHARED.major && numbers.minor < FIRST_SHARED.minor) {
    refuse("older", `written before the first version shared: ${version}`);
  }
};

const underALaterMinor = (version: string): boolean => {
  const numbers = numbersOf(version);
  return !version.includes("-") && numbers?.major === OURS?.major && (numbers?.minor ?? 0) > (OURS?.minor ?? 0);
};

export const isBelowVersion = (version: string, floor: string): boolean => {
  const said = numbersOf(version);
  const least = numbersOf(floor);
  if (!said || !least) return true;
  return said.major < least.major || (said.major === least.major && said.minor < least.minor);
};

// What this reader would refuse under a later minor may be what that minor added (decision 154).
export const toldApart = async <T>(version: string, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (underALaterMinor(version)) return refuse("newer", `written under a later minor: ${version}`);
    throw error;
  }
};

const partsInOrder = ({ kind, parts }: Envelope): boolean => {
  const names = parts.map((one) => one.name);
  if (kind === "files") return names.every((one) => one === "file");
  return names[0] === "first" && names[1] === "rest" && names.slice(2).every((one) => one === "picture");
};

const holdsManifest = (manifest: Envelope, { id, kind }: { id: string; kind: EnvelopeKind }): void => {
  const amiss = check("envelope", manifest);
  if (amiss.length > 0) refuse("damaged", `its manifest: ${amiss[0]}`);
  if (manifest.id !== id) refuse("damaged", "it is not the document asked for");
  if (manifest.kind !== kind) refuse("damaged", "it is not the kind asked for");
  if (manifest.from !== undefined && manifest.from >= manifest.version) refuse("damaged", "it starts from a later one");
  if (manifest.parts.some((one) => one.compressed && one.name !== "first" && one.name !== "rest")) {
    refuse("damaged", "a picture or a file says it is compressed");
  }
  if (!partsInOrder(manifest)) refuse("damaged", "its parts are out of their order");
};

const verified = async (key: Bytes, signature: Bytes, ...signed: Bytes[]): Promise<boolean> => {
  const held = await crypto.subtle.importKey("raw", key, "Ed25519", false, ["verify"]);
  return crypto.subtle.verify("Ed25519", held, signature, joined(...signed));
};

const secondsOf = (moment: string): Bytes => bigEndian(Date.parse(moment) / 1000);

const certified = ({ root, machine, certificate, since }: Signature | Owner): Promise<boolean> => {
  const rootKey = fromBase64Url(root);
  return verified(
    rootKey,
    fromBase64Url(certificate),
    words("tisty-share.certificate.v1\0"),
    rootKey,
    fromBase64Url(machine),
    secondsOf(since),
  );
};

const holdsSignature = async (signature: Signature, manifestBytes: Bytes, index: Bytes): Promise<void> => {
  const amiss = check("signature", signature);
  if (amiss.length > 0) refuse("unsigned", `its signature: ${amiss[0]}`);
  const root = fromBase64Url(signature.root);
  const machine = fromBase64Url(signature.machine);
  if (!(await certified(signature))) refuse("unsigned", "its root does not answer for its machine");
  const about = words("envelope");
  const signed = await verified(
    machine,
    fromBase64Url(signature.signed),
    words("tisty-share.signed.v1\0"),
    root,
    machine,
    bigEndian(about.length),
    about,
    await sha256(manifestBytes),
    index,
  );
  if (!signed) refuse("unsigned", "its machine did not sign it");
};

const NO_PERMIT = new Uint8Array(32);

// The one rule of who may sign a version: its owner, or whoever holds the token its owner allowed (decision 145).
const holdsOwner = async (
  { id, owner }: Envelope,
  signature: Signature,
  manifestBytes: Bytes,
  index: Bytes,
): Promise<void> => {
  const { root, machine, permit, name_tag: nameTag, signed } = owner as Owner;
  if (!(await certified(owner as Owner))) refuse("unsigned", "its owner's root does not answer for its machine");
  const about = words("owner");
  const idBytes = words(id);
  const permitKey = permit ? fromBase64Url(permit) : NO_PERMIT;
  const owned = await verified(
    fromBase64Url(machine),
    fromBase64Url(signed),
    words("tisty-share.signed.v1\0"),
    fromBase64Url(root),
    fromBase64Url(machine),
    bigEndian(about.length),
    about,
    bigEndian(idBytes.length),
    idBytes,
    permitKey,
    fromBase64Url(nameTag),
  );
  if (!owned) refuse("unsigned", "its owner did not sign who owns it");
  if (root === signature.root) return;
  if (!permit || !signature.permit_signed) return refuse("unsigned", "another root needs its owner's permit");
  const allowed = await verified(
    permitKey,
    fromBase64Url(signature.permit_signed),
    words("tisty-share.permit.v1\0"),
    fromBase64Url(signature.root),
    fromBase64Url(signature.machine),
    await sha256(manifestBytes),
    index,
  );
  if (!allowed) refuse("unsigned", "its token did not sign it");
};

const readBytes = async (bytes: Bytes, asked: Asked): Promise<ReadEnvelope> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = MARK.length;
  if (!sameBytes(bytes.subarray(0, at), MARK)) refuse("damaged", "it does not carry the mark");
  const piece = (size: number): Bytes => {
    if (at + size > bytes.length) refuse("damaged", "it is shorter than it says");
    at += size;
    return bytes.subarray(at - size, at);
  };
  const sized = (atMost: number, what: string): Bytes => {
    const size = view.getUint32(at);
    at += LENGTH_BYTES;
    if (size > atMost) refuse("damaged", `its ${what} is past its size`);
    return piece(size);
  };

  const manifestBytes = sized(MANIFEST_BYTES_AT_MOST, "manifest");
  const manifest = jsonIn<Envelope>(manifestBytes);
  weighVersion(manifest?.contract);
  return toldApart(manifest.contract, async () => {
    holdsManifest(manifest, asked);
    const signature = jsonIn<Signature>(sized(SIGNATURE_BYTES_AT_MOST, "signature"));
    const index = piece(HASH_BYTES * manifest.parts.length);
    await holdsSignature(signature, manifestBytes, index);
    if (manifest.sealed) await holdsOwner(manifest, signature, manifestBytes, index);

    const parts: Bytes[] = [];
    for (const [number, part] of manifest.parts.entries()) {
      const travelled = piece(part.sealed_size);
      const said = index.subarray(HASH_BYTES * number, HASH_BYTES * (number + 1));
      if (!sameBytes(await sha256(travelled), said)) refuse("damaged", "a part is not what it signed");
      parts.push(travelled);
    }
    if (at !== bytes.length) refuse("damaged", "something follows its parts");
    return { manifest, manifestBytes, signature, index, parts };
  });
};

// Anything else that breaks here comes from what arrived, so it is the envelope that is damaged.
export const asRefusal = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof EnvelopeRefused) throw error;
    return refuse("damaged", String(error));
  }
};

// All the server can check, with nothing open (decisions 34 and 135). The page checks it again.
export const readEnvelope = (bytes: Bytes, asked: Asked): Promise<ReadEnvelope> =>
  asRefusal(() => readBytes(bytes, asked));

export const revocationHolds = async (said: {
  root: string;
  machine: string;
  at: string;
  signed: string;
}): Promise<boolean> => {
  const root = fromBase64Url(said.root);
  return verified(
    root,
    fromBase64Url(said.signed),
    words("tisty-share.revocation.v1\0"),
    root,
    fromBase64Url(said.machine),
    secondsOf(said.at),
  );
};
