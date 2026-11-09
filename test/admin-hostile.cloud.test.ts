import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AccessSettings, type Certs, isOperator, issuerOf } from "../src/admin/access";
import { answer } from "../src/admin/api";
import { CloudDashboard } from "../src/cloudflare/dashboard";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import { dayOf, LEVEL_ONE } from "../src/core/limits";
import { toBase64Url } from "../src/core/start";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const NOW = Date.UTC(2026, 10, 6, 12);
const TODAY = dayOf(NOW);
const HOUR = Math.floor(NOW / 3_600_000);
const ID = "AbCdEfGh";
const ACCESS: AccessSettings = { team: "rina", audience: "the-panel", email: "mario@example.test" };
// Many documents of one owner in one day, which the daily cap of new shares would otherwise stop.
const store = new Cloud(testEnv, { ...LEVEL_ONE, newSharesADay: 1000 });
const moderation = new CloudModeration(testEnv.DB);
const dashboard = new CloudDashboard(testEnv.DB);
const DIGEST = "A".repeat(43);

let keys: CryptoKeyPair;
let certs: Certs;

const b64 = (said: unknown): string => toBase64Url(new TextEncoder().encode(JSON.stringify(said)));

const token = async (exp = NOW / 1000 + 60): Promise<string> => {
  const body = `${b64({ alg: "RS256", kid: "one" })}.${b64({
    iss: issuerOf(ACCESS.team),
    aud: [ACCESS.audience],
    email: ACCESS.email,
    exp,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body));
  return `${body}.${toBase64Url(signature)}`;
};

const asked = async (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", await token());
  return answer(new Request(`https://panel.test${path}`, { ...init, headers }), {
    moderation,
    dashboard,
    about: { sharingOpen: true, termsVersion: "14", limitsSerial: 25 },
    access: ACCESS,
    certs,
    now: NOW,
  });
};

