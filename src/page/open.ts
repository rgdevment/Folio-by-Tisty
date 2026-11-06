import type { Document, Picture } from "@tisty/contracts";
import { check, checkHtml, picturesIn, referencesIn } from "@tisty/contracts/check";
import { type Bytes, bigEndian, fromBase64Url, joined, sameBytes, sha256, words } from "../core/bytes";
import { type Asked, asRefusal, jsonIn, type ReadEnvelope, readEnvelope, refuse, toldApart } from "../rules/envelope";

export interface OpenEnvelope extends ReadEnvelope {
  opened: Bytes[];
}

// This reader's own limit: a manifest only says how much will come, and six pages at their tops fit well under it.
const OPENS_AT_MOST = 32 * 1024 * 1024;
const NONCE_BYTES = 12;
const NONCE_NUMBER_AT = 8;

const inflated = async (bytes: Bytes, size: number): Promise<Bytes> => {
  if (size > OPENS_AT_MOST) refuse("damaged", "it says more than this reader holds");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  // Nothing set aside by what the manifest says, and stopped as soon as it passes: a bomb costs only what it gave so far.
  const pieces: Bytes[] = [];
  let held = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    held += value.length;
    if (held > size) {
      await reader.cancel();
      refuse("damaged", "a part gives more than it says");
    }
    pieces.push(value as Bytes);
  }
  if (held !== size) refuse("damaged", "a part gives less than it says");
  return joined(...pieces);
};

const macHolds = async (linkKey: Bytes, mac: string, ...said: Bytes[]): Promise<boolean> => {
  const held = await crypto.subtle.importKey("raw", linkKey, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", held, fromBase64Url(mac), joined(...said));
};

const envelopeKey = async ({ head, commitment }: ReadEnvelope["manifest"], linkKey: Bytes): Promise<CryptoKey> => {
  const salt = fromBase64Url(head as string);
  const committed = await macHolds(linkKey, commitment as string, words("tisty-envelope-commit"), salt);
  if (!committed) refuse("key", "this link does not open it");
  const base = await crypto.subtle.importKey("raw", linkKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: words("tisty-envelope-key") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
};

const nonceOf = (number: number): Bytes => {
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setUint32(NONCE_NUMBER_AT, number);
  return nonce;
};

const ownerNameHolds = async ({ id, owner }: ReadEnvelope["manifest"], first: Bytes, linkKey: Bytes): Promise<void> => {
  const idBytes = words(id);
  const { owner_name: name = "" } = jsonIn<{ owner_name?: string }>(first);
  const answers = await macHolds(
    linkKey,
    owner?.name_tag as string,
    words("tisty-owner-name\0"),
    bigEndian(idBytes.length),
    idBytes,
    words(name),
  );
  if (!answers) refuse("damaged", "its owner's name is not the one its owner signed");
};

const openingRead = async (read: ReadEnvelope, asked: Asked, linkKey?: Bytes): Promise<OpenEnvelope> => {
  const { manifest, manifestBytes, parts } = read;
  if (linkKey && !manifest.sealed) refuse("damaged", "a key answers only for what is sealed");
  if (manifest.sealed && !linkKey) refuse("key", "it is sealed, and this link brings no key");
  const key = manifest.sealed ? await envelopeKey(manifest, linkKey as Bytes) : null;

  const opened: Bytes[] = [];
  for (const [number, part] of manifest.parts.entries()) {
    const travelled = parts[number] as Bytes;
    const held = key
      ? new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonceOf(number), additionalData: manifestBytes },
            key,
            travelled,
          ),
        )
      : travelled;
    if (!part.compressed && held.length !== part.open_size) refuse("damaged", "a part is not the size it says");
    opened.push(part.compressed ? await inflated(held, part.open_size) : held);
  }
  if (manifest.sealed && asked.kind === "main") {
    await ownerNameHolds(manifest, opened[0] as Bytes, linkKey as Bytes);
  }
  return { ...read, opened };
};

const opening = async (bytes: Bytes, asked: Asked, linkKey?: Bytes): Promise<OpenEnvelope> => {
  const read = await readEnvelope(bytes, asked);
  return toldApart(read.manifest.contract, () => openingRead(read, asked, linkKey));
};

export const openEnvelope = (bytes: Bytes, asked: Asked, linkKey?: Bytes): Promise<OpenEnvelope> =>
  asRefusal(() => opening(bytes, asked, linkKey));

const atsOf = (list: { at: number }[] | undefined): number[] => (list ?? []).map((one) => one.at);

const holdsHtml = (held: Document, pictures: Picture[], html: string): void => {
  const amiss = checkHtml(html);
  if (amiss.length > 0) refuse("damaged", `its HTML: ${amiss[0]}`);
  const there: Record<string, number[]> = {
    page: atsOf(held.pages),
    picture: atsOf(pictures),
    file: atsOf(held.files),
    cited: (held.cited ?? []).map((_, at) => at),
  };
  for (const { kind, at } of referencesIn(html)) {
    if (!there[kind]?.includes(at)) refuse("damaged", `tisty:${kind}/${at} is not there`);
  }
  for (const { at, width, height } of picturesIn(html)) {
    const picture = pictures[at];
    if (width !== String(picture?.width) || height !== String(picture?.height)) {
      refuse("damaged", "a picture is drawn at another size than its own");
    }
  }
};

