import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Cloud } from "../src/cloudflare/store";
import { dayOf } from "../src/core/limits";
import { tokenHash } from "../src/core/start";
import worker from "../src/private/index";
import { SIGNED_BY_THE_OWNER } from "./sealed";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  FOLIO_SECRET: string;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const store = new Cloud(testEnv);
const NOW = Date.now();
const TODAY = dayOf(NOW);
const ID = "AbCdEfGh";
const API = "https://tisty.cl/api/v1/";
const DOC = `${API}docs/${ID}`;
const TOKEN = "the admin token";
const PERMIT = "P".repeat(43);
const TABLES = ["docs", "net_day", "net_hour", "reports", "false_reporters", "holds", "service_stage", "revocations"];

let network = 0;

const send = async (url: string, over: RequestInit = {}) => {
  const context = createExecutionContext();
  const headers = new Headers(over.headers);
  headers.set("CF-Connecting-IP", `198.51.100.${network}`);
  const response = await worker.fetch(
    new Request(url, { ...over, headers }) as Request<unknown, IncomingRequestCfProperties>,
    testEnv as never,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
};

const share = async (id = ID) => {
  await store.create({ id, owner: "o1", adminHash: await tokenHash(TOKEN), ttlDays: 3, net: "n" }, TODAY);
  await store.upload({ ...SIGNED_BY_THE_OWNER, id, n: 1, hash: "h1", body: "sealed", net: "n", at: 1234 }, TODAY);
};

const permitRow = async () =>
  (await testEnv.DB.prepare("SELECT permit FROM docs WHERE id = ?").bind(ID).first<{ permit: string | null }>())
    ?.permit;

const reportsHeld = async () =>
  (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>())?.n;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  network += 1;
  for (const table of TABLES) await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  const held = await testEnv.ENVELOPES.list();
  if (held.objects.length > 0) await testEnv.ENVELOPES.delete(held.objects.map((one) => one.key));
});

describe("paths and verbs the API does not have", () => {
  it.each([
    ["GET", `${DOC}/`],
    ["GET", `${DOC}//`],
    ["GET", `${API}docs/${ID.toLowerCase()}x`],
    ["GET", `${API}docs/AbCdEfG`],
    ["GET", `${API}docs/AbCdEfGhI`],
    ["GET", `${DOC}/report`],
    ["GET", `${DOC}/permit`],
    ["GET", `${DOC}/pause`],
    ["POST", `${DOC}/admin`],
    ["POST", `${DOC}`],
    ["PUT", `${DOC}/latest`],
    ["PUT", `${DOC}/report`],
    ["DELETE", `${DOC}/files`],
    ["PUT", `${DOC}/files/${"A".repeat(43)}`],
    ["POST", `${DOC}/files`],
    ["GET", `${API}start`],
    ["GET", `${API}revocations`],
    ["POST", `${API}cases/${ID}`],
    ["GET", `${API}cases/${ID}/records/more`],
    ["GET", `${API}cases/${ID}/files/short`],
    ["GET", `${API}`],
    ["GET", `${API}docs`],
    ["GET", `${API}docs/`],
    ["PATCH", DOC],
  ])("answers %s %s with 404 and does nothing", async (method, url) => {
    await share();
    const response = await send(url, {
      method,
      headers: { "Folio-Admin": TOKEN },
      body: method === "GET" ? undefined : "{}",
    });
    expect(response.status).toBe(404);
    expect(
      (await testEnv.DB.prepare("SELECT paused_at, dies_on FROM docs").first<{ paused_at: number | null }>())
        ?.paused_at,
    ).toBeNull();
    expect(await reportsHeld()).toBe(0);
  });

  it("is not reached outside /api/v1/", async () => {
    expect((await send("https://tisty.cl/api/v2/docs/AbCdEfGh")).status).toBe(404);
    expect((await send("https://tisty.cl/")).status).toBe(404);
  });

  it("carries the security headers on a 404 under the API, and keeps the body empty of the document", async () => {
    const response = await send(`${API}nothing`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.json()).toEqual({ refused: "missing" });
  });
});

