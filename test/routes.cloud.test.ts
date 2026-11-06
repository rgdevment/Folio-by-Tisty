import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cloud } from "../src/cloudflare/store";
import { type AdminAction, administer } from "../src/core/admin";
import { dayOf, LEVEL_ONE } from "../src/core/limits";
import { netDigest } from "../src/core/net";
import { type ReportTools, reportDoc } from "../src/core/report";
import { proofHolds, tokenHash } from "../src/core/start";
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
const API = `https://tisty.cl/api/v1/docs/${ID}`;
const TOKEN = "the admin token";
const TABLES = ["docs", "net_day", "net_hour", "reports", "false_reporters", "holds", "service_stage"];
const EASY = { ...LEVEL_ONE, proofBits: 1 };

const share = async (id = ID, anchor?: string) => {
  await store.create(
    {
      id,
      owner: "o1",
      adminHash: await tokenHash(TOKEN),
      ttlDays: 3,
      net: "n",
      ...(anchor ? { anchor } : {}),
    },
    TODAY,
  );
  await store.upload({ ...SIGNED_BY_THE_OWNER, id, n: 1, hash: "h1", body: "sealed", net: "n", at: 1234 }, TODAY);
};

// The brake on reads is real here and lasts a minute, so each test comes from a network of its own.
let network = 0;

const send = async (url: string, over: RequestInit = {}, ip = `198.51.100.${network}`, more: object = {}) => {
  const context = createExecutionContext();
  const headers = new Headers(over.headers);
  headers.set("CF-Connecting-IP", ip);
  const response = await worker.fetch(
    new Request(url, { ...over, headers }) as Request<unknown, IncomingRequestCfProperties>,
    { ...testEnv, ...more } as never,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
};

const solve = async (salt: string, bits: number): Promise<string> => {
  for (let nonce = 0; ; nonce += 1) {
    if (await proofHolds(salt, String(nonce), bits)) return String(nonce);
  }
};

const reports = async () =>
  (await testEnv.DB.prepare("SELECT * FROM reports").all<{ net: string; asn: number; detail: string | null }>())
    .results;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  network += 1;
  for (const table of TABLES) await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  const held = await testEnv.ENVELOPES.list();
  if (held.objects.length > 0) await testEnv.ENVELOPES.delete(held.objects.map((one) => one.key));
});

describe("reporting over HTTP", () => {
  const report = (body: unknown, headers: Record<string, string> = {}) =>
    send(`${API}/report`, { method: "POST", body: JSON.stringify(body), headers });

  it("asks for a proof the client can solve with what it is told, and then takes the report", async () => {
    await share();
    const asked = await report({ category: "phishing", detail: "a fake bank" });
    expect(asked.status).toBe(429);
    const { salt, bits } = (await asked.json()) as { salt: string; bits: number };
    expect(bits).toBe(LEVEL_ONE.proofBits);
    expect(await reports()).toEqual([]);

    const taken = await report(
      { category: "phishing", detail: "a fake bank" },
      { "Folio-Proof": await solve(salt, bits) },
    );
    expect(taken.status).toBe(202);
    expect(await taken.json()).toEqual({ received: true });
    const [row] = await reports();
    expect(row?.detail).toBe("a fake bank");
    expect(row?.net).not.toContain("203.0.113.7");
  });

  it("refuses what is not a grave report before asking for any work", async () => {
    await share();
    for (const body of [
      {},
      "text",
      { category: "copyright" },
      { category: "phishing", detail: "x".repeat(LEVEL_ONE.reportDetailAtMost + 1) },
      { category: "phishing", sealedLink: "x".repeat(LEVEL_ONE.sealedLinkAtMost + 1) },
      { category: "phishing", detail: 7 },
    ]) {
      expect((await report(body)).status).toBe(400);
    }
    const broken = await send(`${API}/report`, { method: "POST", body: "{not json" });
    expect(broken.status).toBe(400);
  });

  it("refuses a body past its size without reading it as a report", async () => {
    const big = await report({ category: "phishing", padding: "x".repeat(20_000) });
    expect(big.status).toBe(413);
  });

  it("stops reading a body in parts as soon as it passes the size", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 100) controller.close();
        else controller.enqueue(new Uint8Array(4096));
      },
    });
    const big = await send(`${API}/report`, { method: "POST", body, duplex: "half" } as RequestInit);
    expect(big.status).toBe(413);
    expect(sent).toBeLessThan(100);
  });
});

