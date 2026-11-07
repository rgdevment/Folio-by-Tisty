import { sealRecords } from "../../core/case-records";
import { toBase64Url, tokenHash } from "../../core/start";

const READER = "https://tisty.cl";
const RANDOM_BYTES = 32;

const random = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));

export interface MadeCase {
  link: string;
  body: { version: number; tokenHash: string; sealedRecords?: string };
}

// Made here so the panel's Worker only ever holds a hash and what it cannot open.
export const madeCase = async (id: string, version: number, records?: unknown): Promise<MadeCase> => {
  const token = toBase64Url(random());
  const hash = await tokenHash(token);
  if (records === undefined) {
    return { link: `${READER}/${id}#caso.${token}`, body: { version, tokenHash: hash } };
  }
  const key = random();
  return {
    link: `${READER}/${id}#caso.${token}.${toBase64Url(key)}`,
    body: { version, tokenHash: hash, sealedRecords: await sealRecords(JSON.stringify(records, null, 2), key) },
  };
};