describe("the permit route", () => {
  const permit = (body: BodyInit | null, token = TOKEN) =>
    send(`${DOC}/permit`, { method: "PUT", headers: { "Folio-Admin": token }, body });

  it.each([
    ["no body", null],
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["null", "null"],
    ["no permit field", "{}"],
    ["a permit that is a number", '{"permit":5}'],
    ["a short permit", '{"permit":"abc"}'],
    ["a long permit", `{"permit":"${"A".repeat(44)}"}`],
    ["a permit with a slash", `{"permit":"${"A".repeat(42)}/"}`],
    ["a body past its size", `{"permit":"${PERMIT}","pad":"${"x".repeat(300)}"}`],
  ])("refuses %s with 400 and keeps the permit as it was", async (_what, body) => {
    await share();
    const response = await permit(body);
    expect(response.status).toBe(400);
    expect(await permitRow()).toBeNull();
  });

  it("sets a permit and clears it, with the admin token only", async () => {
    await share();
    expect((await permit(JSON.stringify({ permit: PERMIT }), "wrong")).status).toBe(404);
    expect(await permitRow()).toBeNull();
    expect((await permit(JSON.stringify({ permit: PERMIT }))).status).toBe(200);
    expect(await permitRow()).toBe(PERMIT);
    expect((await permit('{"permit":null}')).status).toBe(200);
    expect(await permitRow()).toBeNull();
  });

  it("does not set a permit on a blocked document", async () => {
    await share();
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?").bind(TODAY).run();
    expect((await permit(JSON.stringify({ permit: PERMIT }))).status).toBe(403);
    expect(await permitRow()).toBeNull();
  });
});

describe("the admin link after a stop", () => {
  const admin = (path: string, method: string) => send(`${DOC}${path}`, { method, headers: { "Folio-Admin": TOKEN } });

  it("cannot bring back what was stopped, by resuming it", async () => {
    await share();
    expect((await admin("", "DELETE")).status).toBe(200);
    expect((await admin("/resume", "POST")).status).toBe(404);
    expect((await send(DOC)).status).toBe(404);
  });

  it("cannot set a permit on what was stopped", async () => {
    await share();
    await admin("", "DELETE");
    const response = await send(`${DOC}/permit`, {
      method: "PUT",
      headers: { "Folio-Admin": TOKEN },
      body: JSON.stringify({ permit: PERMIT }),
    });
    expect(response.status).toBe(404);
    expect(await permitRow()).toBeNull();
  });

  it("pauses twice without moving the day it began", async () => {
    await share();
    await admin("/pause", "POST");
    await testEnv.DB.prepare("UPDATE docs SET paused_at = paused_at - 2, dies_on = dies_on - 2").run();
    const before = await testEnv.DB.prepare("SELECT paused_at, dies_on FROM docs").first();
    await admin("/pause", "POST");
    expect(await testEnv.DB.prepare("SELECT paused_at, dies_on FROM docs").first()).toEqual(before);
  });

  it("has no token that is empty", async () => {
    await share();
    for (const token of ["", " "]) {
      const response = await send(`${DOC}/admin`, { headers: { "Folio-Admin": token } });
      expect(response.status).toBe(404);
    }
  });
});

describe("reports with hostile bodies", () => {
  const report = (body: unknown) =>
    send(`${DOC}/report`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  const KEY = "A".repeat(43);

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"phishing"'],
    ["a category of the prototype", { category: "__proto__" }],
    ["a category of a method", { category: "toString" }],
    ["a category that is a list", { category: ["phishing"] }],
    ["a missing category", { detail: "a long enough detail to count" }],
    ["a grave one with no link", { category: "csam", detail: "a long enough detail to count" }],
    ["a light one with a link", { category: "spam", sealedLink: `sealed1.${"A".repeat(150)}` }],
    ["a detail that holds a key in a link", { category: "phishing", detail: `see https://tisty.cl/${ID}#${KEY}` }],
    ["a version of zero", { category: "phishing", detail: "x".repeat(40), version: 0 }],
    ["a version that is a fraction", { category: "phishing", detail: "x".repeat(40), version: 1.5 }],
    ["a version too big to be exact", { category: "phishing", detail: "x".repeat(40), version: 2 ** 60 }],
    ["a version as text", { category: "phishing", detail: "x".repeat(40), version: "1" }],
    ["a contact in the clear", { category: "phishing", detail: "x".repeat(40), sealedContact: "me@example.test" }],
    ["a contact on a light report", { category: "spam", sealedContact: `contact1.${"A".repeat(80)}` }],
    [
      "a contact that is too long",
      { category: "phishing", detail: "x".repeat(40), sealedContact: `contact1.${"A".repeat(600)}` },
    ],
  ])("refuses %s with 400 before asking for any work", async (_what, body) => {
    await share();
    const response = await report(body);
    expect(response.status).toBe(400);
    expect(await reportsHeld()).toBe(0);
  });

  it("tells a client how long to wait, in whole seconds, when it asks for work", async () => {
    await share();
    const response = await report({ category: "spam" });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(0);
  });

  it("asks for work on a document that does not exist, as it does on one that does", async () => {
    const asked = await report({ category: "spam" });
    await share();
    const real = await report({ category: "spam" });
    expect(asked.status).toBe(real.status);
  });
});