describe("a report", () => {
  const tools = (over: Partial<ReportTools> = {}) => {
    const set: ReportTools = {
      store,
      limiter: { allows: async () => true },
      limits: EASY,
      secret: testEnv.FOLIO_SECRET,
      dayKey: async () => "a key for the day",
      evidenceKey: async () => "a key for the period",
      ...over,
    };
    return { set };
  };

  const proved = async (id: string, ip: string, set: ReportTools, category: string, asn: number, now = NOW) => {
    const said = { category };
    const asked = await reportDoc({ id, ip, asn, now, said }, set);
    if (!("salt" in asked)) throw new Error("no proof was asked for");
    const proof = await solve(asked.salt, asked.bits);
    return reportDoc({ id, ip, asn, now, said, proof }, set);
  };

  it("names the network under the key of the period, not the day's", async () => {
    await share();
    await proved(ID, "203.0.113.7", tools().set, "phishing", 1);
    const [row] = await reports();
    expect(row?.net).toBe(await netDigest("a key for the period", "203.0.113.7"));
    expect(row?.asn).toBe(1);
  });

  it("does not block on one report of CSAM", async () => {
    await share();
    const { set } = tools();
    await proved(ID, "203.0.113.7", set, "csam", 1);
    expect((await store.shown(ID, TODAY))?.blockedAt).toBeNull();
  });

  it("keeps nothing of a document that does not exist", async () => {
    const { set } = tools();
    expect(await proved(ID, "203.0.113.7", set, "csam", 1)).toEqual({ received: true });
    expect(await reports()).toHaveLength(0);
  });

  it("stops at the network's reports of the hour, and goes on in the next", async () => {
    await share();
    const { set } = tools({ limits: { ...EASY, reportsAnHour: 2 } });
    await proved(ID, "203.0.113.7", set, "phishing", 1);
    await proved(ID, "203.0.113.7", set, "phishing", 1);
    expect(await proved(ID, "203.0.113.7", set, "phishing", 1)).toMatchObject({ refused: "quota" });
    expect(await proved(ID, "203.0.113.8", set, "phishing", 1)).toEqual({ received: true });
    expect(await proved(ID, "203.0.113.7", set, "phishing", 1, NOW + 3_600_000)).toEqual({ received: true });
  });
});

describe("the key of the evidence period", () => {
  it("lasts the period, and only then changes", async () => {
    const days = LEVEL_ONE.evidenceDays;
    const start = TODAY - (TODAY % days);
    const first = await store.evidenceKey(start);
    expect(await store.evidenceKey(start + days - 1)).toBe(first);
    const next = await store.evidenceKey(start + days);
    expect(next).not.toBe(first);
    expect(await store.evidenceKey(start)).toBe(next);
  });

  it("is not an orphan, whatever its age", async () => {
    await store.evidenceKey(TODAY);
    await store.dayKey(TODAY);
    expect(await store.forgetOrphans(Date.now() + 10 * 86_400_000)).toBe(0);
    const left = await testEnv.ENVELOPES.list();
    expect(left.objects).toHaveLength(2);
  });
});

describe("starting", () => {
  const start = (ip?: string) => send("https://tisty.cl/api/v1/start", { method: "POST" }, ip);

  it("writes nothing, and only the brake stops it", async () => {
    for (let n = 0; n < 20; n += 1) expect((await start()).status).toBe(200);
    const refused = await start();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ refused: "slow" });
    expect(Number(refused.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
    expect((await start(`198.51.100.${network + 100}`)).status).toBe(200);
    const rows = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM net_hour").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("forgets the counts of past days in the sweep", async () => {
    await store.takeHourly("n", "report", (TODAY - 1) * 24, 5);
    await store.takeHourly("n2", "report", TODAY * 24, 5);
    await store.sweep(TODAY);
    const left = await testEnv.DB.prepare("SELECT net FROM net_hour").all<{ net: string }>();
    expect(left.results.map((one) => one.net)).toEqual(["n2"]);
  });
});

