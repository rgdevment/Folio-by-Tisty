import { type Bytes, fromBase64Url, joined, words } from "./bytes";
import { toBase64Url } from "./start";

const PREFIX = "case1.";
const IV_BYTES = 12;
const SEALED_AT_MOST = 1_000_000;
const CASE_NAMED_BY = 8;
const SEALED_BODY = /^[A-Za-z0-9_-]+$/;

const keyOf = (raw: Bytes, use: "encrypt" | "decrypt"): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);

export const caseNameOf = (hash: string): string => hash.slice(0, CASE_NAMED_BY);

export const isSealedRecords = (said: unknown): said is string =>
  typeof said === "string" &&
  said.length <= SEALED_AT_MOST &&
  said.startsWith(PREFIX) &&
  SEALED_BODY.test(said.slice(PREFIX.length));

export const sealRecords = async (records: string, raw: Bytes): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(raw, "encrypt"), words(records));
  return `${PREFIX}${toBase64Url(joined(iv, new Uint8Array(sealed)))}`;
};

export const openRecords = async (sealed: string, raw: Bytes): Promise<string> => {
  const bytes = fromBase64Url(sealed.slice(PREFIX.length));
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) },
    await keyOf(raw, "decrypt"),
    bytes.subarray(IV_BYTES),
  );
  return new TextDecoder().decode(opened);
};