describe("revocations with hostile bodies", () => {
  const revoke = (body: BodyInit | null) => send(`${API}revocations`, { method: "POST", body });

  it.each([
    ["no body", null],
    ["not JSON", "{"],
    ["an object", "{}"],
    ["an empty list", "[]"],
    ["a list of nothing", "[null]"],
    ["a list of numbers", "[1,2]"],
  ])("refuses %s with 400", async (_what, body) => {
    expect((await revoke(body)).status).toBe(400);
  });

  it("refuses a body past its size with 413", async () => {
    expect((await revoke(`[${"1,".repeat(5000)}1]`)).status).toBe(413);
  });
});

describe("what the API promises on every answer", () => {
  it("sends the transport and framing headers on a read, a refusal and a 404", async () => {
    await share();
    for (const url of [DOC, `${DOC}/latest`, `${API}docs/ZzZzZzZz`, `${API}nothing`]) {
      const response = await send(url);
      expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains; preload");
      expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    }
  });

  it("logs a read by document, country and data center, and never by network", async () => {
    await share();
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await send(DOC, { headers: { "X-Forwarded-For": "203.0.113.77" } });
      const lines = logged.mock.calls.map((one) => String(one[0]));
      expect(lines.some((one) => one.includes(ID))).toBe(true);
      for (const line of lines) expect(line).not.toMatch(/198\.51\.100|203\.0\.113/);
    } finally {
      logged.mockRestore();
    }
  });

  it("takes a report body of exactly 16384 bytes and refuses one of 16385", async () => {
    await share();
    const of = (size: number) => {
      const start = '{"category":"spam","pad":"';
      return `${start}${"x".repeat(size - start.length - 2)}"}`;
    };
    expect(of(16_384)).toHaveLength(16_384);
    expect((await send(`${DOC}/report`, { method: "POST", body: of(16_384) })).status).toBe(429);
    expect((await send(`${DOC}/report`, { method: "POST", body: of(16_385) })).status).toBe(413);
  });

  it("takes a permit body of exactly 256 bytes and refuses one of 257", async () => {
    await share();
    const of = (size: number) => {
      const start = `{"permit":"${PERMIT}","pad":"`;
      return `${start}${"x".repeat(size - start.length - 2)}"}`;
    };
    const put = (body: string) => send(`${DOC}/permit`, { method: "PUT", headers: { "Folio-Admin": TOKEN }, body });
    expect((await put(of(256))).status).toBe(200);
    expect((await put(of(257))).status).toBe(400);
  });

  it("takes a revocations body of exactly 8192 bytes and refuses one of 8193", async () => {
    const of = (size: number) => `[${" ".repeat(size - 3)}1]`;
    const put = (body: string) => send(`${API}revocations`, { method: "POST", body });
    expect((await put(of(8192))).status).toBe(400);
    expect((await put(of(8193))).status).toBe(413);
  });
});

describe("starting and reading with hostile headers", () => {
  it("starts with no address at all, and still answers", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${API}start`, { method: "POST" }) as Request<unknown, IncomingRequestCfProperties>,
      testEnv as never,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
  });

  it("reads with a proof that is garbage, and asks for work instead of failing", async () => {
    await share();
    for (const proof of ["", "é", "x".repeat(5000), "1.2.3"]) {
      const response = await send(DOC, { headers: { "Folio-Proof": proof } });
      expect([200, 429]).toContain(response.status);
    }
  });

  it("answers a case read with no token, a short token and a wrong one the same way", async () => {
    await share();
    const answers = await Promise.all(
      [undefined, "short", "A".repeat(43)].map(async (token) => {
        const response = await send(`${API}cases/${ID}`, { headers: token ? { "Folio-Case": token } : {} });
        return [response.status, await response.text()];
      }),
    );
    expect(new Set(answers.map((one) => JSON.stringify(one))).size).toBe(1);
    expect(answers[0]?.[0]).toBe(404);
  });
});