describe("the admin link", () => {
  const admin = (path: string, method: string, token = TOKEN) =>
    send(`${API}${path}`, { method, headers: { "Folio-Admin": token } });
  const read = () => send(API);

  it("is the only way in, and a wrong token looks like nothing there", async () => {
    await share();
    expect((await admin("/admin", "GET", "wrong")).status).toBe(404);
    expect((await send(`${API}/admin`)).status).toBe(404);
    expect((await admin("", "DELETE", "wrong")).status).toBe(404);
    expect((await read()).status).toBe(200);
  });

  it("shows the state and the reads, and nothing about an order", async () => {
    await share();
    await testEnv.DB.prepare(`UPDATE docs SET read_total = 7, legal_until = ? WHERE id = '${ID}'`)
      .bind(TODAY + 90)
      .run();
    const response = await admin("/admin", "GET");
    expect(response.status).toBe(200);
    const { status } = (await response.json()) as { status: Record<string, unknown> };
    expect(status).toMatchObject({ latest: 1, readTotal: 7, pausedAt: null, blockedAt: null, days: {} });
    expect(JSON.stringify(status)).not.toContain(String(TODAY + 90));
    expect(status).not.toHaveProperty("adminHash");
  });

  it("pauses and resumes", async () => {
    await share();
    expect((await admin("/pause", "POST")).status).toBe(200);
    expect((await read()).status).toBe(403);
    expect((await admin("/resume", "POST")).status).toBe(200);
    expect((await read()).status).toBe(200);
  });

  it("stops at once, and the sweep then forgets it", async () => {
    await share();
    expect((await admin("", "DELETE")).status).toBe(200);
    expect((await read()).status).toBe(404);
    expect((await admin("/admin", "GET")).status).toBe(404);
    expect((await store.sweep(TODAY)).forgotten).toBe(1);
    expect((await testEnv.ENVELOPES.list()).objects).toEqual([]);
  });

  it("stops what evidence keeps the same way to its owner, and keeps it unread", async () => {
    await share();
    await store.report({ doc: ID, net: "r", category: "phishing", asn: 1 }, TODAY, TODAY * 24);
    expect((await admin("", "DELETE")).status).toBe(200);
    expect((await read()).status).toBe(404);
    expect((await admin("/admin", "GET")).status).toBe(404);
    expect((await admin("/resume", "POST")).status).toBe(404);
    expect((await store.sweep(TODAY)).forgotten).toBe(0);
    expect((await testEnv.ENVELOPES.list()).objects).toHaveLength(1);
  });

  it("keeps what was reported after it was stopped and before the sweep", async () => {
    await share();
    await admin("", "DELETE");
    await store.report({ doc: ID, net: "r", category: "phishing", asn: 1 }, TODAY, TODAY * 24);
    expect((await store.sweep(TODAY)).forgotten).toBe(0);
    expect((await testEnv.ENVELOPES.list()).objects).toHaveLength(1);
    expect((await read()).status).toBe(404);
  });

  it("stops a language like anything else, and forgets it while its anchor lives", async () => {
    await share("AAAAAAAA");
    await share(ID, "AAAAAAAA");
    expect((await admin("", "DELETE")).status).toBe(200);
    expect((await read()).status).toBe(404);
    expect((await admin("/admin", "GET")).status).toBe(404);
    expect((await admin("/resume", "POST")).status).toBe(404);
    expect((await store.sweep(TODAY)).forgotten).toBe(1);
    expect(await store.shown("AAAAAAAA", TODAY)).toMatchObject({ alive: true });
  });

  it("gives a retained language away no more than a document", async () => {
    await share("AAAAAAAA");
    await share(ID, "AAAAAAAA");
    await store.report({ doc: ID, net: "r", category: "phishing", asn: 1 }, TODAY, TODAY * 24);
    expect((await admin("", "DELETE")).status).toBe(200);
    expect((await admin("/admin", "GET")).status).toBe(404);
    expect((await admin("/resume", "POST")).status).toBe(404);
    expect((await read()).status).toBe(404);
    expect((await store.sweep(TODAY)).forgotten).toBe(0);
  });

  it("goes on showing a language kept alive by its anchor", async () => {
    await share("AAAAAAAA");
    await share(ID, "AAAAAAAA");
    await testEnv.DB.prepare(`UPDATE docs SET dies_on = ? WHERE id = '${ID}'`)
      .bind(TODAY - 1)
      .run();
    expect((await admin("/admin", "GET")).status).toBe(200);
  });

  it("does not bring back what was stopped when its reads of the day are added up", async () => {
    await share();
    await store.report({ doc: ID, net: "r", category: "phishing", asn: 1 }, TODAY, TODAY * 24);
    await store.note({ owner: "o1", reader: "r1", doc: ID, hour: 9, proved: false }, TODAY);
    await admin("", "DELETE");
    await store.sweep(TODAY + 1);
    expect((await store.shown(ID, TODAY + 1))?.alive).toBe(false);
  });

  it("keeps an anchor while a language of it has to stay", async () => {
    await share("AAAAAAAA");
    await share(ID, "AAAAAAAA");
    await store.report({ doc: ID, net: "r", category: "phishing", asn: 1 }, TODAY, TODAY * 24);
    const stopAnchor = await send("https://tisty.cl/api/v1/docs/AAAAAAAA", {
      method: "DELETE",
      headers: { "Folio-Admin": TOKEN },
    });
    expect(stopAnchor.status).toBe(200);
    expect((await store.sweep(TODAY)).forgotten).toBe(0);
    expect((await read()).status).toBe(404);
  });

  it("does nothing to what is blocked, which stays as evidence", async () => {
    await share();
    await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(TODAY).run();
    for (const [path, method] of [
      ["", "DELETE"],
      ["/pause", "POST"],
      ["/resume", "POST"],
    ] as const) {
      expect((await admin(path, method)).status).toBe(403);
    }
    expect((await read()).status).toBe(403);
    expect((await store.sweep(TODAY)).forgotten).toBe(0);
  });

  it("looks gone past its days, or it would give away an order that keeps it", async () => {
    await share();
    await testEnv.DB.prepare(`UPDATE docs SET dies_on = ?, legal_until = ? WHERE id = '${ID}'`)
      .bind(TODAY - 1, TODAY + 90)
      .run();
    expect((await admin("/admin", "GET")).status).toBe(404);
  });

  it("answers no more than the brake lets through", async () => {
    const asked = (action: AdminAction) =>
      administer(
        { id: ID, ip: "203.0.113.7", now: NOW, token: TOKEN, action },
        {
          store,
          limiter: { allows: async () => false },
          dayKey: async () => "a key for the day",
        },
      );
    expect(await asked("status")).toMatchObject({ refused: "slow" });
  });
});

