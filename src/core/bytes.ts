export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

export const words = (said: string): Bytes => encoder.encode(said) as Bytes;

export const fromBase64Url = (said: string): Bytes => {
  const plain = atob(said.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(plain, (one) => one.charCodeAt(0));
};

export const joined = (...pieces: Bytes[]): Bytes => {
  const out = new Uint8Array(pieces.reduce((sum, one) => sum + one.length, 0));
  let at = 0;
  for (const one of pieces) {
    out.set(one, at);
    at += one.length;
  }
  return out;
};

export const sameBytes = (one: Bytes, other: Bytes): boolean =>
  one.length === other.length && one.every((byte, at) => byte === other[at]);

export const sha256 = async (...pieces: Bytes[]): Promise<Bytes> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", joined(...pieces)));

export const bigEndian = (number: number): Bytes => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(number));
  return out;
};
