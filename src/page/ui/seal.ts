import { fromBase64Url, joined, words } from "../../core/bytes";
import { SEALED_CONTACT_PREFIX, SEALED_LINK_PREFIX } from "../../core/sealed-link";
import { toBase64Url } from "../../core/start";

const NONCE_BYTES = 12;

// Only the operator's private key opens it, and that key is not in Cloudflare (decision 42).
const sealedFor = async (
  id: string,
  said: string,
  operatorKey: string,
  prefix: string,
  label: string,
): Promise<string> => {
  const operator = fromBase64Url(operatorKey);
  const pair = (await crypto.subtle.generateKey("X25519", false, ["deriveBits"])) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: await crypto.subtle.importKey("raw", operator, "X25519", false, []) },
    pair.privateKey,
    256,
  );
  const ephemeral = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: joined(ephemeral, operator), info: words(label) },
    await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: words(id) },
    key,
    words(said),
  );
  return `${prefix}${toBase64Url(joined(ephemeral, nonce, new Uint8Array(sealed)))}`;
};

export const sealLink = (id: string, linkKey: string, operatorKey: string): Promise<string> =>
  sealedFor(id, `${id}#${linkKey}`, operatorKey, SEALED_LINK_PREFIX, "folio.report-link.v1");

export const sealContact = (id: string, contact: string, operatorKey: string): Promise<string> =>
  sealedFor(id, contact, operatorKey, SEALED_CONTACT_PREFIX, "folio.report-contact.v1");
