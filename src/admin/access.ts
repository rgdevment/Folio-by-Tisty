import { fromBase64Url } from "../core/bytes";

export interface AccessSettings {
  team: string;
  audience: string;
  email: string;
}

export interface ReaderSettings {
  team: string;
  audience: string;
  clientId: string;
}

export type Certs = (fresh?: boolean) => Promise<JsonWebKey[]>;

interface Header {
  alg?: string;
  kid?: string;
}

interface Claims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
  sub?: string;
  common_name?: string;
}

const CERTS_KEPT_SECONDS = 600;
const decoder = new TextDecoder();
const jsonOf = <T>(part: string): T => JSON.parse(decoder.decode(fromBase64Url(part))) as T;

export const issuerOf = (team: string): string => `https://${team}.cloudflareaccess.com`;

export const certsFrom =
  (team: string, fetcher: typeof fetch = fetch): Certs =>
  async (fresh = false) => {
    // Kept at the edge for a while, since every panel load makes several calls; a key it does not know asks again.
    const response = await fetcher(
      `${issuerOf(team)}/cdn-cgi/access/certs`,
      fresh ? { cache: "no-store" } : { cf: { cacheTtl: CERTS_KEPT_SECONDS, cacheEverything: true } },
    );
    if (!response.ok) throw new Error(`Access answered ${response.status}`);
    return ((await response.json()) as { keys: JsonWebKey[] }).keys;
  };

const signatureHolds = async (token: string, header: Header, certs: Certs): Promise<boolean> => {
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature || header.alg !== "RS256") return false;
  const ofKid = (keys: JsonWebKey[]) => keys.find((one) => (one as JsonWebKey & { kid?: string }).kid === header.kid);
  const cert = ofKid(await certs()) ?? ofKid(await certs(true));
  if (!cert) return false;
  const key = await crypto.subtle.importKey("jwk", cert, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(`${head}.${body}`),
  );
};

const signedFor = async (
  token: string | null,
  team: string,
  audience: string,
  certs: Certs,
  now: number,
  whose: (claims: Claims) => boolean,
): Promise<boolean> => {
  if (!token || !team || !audience) return false;
  try {
    const [head, body] = token.split(".");
    const header = jsonOf<Header>(head ?? "");
    const claims = jsonOf<Claims>(body ?? "");
    const seconds = now / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuerOf(team) || !audiences.includes(audience) || !whose(claims)) return false;
    if (typeof claims.exp !== "number" || claims.exp <= seconds) return false;
    if (typeof claims.nbf === "number" && claims.nbf > seconds) return false;
    return await signatureHolds(token, header, certs);
  } catch {
    return false;
  }
};

// Access stands in front, and this holds even if the route or the rule in Cloudflare is ever wrong.
export const isOperator = async (
  token: string | null,
  { team, audience, email }: AccessSettings,
  certs: Certs,
  now: number,
): Promise<boolean> => {
  if (!email) return false;
  return signedFor(token, team, audience, certs, now, (claims) => claims.email === email);
};

// A service token says its Client ID as common_name, with an empty sub and no address.
export const isReader = async (
  token: string | null,
  { team, audience, clientId }: ReaderSettings,
  certs: Certs,
  now: number,
): Promise<boolean> => {
  if (!clientId) return false;
  return signedFor(
    token,
    team,
    audience,
    certs,
    now,
    (claims) => claims.common_name === clientId && claims.sub === "" && claims.email === undefined,
  );
};