describe("appealing", () => {
  const appeal = (token = TOKEN) =>
    administer(
      { id: ID, ip: "203.0.113.7", now: NOW, token, action: "appeal" },
      { store, limiter: { allows: async () => true }, dayKey: async () => "a key for the day" },
    );
  const block = (day = TODAY) =>
    testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(day).run();

  it("has nothing to do when nothing is blocked", async () => {
    await share();
    expect(await appeal()).toEqual({ refused: "not_blocked" });
  });

  it("is taken once per block", async () => {
    await share();
    await block();
    expect(await appeal()).toEqual({ done: true });
    expect(await appeal()).toEqual({ refused: "appealed" });
  });

  it("can appeal a new block on the same day an appeal was accepted", async () => {
    await share();
    await block();
    expect(await appeal()).toEqual({ done: true });
    await store.appealAccepted(ID, TODAY);
    expect(await appeal()).toEqual({ refused: "not_blocked" });
    await block();
    expect(await appeal()).toEqual({ done: true });
    expect(await appeal()).toEqual({ refused: "appealed" });
  });

  it("does not let a wrong token appeal", async () => {
    await share();
    await block();
    expect(await appeal("wrong")).toEqual({ refused: "missing" });
  });

  it("does not lift the block by itself", async () => {
    await share();
    await block();
    await appeal();
    expect((await store.shown(ID, TODAY))?.blockedAt).toBe(TODAY);
  });
});
