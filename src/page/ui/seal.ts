import { fromBase64Url, joined, words } from "../../core/bytes";
import { SEALED_LINK_PREFIX } from "../../core/sealed-link";
import { toBase64Url } from "../../core/start";

const NONCE_BYTES = 12;

// Only the operator's private key opens it, and that key is not in Cloudflare (decision 42).
export const sealLink = async (id: string, linkKey: string, operatorKey: string): Promise<string> => {
  const operator = fromBase64Url(operatorKey);
  const pair = (await crypto.subtle.generateKey("X25519", false, ["deriveBits"])) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: await crypto.subtle.importKey("raw", operator, "X25519", false, []) },
    pair.privateKey,
    256,
  );
  const ephemeral = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: joined(ephemeral, operator), info: words("folio.report-link.v1") },
    await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: words(id) },
    key,
    words(`${id}#${linkKey}`),
  );
  return `${SEALED_LINK_PREFIX}${toBase64Url(joined(ephemeral, nonce, new Uint8Array(sealed)))}`;
};
