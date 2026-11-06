// What a client asks for before its first upload, and what a proof of work is bound to. Nothing here is stored.
const HOUR_MS = 3_600_000;
const ID_LENGTH = 8;
const ID_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const encoder = new TextEncoder();

export const toBase64Url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

export const macOf = async (secret: string, said: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(said)));
};

export const sameText = (one: string, other: string): boolean => {
  if (one.length !== other.length) return false;
  let differs = 0;
  for (let at = 0; at < one.length; at += 1) differs |= one.charCodeAt(at) ^ other.charCodeAt(at);
  return differs === 0;
};

export const hourOf = (ms: number): number => Math.floor(ms / HOUR_MS);

export const hourEnds = (ms: number): number => (hourOf(ms) + 1) * HOUR_MS;

export const tokenHash = async (token: string): Promise<string> =>
  toBase64Url(await crypto.subtle.digest("SHA-256", encoder.encode(token)));

const newId = (): string => {
  // Rejecting the top of the range keeps every letter equally likely.
  const fair = 256 - (256 % ID_LETTERS.length);
  let id = "";
  while (id.length < ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2))) {
      if (byte < fair && id.length < ID_LENGTH) id += ID_LETTERS[byte % ID_LETTERS.length];
    }
  }
  return id;
};

export interface Start {
  id: string;
  mac: string;
  salt: string;
}

export const saltFor = (secret: string, scope: string, hour: number): Promise<string> =>
  macOf(secret, `salt|${scope}|${hour}`);

export const startNow = async (secret: string, now: number): Promise<Start> => {
  const id = newId();
  const hour = hourOf(now);
  return { id, mac: await macOf(secret, `start|${id}|${hour}`), salt: await saltFor(secret, id, hour) };
};

// The hour before counts too, or a start asked for at the end of an hour would fail a minute later.
export const startHolds = async (secret: string, id: string, mac: string, now: number): Promise<boolean> => {
  const hour = hourOf(now);
  for (const one of [hour, hour - 1]) {
    if (sameText(await macOf(secret, `start|${id}|${one}`), mac)) return true;
  }
  return false;
};

// Only the salt and the nonce: the salt is bound to what is being done, and it is all that whoever solves it is told.
export const proofHolds = async (salt: string, nonce: string, bits: number): Promise<boolean> => {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}|${nonce}`)));
  let left = bits;
  for (const byte of hash) {
    if (left <= 0) return true;
    const needed = Math.min(left, 8);
    if (byte >> (8 - needed) !== 0) return false;
    left -= needed;
  }
  return left <= 0;
};

export const solveProof = async (salt: string, bits: number): Promise<string> => {
  for (let nonce = 0; ; nonce += 1) {
    if (await proofHolds(salt, String(nonce), bits)) return String(nonce);
  }
};

// The hour before counts too, as with a start: a proof solved at the end of an hour still holds a minute later.
export const proofIsFresh = async (
  secret: string,
  scope: string,
  nonce: string,
  bits: number,
  now: number,
): Promise<boolean> => {
  const hour = hourOf(now);
  for (const one of [hour, hour - 1]) {
    if (await proofHolds(await saltFor(secret, scope, one), nonce, bits)) return true;
  }
  return false;
};
