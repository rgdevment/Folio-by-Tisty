import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudSpend } from "../src/cloudflare/spend";
import { Cloud } from "../src/cloudflare/store";
import worker from "../src/private/index";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const store = new Cloud(testEnv);
const DAY = 20_000;

const BINDINGS = {
  CF_API_TOKEN: "token",
  CF_ACCOUNT_ID: "account",
  CF_ZONE_ID: "zone",
  CF_RULESET_ID: "ruleset",
  CF_RULE_ID: "rule",
  CF_DATABASE_ID: "database",
  CF_SCRIPT_NAME: "folio-private",
  CF_BUCKET_NAME: "bucket",
};

const answering = (body: unknown, status = 200) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, spend: new CloudSpend(BINDINGS, fetcher) };
};

const dying = async (id: string, diesOn: number, more = "") => {
  await store.create({ id, owner: `o-${id}`, adminHash: "a", ttlDays: 3, net: "n" }, DAY);
  await testEnv.DB.prepare(`UPDATE docs SET dies_on = ?${more} WHERE id = ?`).bind(diesOn, id).run();
};

const diesOn = async (id: string) =>
  (await testEnv.DB.prepare("SELECT dies_on FROM docs WHERE id = ?").bind(id).first<{ dies_on: number }>())?.dies_on;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["docs", "service_day", "service_stage", "net_day", "holds"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const tables = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'seen_[0-9]*'").all<{
    name: string;
  }>();
  for (const { name } of tables.results) await testEnv.DB.prepare(`DROP TABLE ${name}`).run();
});

describe("the stage", () => {
  it("is open with no row, and writes one only when asked", async () => {
    expect(await store.stage()).toBe("open");
    await store.setStage("blocked");
    expect(await store.stage()).toBe("blocked");
    await store.setStage("warned");
    expect(await store.stage()).toBe("warned");
  });
});

describe("a block", () => {
  it("forgets nothing meanwhile, and still adds up the days", async () => {
    await dying("gone", DAY - 1);
    await store.create({ id: "read", owner: "o", adminHash: "a", ttlDays: 3, net: "n" }, DAY);
    await store.note({ owner: "o", reader: "r", doc: "read", hour: 9, proved: false }, DAY);
    await store.setStage("blocked");
    const swept = await store.sweep(DAY + 1);
    expect(swept).toMatchObject({ summed: 1, forgotten: 0, failed: 0 });
    expect(await diesOn("gone")).toBe(DAY - 1);
  });

  it("forgets again once it is not blocked", async () => {
    await dying("gone", DAY - 1);
    await store.setStage("no_uploads");
    expect((await store.sweep(DAY + 1)).forgotten).toBe(1);
  });

  it("gives its days back to what was about to die, and to nothing else", async () => {
    await dying("late", DAY - 5);
    await dying("today", DAY);
    await dying("fine", DAY + 2);
    await store.liftCut(DAY);
    expect(await diesOn("late")).toBe(DAY + 3);
    expect(await diesOn("today")).toBe(DAY + 3);
    expect(await diesOn("fine")).toBe(DAY + 2);
  });

  it("does not give days to what only evidence keeps, which must stay unread", async () => {
    await dying("reported", DAY - 1);
    await store.report({ doc: "reported", net: "n", category: "phishing", asn: 1 }, DAY - 1, (DAY - 1) * 24);
    await dying("ordered", DAY - 1, `, legal_until = ${DAY + 90}`);
    await store.liftCut(DAY);
    expect(await diesOn("reported")).toBe(DAY - 1);
    expect(await diesOn("ordered")).toBe(DAY - 1);
  });

  it("does not give days to what is paused or blocked, whose time is its own", async () => {
    await dying("paused", DAY - 1, ", paused_at = 1");
    await dying("blocked", DAY - 1, ", blocked_at = 1");
    await store.liftCut(DAY);
    expect(await diesOn("paused")).toBe(DAY - 1);
    expect(await diesOn("blocked")).toBe(DAY - 1);
  });
});