const documentFrom = ({ manifest, opened }: OpenEnvelope): Document => {
  const first = jsonIn<Record<string, unknown>>(opened[0] as Bytes);
  const rest = jsonIn<Record<string, unknown>>(opened[1] as Bytes);
  if ("body" in first || "pages" in first) refuse("damaged", "the first part holds more than it should");
  if (Object.keys(rest).some((one) => Object.hasOwn(first, one))) refuse("damaged", "the rest repeats the first part");
  const { body, pages: restPages } = rest;
  const held = {
    ...first,
    ...(body === undefined ? {} : { body }),
    ...(restPages === undefined ? {} : { pages: restPages }),
  } as unknown as Document;
  const amiss = check("document", held);
  if (amiss.length > 0) refuse("damaged", `its document: ${amiss[0]}`);
  if (held.id !== manifest.id) refuse("damaged", "the document inside is another");
  if (!manifest.sealed && held.owner_name !== undefined) refuse("damaged", "nothing answers for this owner's name");

  const pictures = held.pictures ?? [];
  if (pictures.length !== opened.length - 2) refuse("damaged", "it holds another number of pictures");
  pictures.forEach((one, at) => {
    if (one.at !== at || one.size !== opened[at + 2]?.length) refuse("damaged", "a picture is not what it says");
  });
  const pages = held.pages ?? [];
  if (pages.some((one) => one.page_of !== held.id)) refuse("damaged", "a page is of another document");
  if (pages.some((one, at) => at > 0 && (pages[at - 1] as { at: number }).at >= one.at)) {
    refuse("damaged", "its pages are out of their order");
  }
  if (new Set(pages.map((one) => one.id)).size !== pages.length) refuse("damaged", "two pages share an id");
  if ((held.files ?? []).length > 0 !== (held.files_hash != null)) {
    refuse("damaged", "files and the hash that answers for them go together");
  }
  for (const html of [held.html, ...pages.map((one) => one.html)]) holdsHtml(held, pictures, html);
  return held;
};

// Everything only a reader can check: a writer's word counts for nothing, so its words are not shown if this fails.
export const documentIn = (open: OpenEnvelope): Promise<Document> =>
  asRefusal(() => toldApart(open.manifest.contract, async () => documentFrom(open)));

export const openFiles = (held: Document, bytes: Bytes, asked: Asked, linkKey?: Bytes): Promise<OpenEnvelope> =>
  asRefusal(async () => {
    const files = await opening(bytes, asked, linkKey);
    return toldApart(files.manifest.contract, async () => {
      const hash = await sha256(files.manifestBytes, files.index);
      if (!held.files_hash || !sameBytes(hash, fromBase64Url(held.files_hash))) {
        refuse("damaged", "it is not the envelope its document answers for");
      }
      const said = held.files ?? [];
      if (said.length !== files.opened.length) refuse("damaged", "it holds another number of files");
      said.forEach((one, at) => {
        if (one.at !== at || (one.size !== undefined && one.size !== files.opened[at]?.length)) {
          refuse("damaged", "a file is not what it says");
        }
      });
      return files;
    });
  });

const PNG_MARK = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const pngHolds = (bytes: Bytes, view: DataView, { width, height }: Picture): boolean => {
  if (!PNG_MARK.every((byte, at) => bytes[at] === byte)) return false;
  let said: number[] | null = null;
  for (let at = PNG_MARK.length; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (at === PNG_MARK.length && name === "IHDR" && length >= 8 && at + 16 <= bytes.length) {
      said = [view.getUint32(at + 8), view.getUint32(at + 12)];
    }
    at += 12 + length;
    if (name === "IEND") return at === bytes.length && said?.[0] === width && said?.[1] === height;
  }
  return false;
};

const jpegSizeMark = (mark: number): boolean => mark >= 0xc0 && mark <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mark);

const jpegHolds = (bytes: Bytes, view: DataView, { width, height }: Picture): boolean => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
  let said: number[] | null = null;
  for (let at = 2; at + 1 < bytes.length; ) {
    const mark = bytes[at + 1] as number;
    if (bytes[at] !== 0xff || mark === 0xff) at += 1;
    else if (mark === 0xd9) return at + 2 === bytes.length && said?.[0] === width && said?.[1] === height;
    else if (mark === 0 || mark === 1 || (mark >= 0xd0 && mark <= 0xd8)) at += 2;
    else {
      if (at + 4 > bytes.length) return false;
      if (jpegSizeMark(mark) && at + 9 <= bytes.length) said = [view.getUint16(at + 7), view.getUint16(at + 5)];
      at += 2 + view.getUint16(at + 2);
    }
  }
  return false;
};

// What the page looks at before it draws one. One that fails shows its alt, and the words still read.
export const pictureHolds = (bytes: Bytes, picture: Picture): boolean => {
  if (bytes.length !== picture.size) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return picture.kind === "image/png" ? pngHolds(bytes, view, picture) : jpegHolds(bytes, view, picture);
};
