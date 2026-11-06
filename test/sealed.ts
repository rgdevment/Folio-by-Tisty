import { VERSION } from "@tisty/contracts";
import { type Bytes, bigEndian, joined, sha256, words } from "../src/core/bytes";
import { toBase64Url } from "../src/core/start";
import { readEnvelope } from "../src/rules/envelope";

const generate = async () => (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const raw = async (key: CryptoKey) => new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
const signedBy = async (key: CryptoKey, ...pieces: Bytes[]) =>
  new Uint8Array(await crypto.subtle.sign("Ed25519", key, joined(...pieces)));
const BIGGEST_RANDOM = 65_536;
const random = (size: number): Bytes => {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out.subarray(0, Math.min(size, BIGGEST_RANDOM)));
  return out;
};
const b64 = (bytes: Uint8Array): string => toBase64Url(bytes);

const lengthOf = (size: number): Bytes => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, size);
  return out;
};

const SINCE = "2026-11-03T12:00:00Z";

export interface Person {
  root: CryptoKeyPair;
  machine: CryptoKeyPair;
  rootBytes: Bytes;
  machineBytes: Bytes;
  certificate: Bytes;
}

export const newPerson = async (): Promise<Person> => {
  const root = await generate();
  const machine = await generate();
  const rootBytes = await raw(root.publicKey);
  const machineBytes = await raw(machine.publicKey);
  const since = bigEndian(Date.parse(SINCE) / 1000);
  const certificate = await signedBy(
    root.privateKey,
    words("tisty-share.certificate.v1\0"),
    rootBytes,
    machineBytes,
    since,
  );
  return { root, machine, rootBytes, machineBytes, certificate };
};

export const newToken = async (): Promise<{ pair: CryptoKeyPair; permit: string }> => {
  const pair = await generate();
  return { pair, permit: b64(await raw(pair.publicKey)) };
};

export const rootOf = ({ rootBytes }: Person): string => b64(rootBytes);

export const machineOf = ({ machineBytes }: Person): string => b64(machineBytes);

export const revocationBy = async ({ root, rootBytes, machineBytes }: Person, at: string) => ({
  root: b64(rootBytes),
  machine: b64(machineBytes),
  at,
  signed: b64(
    await signedBy(
      root.privateKey,
      words("tisty-share.revocation.v1\0"),
      rootBytes,
      machineBytes,
      bigEndian(Date.parse(at) / 1000),
    ),
  ),
});

interface Sealing {
  id: string;
  version: number;
  owner: Person;
  signer?: Person;
  permit?: string;
  token?: CryptoKeyPair;
  nameTag?: Bytes;
  contract?: string;
  pictures?: number[];
  firstBytes?: number;
  from?: number;
  files?: number[];
}

const ownerBlock = async ({ id, owner, permit, nameTag = new Uint8Array(32).fill(7) }: Sealing) => {
  const about = words("owner");
  const idBytes = words(id);
  const permitBytes = permit
    ? (Uint8Array.from(atob(permit.replaceAll("-", "+").replaceAll("_", "/")), (one) => one.charCodeAt(0)) as Bytes)
    : new Uint8Array(32);
  const signed = await signedBy(
    owner.machine.privateKey,
    words("tisty-share.signed.v1\0"),
    owner.rootBytes,
    owner.machineBytes,
    bigEndian(about.length),
    about,
    bigEndian(idBytes.length),
    idBytes,
    permitBytes,
    nameTag,
  );
  return {
    root: b64(owner.rootBytes),
    machine: b64(owner.machineBytes),
    since: SINCE,
    certificate: b64(owner.certificate),
    ...(permit ? { permit } : {}),
    name_tag: b64(nameTag),
    signed: b64(signed),
  };
};

// What a server can check of a sealed envelope: its parts here are only bytes, since it never opens them.
export const sealedEnvelope = async (sealing: Sealing): Promise<Bytes> => {
  const {
    id,
    version,
    owner,
    signer = owner,
    token,
    contract = VERSION,
    pictures = [],
    firstBytes = 16,
    from,
    files,
  } = sealing;
  const sizes: [string, boolean, number][] = files
    ? files.map((size) => ["file", false, size])
    : [
        ["first", true, firstBytes],
        ["rest", true, 16],
        ...pictures.map((size): [string, boolean, number] => ["picture", false, size]),
      ];
  const travelling = sizes.map(([, , size]) => random(size));
  const manifest = {
    contract,
    kind: files ? "files" : "main",
    id,
    version,
    ...(from === undefined ? {} : { from }),
    sealed: true,
    head: b64(random(32)),
    commitment: b64(random(32)),
    owner: await ownerBlock(sealing),
    parts: sizes.map(([name, compressed, size]) => ({ name, compressed, sealed_size: size, open_size: size })),
  };
  const manifestBytes = words(JSON.stringify(manifest));
  const hashes = await Promise.all(travelling.map((one) => sha256(one)));
  const index = joined(...hashes);
  const about = words("envelope");
  const digest = await sha256(manifestBytes);
  const signed = await signedBy(
    signer.machine.privateKey,
    words("tisty-share.signed.v1\0"),
    signer.rootBytes,
    signer.machineBytes,
    bigEndian(about.length),
    about,
    digest,
    index,
  );
  const permitSigned = token
    ? await signedBy(
        token.privateKey,
        words("tisty-share.permit.v1\0"),
        signer.rootBytes,
        signer.machineBytes,
        digest,
        index,
      )
    : null;
  const signature = words(
    JSON.stringify({
      root: b64(signer.rootBytes),
      machine: b64(signer.machineBytes),
      since: SINCE,
      certificate: b64(signer.certificate),
      signed: b64(signed),
      ...(permitSigned ? { permit_signed: b64(permitSigned) } : {}),
    }),
  );
  return joined(
    words("TENV"),
    lengthOf(manifestBytes.length),
    manifestBytes,
    lengthOf(signature.length),
    signature,
    index,
    ...travelling,
  );
};

export const filesHashOf = async (id: string, bytes: Bytes): Promise<string> => {
  const { manifestBytes, index } = await readEnvelope(bytes, { id, kind: "files" });
  return b64(await sha256(manifestBytes, index));
};

export const SIGNED_BY_THE_OWNER = {
  signer: "o1",
  machine: "m1",
  contract: VERSION,
  byOwner: true,
  permit: null,
  ownerMark: "",
};