describe("reading the usage", () => {
  const usage = {
    data: {
      viewer: {
        accounts: [
          {
            workers: [{ sum: { requests: 11 } }],
            d1: [{ sum: { rowsRead: 22, rowsWritten: 33 } }],
            r2: [
              { sum: { requests: 1 }, dimensions: { actionType: "PutObject" } },
              { sum: { requests: 2 }, dimensions: { actionType: "ListObjects" } },
              { sum: { requests: 4 }, dimensions: { actionType: "GetObject" } },
              { sum: { requests: 8 }, dimensions: { actionType: "HeadObject" } },
              { sum: { requests: 16 }, dimensions: { actionType: "DeleteObject" } },
            ],
            stored: [{ max: { payloadSize: 3e9, metadataSize: 1e9 } }],
          },
        ],
      },
    },
  };

  it("adds up each class of R2 by R2's own price list, leaving out what is free", async () => {
    const { spend } = answering(usage);
    expect(await spend.usageSince(0, 86_400_000)).toEqual({
      requests: 11,
      rowsRead: 22,
      rowsWritten: 33,
      classA: 3,
      classB: 12,
      storedGb: 4,
    });
  });

  it("sends its token, and the range it was asked for", async () => {
    const { calls, spend } = answering(usage);
    await spend.usageSince(Date.UTC(2026, 10, 15), Date.UTC(2026, 10, 20, 12));
    const call = calls[0];
    expect(call?.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(new Headers(call?.init.headers).get("Authorization")).toBe("Bearer token");
    const { variables } = JSON.parse(String(call?.init.body));
    expect(variables).toMatchObject({
      account: "account",
      database: "database",
      script: "folio-private",
      bucket: "bucket",
      since: "2026-11-15T00:00:00.000Z",
      sinceDate: "2026-11-15",
      untilDate: "2026-11-20",
    });
  });

  it("counts nothing where nothing happened yet", async () => {
    const { spend } = answering({ data: { viewer: { accounts: [{ workers: [], d1: [], r2: [], stored: [] }] } } });
    expect(await spend.usageSince(0, 1)).toEqual({
      requests: 0,
      rowsRead: 0,
      rowsWritten: 0,
      classA: 0,
      classB: 0,
      storedGb: 0,
    });
  });

  it("fails rather than read a wrong bill", async () => {
    await expect(answering({ errors: [{ message: "no" }] }).spend.usageSince(0, 1)).rejects.toThrow("no usage");
    await expect(answering({ data: { viewer: { accounts: [] } } }).spend.usageSince(0, 1)).rejects.toThrow("no usage");
    await expect(answering({}, 500).spend.usageSince(0, 1)).rejects.toThrow("answered 500");
  });
});

describe("each cron", () => {
  const fire = (cron: string, scheduledTime = DAY * 86_400_000, over = {}) =>
    worker.scheduled({ cron, scheduledTime, noRetry() {} } as ScheduledController, { ...testEnv, ...over } as never);

  it("the review of the bill does not sweep, and fails loud without its settings", async () => {
    await dying("gone", DAY - 1);
    await expect(fire("*/15 * * * *", (DAY + 1) * 86_400_000, { BILLING_DAY: "" })).rejects.toThrow("renewal day");
    expect(await diesOn("gone")).toBe(DAY - 1);
  });

  it("the hour sweeps", async () => {
    await dying("gone", DAY - 1);
    await fire("0 * * * *", (DAY + 1) * 86_400_000);
    expect(await diesOn("gone")).toBeUndefined();
  });
});

describe("the rule", () => {
  it("switches the one made by hand, over /api/ only, so the page keeps loading", async () => {
    const { calls, spend } = answering({ success: true });
    await spend.setBlocked(true);
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone/rulesets/ruleset/rules/rule");
    expect(calls[0]?.init.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({ action: "block", enabled: true });
    expect(body.expression).toContain('"/api/"');
    await spend.setBlocked(false);
    expect(JSON.parse(String(calls[1]?.init.body)).enabled).toBe(false);
  });

  it("fails loud when Cloudflare refuses, so the stage does not move", async () => {
    await expect(answering({}, 403).spend.setBlocked(true)).rejects.toThrow("answered 403");
  });
});