const post = (path: string, body?: unknown) =>
  asked(path, {
    method: "POST",
    headers: { "Folio-Operator": "1" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const share = async (id = ID, owner = "o1") => {
  await store.create({ id, owner, adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
  await store.upload(
    {
      id,
      n: 1,
      hash: "h1",
      body: "sealed",
      net: "n",
      at: NOW,
      signer: owner,
      machine: "m1",
      contract: "1.5.0",
      byOwner: true,
      permit: null,
      ownerMark: "m1.t",
    },
    TODAY,
  );
};

const count = async (table: string): Promise<number> =>
  (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const cert = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  certs = async () => [{ ...cert, kid: "one" } as JsonWebKey];
});

beforeEach(async () => {
  for (const table of ["docs", "keys", "cases", "reports", "false_reporters", "moderation", "openings", "net_day"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("hostile input to the admin API", () => {
  it("does not log an opening for a document that does not exist", async () => {
    const response = await post("/api/docs/ZzZzZzZz/opened", { note: "looked at it" });
    expect(response.status).toBe(404);
    expect(await count("openings")).toBe(0);
    expect((await (await asked("/api/log")).json()) as unknown[]).toEqual([]);
  });

  it("records an opening of a document that exists", async () => {
    await share();
    expect((await post(`/api/docs/${ID}/opened`, { note: "looked at it" })).status).toBe(200);
    expect(await count("openings")).toBe(1);
  });

  it.each([
    ["no body", undefined],
    ["not JSON", "{nope"],
    ["an array", "[1]"],
    ["null", "null"],
    ["a number note", { note: 5 }],
    ["only spaces", { note: "   \n\t " }],
    ["501 letters", { note: "x".repeat(501) }],
  ])("refuses a block with %s and changes nothing", async (_what, body) => {
    await share();
    const response = await post(`/api/docs/${ID}/block`, body);
    expect(response.status).toBe(400);
    expect(await count("moderation")).toBe(0);
    expect(
      (await testEnv.DB.prepare("SELECT blocked_at FROM docs").first<{ blocked_at: number | null }>())?.blocked_at,
    ).toBeNull();
  });

  it("takes a note of exactly 500 letters, and one padded with spaces to more", async () => {
    await share();
    expect((await post(`/api/docs/${ID}/panic`, { note: "x".repeat(500) })).status).toBe(200);
    await share("IjKlMnOp", "o2");
    expect((await post("/api/docs/IjKlMnOp/block", { note: `  ${"x".repeat(500)}  ` })).status).toBe(200);
  });

  it("blocks a document once, and answers the second time that there was nothing to do", async () => {
    await share();
    expect((await post(`/api/docs/${ID}/block`, { note: "a" })).status).toBe(200);
    expect((await post(`/api/docs/${ID}/block`, { note: "b" })).status).toBe(404);
    expect(await count("moderation")).toBe(1);
  });

  it.each(["panic", "block", "purge_owner"])("answers 404 to %s on a document that is not there", async (action) => {
    const response = await post(`/api/docs/ZzZzZzZz/${action}`, { note: "x" });
    expect(response.status).toBe(404);
    expect(await count("moderation")).toBe(0);
  });

  it("answers 404 to every action on a document that is not there, and logs none", async () => {
    for (const action of ["accept", "reject", "handed_over", "clear_warning"]) {
      expect((await post(`/api/docs/ZzZzZzZz/${action}`)).status).toBe(404);
    }
    expect(await count("moderation")).toBe(0);
  });

  it("does not block a key it has never seen, and does not log it", async () => {
    expect((await post(`/api/keys/${DIGEST}/block`, { note: "x" })).status).toBe(404);
    expect((await post(`/api/keys/${DIGEST}/unblock`)).status).toBe(404);
    expect(await count("moderation")).toBe(0);
  });

  it("blocks a known key and lifts it", async () => {
    await testEnv.DB.prepare("INSERT INTO keys (root, first_day) VALUES (?, ?)").bind(DIGEST, TODAY).run();
    expect((await post(`/api/keys/${DIGEST}/block`, { note: "x" })).status).toBe(200);
    expect((await post(`/api/keys/${DIGEST}/block`, { note: "x" })).status).toBe(404);
    expect((await post(`/api/keys/${DIGEST}/unblock`)).status).toBe(200);
    expect((await post(`/api/keys/${DIGEST}/unblock`)).status).toBe(404);
  });

  it("refuses a key block with no reason", async () => {
    expect((await post(`/api/keys/${DIGEST}/block`)).status).toBe(400);
  });

  it.each([
    ["version zero", { version: 0, tokenHash: DIGEST }],
    ["a fraction", { version: 1.5, tokenHash: DIGEST }],
    ["a string", { version: "1", tokenHash: DIGEST }],
    ["a short hash", { version: 1, tokenHash: "abc" }],
    ["records that are not sealed", { version: 1, tokenHash: DIGEST, sealedRecords: "plain" }],
    ["records as a number", { version: 1, tokenHash: DIGEST, sealedRecords: 5 }],
    ["records as null", { version: 1, tokenHash: DIGEST, sealedRecords: null }],
  ])("refuses a case with %s", async (_what, body) => {
    await share();
    const response = await post(`/api/docs/${ID}/case`, body);
    expect(response.status).toBe(400);
    expect(await count("cases")).toBe(0);
  });

  it("does not make a case for a version the document never had", async () => {
    await share();
    expect((await post(`/api/docs/${ID}/case`, { version: 9, tokenHash: DIGEST })).status).toBe(404);
    expect(await count("cases")).toBe(0);
  });

  it("makes a case once, and says nothing was done when the same link is made again", async () => {
    await share();
    expect((await post(`/api/docs/${ID}/case`, { version: 1, tokenHash: DIGEST })).status).toBe(200);
    expect((await post(`/api/docs/${ID}/case`, { version: 1, tokenHash: DIGEST })).status).toBe(404);
    expect(await count("cases")).toBe(1);
  });

  it.each(["/api/queue", "/api/overview", "/api/days", "/api/log", "/api/nets", "/api/top", "/api/owners"])(
    "answers %s on an empty database with JSON and no-store",
    async (path) => {
      const response = await asked(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await response.json();
    },
  );

  it.each(["__proto__", "constructor", "readers;DROP", "WEIGHT", ""])(
    "reads an unknown order %j as readers",
    async (by) => {
      const response = await asked(`/api/top?by=${encodeURIComponent(by)}`);
      expect(response.status).toBe(200);
    },
  );

  it.each(["%", "_", "' OR 1=1 --", "x".repeat(10_000), "\u0000", DIGEST, ` ${ID} `])(
    "finds nothing odd for %j",
    async (q) => {
      const response = await asked(`/api/find?q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(200);
      const found = (await response.json()) as { kind: string };
      expect(found.kind).toBe("none");
    },
  );

  it("finds a document by its id with spaces around, and a key by its root", async () => {
    await share();
    expect(await (await asked(`/api/find?q=${encodeURIComponent(` ${ID} `)}`)).json()).toEqual({
      kind: "doc",
      id: ID,
      owner: "o1",
    });
  });

  it("looks only at the first 200 documents when asked for their owners, and skips what is not an id", async () => {
    await share();
    const docs = [...Array.from({ length: 250 }, () => "bad"), ID].join(",");
    const owners = await (await asked(`/api/owners?docs=${docs}`)).json();
    expect(owners).toEqual({});
  });

  it("refuses an action sent with GET, and a verb it does not know, after the operator is known", async () => {
    await share();
    expect((await asked(`/api/docs/${ID}/block`)).status).toBe(404);
    expect(
      (await asked(`/api/docs/${ID}/block`, { method: "DELETE", headers: { "Folio-Operator": "1" } })).status,
    ).toBe(404);
    expect((await asked(`/api/docs/${ID}/block`, { method: "PUT", headers: { "Folio-Operator": "1" } })).status).toBe(
      404,
    );
    expect(await count("moderation")).toBe(0);
  });

  it("does not take an id that is longer or shorter than 8, or has a slash", async () => {
    for (const bad of ["AbCdEfG", "AbCdEfGhI", "AbCd/fGh", "AbCdEfG%2F"]) {
      expect((await post(`/api/docs/${bad}/block`, { note: "x" })).status).toBe(404);
    }
  });

  it("purges all of an owner's documents once, and says 404 for a document with nothing left", async () => {
    await share();
    await share("IjKlMnOp");
    const preview = await (await asked(`/api/docs/${ID}/purge_owner`)).json();
    expect(preview).toEqual({ purged: 2, kept: 0 });
    expect(await (await post(`/api/docs/${ID}/purge_owner`, { note: "gone" })).json()).toEqual({ purged: 2, kept: 0 });
    expect((await post(`/api/docs/${ID}/purge_owner`, { note: "gone" })).status).toBe(404);
    expect((await asked(`/api/docs/${ID}/purge_owner`)).status).toBe(404);
  });

  it("keeps a document of an owner that a grave report holds, and says so", async () => {
    await share();
    await share("IjKlMnOp");
    await store.report({ doc: "IjKlMnOp", net: "n1", asn: 1, category: "csam", version: 1 }, TODAY, HOUR);
    expect(await (await post(`/api/docs/${ID}/purge_owner`, { note: "gone" })).json()).toEqual({ purged: 1, kept: 1 });
  });

  it("reports panic records without who reported", async () => {
    await share();
    await store.report({ doc: ID, net: "secretnet", asn: 77, category: "csam", version: 1 }, TODAY, HOUR);
    const said = JSON.stringify(await (await post(`/api/docs/${ID}/panic`, { note: "legal" })).json());
    expect(said).not.toContain("secretnet");
    expect(said).not.toContain('"asn"');
  });
});

describe("what the panel keeps within bounds", () => {
  const unauthenticated = () =>
    answer(new Request("https://panel.test/api/queue"), {
      moderation,
      dashboard,
      about: { sharingOpen: true, termsVersion: "14", limitsSerial: 25 },
      access: ACCESS,
      certs,
      now: NOW,
    });

  it("refuses a token in the second it ends, and takes it a second before", async () => {
    expect(await isOperator(await token(NOW / 1000), ACCESS, certs, NOW)).toBe(false);
    expect(await isOperator(await token(NOW / 1000 + 1), ACCESS, certs, NOW)).toBe(true);
  });

  it("sends the same headers on every answer, one to someone who is not the operator too", async () => {
    for (const response of [await asked("/api/overview"), await unauthenticated()]) {
      expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  it("asks for flagged documents only when told so with 1", async () => {
    const flagged = async (said: string) =>
      ((await (await asked(`/api/top${said}`)).json()) as { flaggedOnly: boolean }).flaggedOnly;
    expect(await flagged("")).toBe(false);
    expect(await flagged("?flagged=0")).toBe(false);
    expect(await flagged("?flagged=true")).toBe(false);
    expect(await flagged("?flagged=1")).toBe(true);
  });

  it("shows the 50 latest entries of the log, newest first", async () => {
    await testEnv.DB.batch(
      Array.from({ length: 60 }, (_, at) =>
        testEnv.DB.prepare("INSERT INTO moderation (at, doc, action, note) VALUES (?, 'AbCdEfGh', 'block', 'n')").bind(
          at,
        ),
      ),
    );
    const log = (await (await asked("/api/log")).json()) as { at: number }[];
    expect(log).toHaveLength(50);
    expect(log[0]?.at).toBe(59);
    expect(log.at(-1)?.at).toBe(10);
  });

  it("lists at most 8 networks near their top, the nearest first", async () => {
    await testEnv.DB.batch(
      Array.from({ length: 10 }, (_, at) =>
        testEnv.DB.prepare("INSERT INTO net_day (day, net, docs, bytes, keys) VALUES (?, ?, ?, 0, 0)").bind(
          TODAY,
          `net${at}`,
          200 + at,
        ),
      ),
    );
    const { nets } = (await (await asked("/api/nets")).json()) as { nets: { net: string }[] };
    expect(nets).toHaveLength(8);
    expect(nets[0]?.net).toBe("net9");
  });

  it("finds a network of yesterday and not of the day before", async () => {
    const day = (when: number) =>
      testEnv.DB.prepare("INSERT INTO net_day (day, net, docs, bytes, keys) VALUES (?, ?, 1, 1, 1)")
        .bind(when, DIGEST)
        .run();
    const found = async () => ((await (await asked(`/api/find?q=${DIGEST}`)).json()) as { kind: string }).kind;
    await day(TODAY - 2);
    expect(await found()).toBe("none");
    await day(TODAY - 1);
    expect(await found()).toBe("net");
  });

  it("keeps the last 200 entries of the actions in a panic's records", async () => {
    await share();
    await testEnv.DB.batch(
      Array.from({ length: 205 }, (_, at) =>
        testEnv.DB.prepare("INSERT INTO moderation (at, doc, action, note) VALUES (?, ?, 'case', 'n')").bind(at, ID),
      ),
    );
    const { records } = (await (await post(`/api/docs/${ID}/panic`, { note: "legal" })).json()) as {
      records: { actions: unknown[] };
    };
    expect(records.actions).toHaveLength(200);
  });

  it("shows the 200 newest blocked keys, and no more", async () => {
    await testEnv.DB.batch(
      Array.from({ length: 205 }, (_, at) =>
        testEnv.DB.prepare("INSERT INTO keys (root, first_day, blocked_at) VALUES (?, 1, ?)").bind(`k${at}`, at + 1),
      ),
    );
    const queue = (await (await asked("/api/queue")).json()) as { blockedKeys: { root: string }[] };
    expect(queue.blockedKeys).toHaveLength(200);
    expect(queue.blockedKeys[0]?.root).toBe("k204");
  });
});
