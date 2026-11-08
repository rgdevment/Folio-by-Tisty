import { beforeAll, describe, expect, it, vi } from "vitest";
import { type AccessSettings, type Certs, certsFrom, isOperator, issuerOf } from "../src/admin/access";
import { toBase64Url } from "../src/core/start";

describe("Access, and the keys it signs with", () => {
  const ACCESS: AccessSettings = { team: "rina", audience: "the-panel", email: "mario@example.test" };
  const NOW = Date.UTC(2026, 10, 8, 12);
  const b64 = (said: unknown): string => toBase64Url(new TextEncoder().encode(JSON.stringify(said)));
  let one: CryptoKeyPair;
  let two: CryptoKeyPair;
  let jwkOne: JsonWebKey;
  let jwkTwo: JsonWebKey;

  const generate = () =>
    crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;

  beforeAll(async () => {
    one = await generate();
    two = await generate();
    jwkOne = (await crypto.subtle.exportKey("jwk", one.publicKey)) as JsonWebKey;
    jwkTwo = (await crypto.subtle.exportKey("jwk", two.publicKey)) as JsonWebKey;
  });

  const tokenBy = async (signer: CryptoKey, header: object = {}, over: Record<string, unknown> = {}) => {
    const body = `${b64({ alg: "RS256", kid: "one", ...header })}.${b64({
      iss: issuerOf(ACCESS.team),
      aud: [ACCESS.audience],
      email: ACCESS.email,
      exp: NOW / 1000 + 60,
      ...over,
    })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(body));
    return `${body}.${toBase64Url(signature)}`;
  };

  const published = (cached: string[], fresh: string[]) => {
    const calls: boolean[] = [];
    const certs: Certs = async (asking = false) => {
      calls.push(asking);
      const kids = asking ? fresh : cached;
      return kids.map((kid) => ({ ...(kid === "two" ? jwkTwo : jwkOne), kid }) as JsonWebKey);
    };
    return { certs, calls };
  };

  it("asks again, fresh, when the kept certificates lack the key's id, and takes what it brings", async () => {
    const { certs, calls } = published(["one"], ["one", "two"]);
    expect(await isOperator(await tokenBy(two.privateKey, { kid: "two" }), ACCESS, certs, NOW)).toBe(true);
    expect(calls).toEqual([false, true]);
  });

  it("asks once when the kept ones have it", async () => {
    const { certs, calls } = published(["one"], ["one"]);
    expect(await isOperator(await tokenBy(one.privateKey), ACCESS, certs, NOW)).toBe(true);
    expect(calls).toEqual([false]);
  });

  it("does not ask again for a token whose key is known but whose signature is not", async () => {
    const { certs, calls } = published(["one"], ["one"]);
    expect(await isOperator(await tokenBy(two.privateKey), ACCESS, certs, NOW)).toBe(false);
    expect(calls).toEqual([false]);
  });

  it("asks twice and no more for a key id nobody publishes", async () => {
    const { certs, calls } = published(["one"], ["one"]);
    expect(await isOperator(await tokenBy(two.privateKey, { kid: "zzz" }), ACCESS, certs, NOW)).toBe(false);
    expect(calls).toEqual([false, true]);
  });

  it.each([
    ["another address", { email: "ana@example.test" }],
    ["another audience", { aud: ["x"] }],
    ["another issuer", { iss: "https://x.cloudflareaccess.com" }],
    ["one that expired", { exp: NOW / 1000 - 1 }],
    ["one that expires at this very second", { exp: NOW / 1000 }],
    ["one not yet valid", { nbf: NOW / 1000 + 1 }],
  ])("asks Access for nothing when the claims already refuse it (%s)", async (_what, over) => {
    const { certs, calls } = published(["one"], ["one"]);
    expect(await isOperator(await tokenBy(two.privateKey, { kid: "zzz" }, over), ACCESS, certs, NOW)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not ask Access again for what is not a token", async () => {
    const { certs, calls } = published([], []);
    for (const token of ["", "a.b", "a.b.c", "....", "e30.e30.e30", `${b64({ alg: "RS256", kid: "x" })}.${b64({})}.`])
      expect(await isOperator(token, ACCESS, certs, NOW)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses, and does not throw, when Access cannot be asked, at either asking", async () => {
    const down: Certs = async () => {
      throw new Error("Access answered 503");
    };
    expect(await isOperator(await tokenBy(one.privateKey), ACCESS, down, NOW)).toBe(false);
    const freshDown: Certs = async (asking) => {
      if (asking) throw new Error("Access answered 503");
      return [{ ...jwkOne, kid: "one" } as JsonWebKey];
    };
    expect(await isOperator(await tokenBy(two.privateKey, { kid: "two" }), ACCESS, freshDown, NOW)).toBe(false);
    expect(await isOperator(await tokenBy(one.privateKey), ACCESS, freshDown, NOW)).toBe(true);
  });

  it("refuses a list without keys, and one that is not a list", async () => {
    const empty: Certs = async () => [];
    const odd: Certs = async () => undefined as unknown as JsonWebKey[];
    expect(await isOperator(await tokenBy(one.privateKey), ACCESS, empty, NOW)).toBe(false);
    expect(await isOperator(await tokenBy(one.privateKey), ACCESS, odd, NOW)).toBe(false);
  });

  it("refuses an algorithm that is not RS256 and a token with no key id against keys that have one", async () => {
    const { certs } = published(["one"], ["one"]);
    expect(await isOperator(await tokenBy(one.privateKey, { alg: "HS256" }), ACCESS, certs, NOW)).toBe(false);
    expect(await isOperator(await tokenBy(one.privateKey, { alg: "none" }), ACCESS, certs, NOW)).toBe(false);
    expect(await isOperator(await tokenBy(one.privateKey, { kid: undefined }), ACCESS, certs, NOW)).toBe(false);
  });

  it("asks Access fresh once per forged token that carries the right claims, with nothing to slow it down", async () => {
    const { certs, calls } = published(["one"], ["one"]);
    const forged = await tokenBy(two.privateKey, { kid: "zzz" });
    for (let at = 0; at < 20; at += 1) await isOperator(forged, ACCESS, certs, NOW);
    expect(calls.filter(Boolean)).toHaveLength(20);
  });

  describe("how the certificates are fetched", () => {
    const answer = (keys: JsonWebKey[], status = 200) => new Response(JSON.stringify({ keys }), { status });

    it("lets the edge keep them ten minutes, and asks without any cache when told to", async () => {
      const fetcher = vi.fn(async (_url: unknown, _init?: unknown) => answer([jwkOne]));
      const certs = certsFrom("rina", fetcher as unknown as typeof fetch);
      await certs();
      await certs(true);
      expect(fetcher.mock.calls[0]).toEqual([
        "https://rina.cloudflareaccess.com/cdn-cgi/access/certs",
        { cf: { cacheTtl: 600, cacheEverything: true } },
      ]);
      expect(fetcher.mock.calls[1]).toEqual([
        "https://rina.cloudflareaccess.com/cdn-cgi/access/certs",
        { cache: "no-store" },
      ]);
    });

    it("throws on an answer that is not ok, so the operator is refused rather than let in", async () => {
      const certs = certsFrom("rina", (async () => answer([], 503)) as unknown as typeof fetch);
      await expect(certs()).rejects.toThrow("Access answered 503");
      expect(await isOperator(await tokenBy(one.privateKey), ACCESS, certs, NOW)).toBe(false);
    });

    it("works end to end with a rotation: the first list lacks the key, the fresh one has it", async () => {
      const fetcher = vi.fn(async (_url: unknown, init?: { cache?: string }) =>
        init?.cache === "no-store"
          ? answer([{ ...jwkTwo, kid: "two" } as JsonWebKey])
          : answer([{ ...jwkOne, kid: "one" } as JsonWebKey]),
      );
      const certs = certsFrom("rina", fetcher as unknown as typeof fetch);
      expect(await isOperator(await tokenBy(two.privateKey, { kid: "two" }), ACCESS, certs, NOW)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
});
