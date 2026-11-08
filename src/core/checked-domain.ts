export const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
export const PROOF = /^[0-9a-f]{32}$/;
export const SHARD_BYTES_AT_MOST = 70_000;

const PROOF_CHARACTERS = 32;

export const proofOf = async (root: string, domain: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${root}${domain}`)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, PROOF_CHARACTERS);

export const shardOf = (proof: string): string => proof.slice(0, 2);
