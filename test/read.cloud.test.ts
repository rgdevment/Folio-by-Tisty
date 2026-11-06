import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cloud } from "../src/cloudflare/store";
import { DAY_MS, dayOf, LEVEL_ONE } from "../src/core/limits";
import { netOf } from "../src/core/net";
import { type Limiter, type ReadTools, readDoc } from "../src/core/read";
import { startHolds } from "../src/core/start";
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
const TABLES = [
  "docs",
  "service_day",
  "service_stage",
  "net_day",
  "net_hour",
  "reports",
  "revocations",
  "editors",
  "holds",
  "openings",
];

const open: Limiter = { allows: async () => true };

const tools = (over: Partial<ReadTools> = {}): ReadTools => ({
  store,
  limiter: open,
  limits: LEVEL_ONE,
  secret: testEnv.FOLIO_SECRET,
  dayKey: async () => "a key for the day",
  ...over,
});

const share = async (id = ID) => {
  await store.create({ id, owner: "o1", adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
  await store.upload({ ...SIGNED_BY_THE_OWNER, id, n: 1, hash: "h1", body: "sealed", net: "n", at: 1234 }, TODAY);
};

const get = async (over: RequestInit = {}, ip = "203.0.113.7", url = API) => {
  const context = createExecutionContext();
  const headers = new Headers(over.headers);
  headers.set("CF-Connecting-IP", ip);
  const response = await worker.fetch(
    new Request(url, { ...over, headers }) as Request<unknown, IncomingRequestCfProperties>,
    testEnv as never,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
};

const seen = async () => {
  const table = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE name = ?").bind(`seen_${TODAY}`).first();
  if (!table) return [];
  const rows = await testEnv.DB.prepare(`SELECT * FROM seen_${TODAY}`).all<{ reader: string; hour: number }>();
  return rows.results;
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of TABLES) await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  const tables = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'seen_[0-9]*'").all<{
    name: string;
  }>();
  for (const { name } of tables.results) await testEnv.DB.prepare(`DROP TABLE ${name}`).run();
  const held = await testEnv.ENVELOPES.list();
  if (held.objects.length > 0) await testEnv.ENVELOPES.delete(held.objects.map((one) => one.key));
});

describe("reading over HTTP", () => {
  it("answers the sealed bytes as they are, with what the page needs", async () => {
    await share();
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("sealed");
    expect(response.headers.get("Folio-Version")).toBe("1");
    expect(response.headers.get("Folio-Hash")).toBe("h1");
    expect(response.headers.get("Folio-Arrived")).toBe("1234");
    expect(response.headers.get("Folio-Dies-On")).toBe(String(TODAY + 3));
  });

  it("sets the API's headers on what it serves and on what it refuses", async () => {
    await share();
    for (const response of [await get(), await get({}, "203.0.113.7", "https://tisty.cl/api/v1/docs/Nothing1")]) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      expect(response.headers.get("Server-Timing")).toContain("total;dur=");
    }
  });

  it("notes a new reader once, after answering, with the hour and without the address", async () => {
    await share();
    await get();
    await (await get()).text();
    const rows = await seen();
    expect(rows.length).toBe(1);
    expect(rows[0]?.hour).toBe(new Date().getUTCHours());
    expect(JSON.stringify(rows)).not.toContain("203.0.113");
  });

  it("counts two networks as two, and two addresses of one /48 as one", async () => {
    await share();
    await get({}, "2001:db8:1:aaaa::1");
    await get({}, "2001:db8:1:bbbb::2");
    await get({}, "2001:db8:2::1");
    expect((await seen()).length).toBe(2);
  });

  it("answers 404 to what is not there, and only there", async () => {
    await share();
    expect((await get({}, "203.0.113.7", "https://tisty.cl/api/v1/docs/short")).status).toBe(404);
    expect((await get({}, "203.0.113.7", "https://tisty.cl/other")).status).toBe(404);
    expect((await get({ method: "DELETE" })).status).toBe(404);
  });

  it("gives a start that holds, without making a document", async () => {
    const response = await get({ method: "POST" }, "203.0.113.7", "https://tisty.cl/api/v1/start");
    const { id, mac } = (await response.json()) as { id: string; mac: string };
    expect(await startHolds(testEnv.FOLIO_SECRET, id, mac, Date.now())).toBe(true);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM docs").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("what a read refuses", () => {
  const read = (over = {}, using = tools()) => readDoc({ id: ID, ip: "203.0.113.7", now: NOW, ...over }, using);

  it("a document with no row, no version, or with its object gone", async () => {
    expect(await read()).toEqual({ refused: "missing" });
    await store.create({ id: ID, owner: "o1", adminHash: "a", ttlDays: 1, net: "n" }, TODAY);
    expect(await read()).toEqual({ refused: "missing" });
    await store.upload({ ...SIGNED_BY_THE_OWNER, id: ID, n: 1, hash: "h1", body: "x", net: "n", at: 1 }, TODAY);
    await testEnv.ENVELOPES.delete(`${ID}/1.h1`);
    expect(await read()).toEqual({ refused: "missing" });
  });

  it("one being forgotten, though its versions are still in the row", async () => {
    await share();
    await testEnv.DB.prepare(`UPDATE docs SET latest = -1 WHERE id = '${ID}'`).run();
    expect(await read()).toEqual({ refused: "missing" });
  });

  it("one that ran out, even before the sweep arrives", async () => {
    await share();
    expect(await read({ now: NOW + 4 * DAY_MS })).toEqual({ refused: "missing" });
  });

  it("not one that ran out while something holds it, or a language of a living anchor", async () => {
    await share();
    await testEnv.DB.prepare(`INSERT INTO holds (held, holder) VALUES ('${ID}', 'other')`).run();
    expect(await read({ now: NOW + 4 * DAY_MS })).toHaveProperty("served", true);
    await testEnv.DB.prepare("DELETE FROM holds").run();

    await share("Anchor22");
    await testEnv.DB.prepare(`UPDATE docs SET anchor = 'Anchor22', dies_on = ? WHERE id = '${ID}'`)
      .bind(TODAY - 1)
      .run();
    expect(await read()).toHaveProperty("served", true);
  });

  it("a language whose anchor can no longer be read", async () => {
    await share();
    await share("Anchor22");
    await testEnv.DB.prepare(`UPDATE docs SET anchor = 'Anchor22', dies_on = ? WHERE id = '${ID}'`)
      .bind(TODAY - 1)
      .run();
    const anchorSet = (set: string, ...values: number[]) =>
      testEnv.DB.prepare(`UPDATE docs SET ${set} WHERE id = 'Anchor22'`)
        .bind(...values)
        .run();

    await anchorSet("blocked_at = ?", TODAY);
    expect(await read()).toEqual({ refused: "missing" });
    await anchorSet("blocked_at = NULL, paused_at = ?", TODAY);
    expect(await read()).toEqual({ refused: "missing" });
    await anchorSet("paused_at = NULL, dies_on = ?", TODAY - 1);
    expect(await read()).toEqual({ refused: "missing" });

    await testEnv.DB.prepare("INSERT INTO holds (held, holder) VALUES ('Anchor22', 'other')").run();
    expect(await read()).toHaveProperty("served", true);
  });

  it("one blocked or paused, without counting a reader", async () => {
    await share();
    await store.pause(ID, TODAY);
    expect(await read()).toEqual({ refused: "paused" });
    await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(TODAY).run();
    expect(await read()).toEqual({ refused: "blocked" });
    expect(await seen()).toEqual([]);
  });

  it("a network past the brake, before it looks at anything", async () => {
    const limiter = { allows: async () => false };
    const { spent, using } = countingQueries({ limiter });
    expect(await read({}, using)).toMatchObject({ refused: "slow", until: NOW + 60_000 });
    expect(spent()).toBe(0);
  });

  it("asks a new reader past the free ones for a proof, and serves it with the proof", async () => {
    await share();
    await testEnv.DB.prepare(
      `CREATE TABLE seen_${TODAY} (owner TEXT, reader TEXT, doc TEXT, hour INTEGER, PRIMARY KEY (owner, reader, doc)) WITHOUT ROWID`,
    ).run();
    await testEnv.DB.prepare(
      `INSERT INTO seen_${TODAY} WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       SELECT 'o1', 'r' || i, '${ID}', 9 FROM n`,
    )
      .bind(LEVEL_ONE.newReadersFree)
      .run();
    const asked = await read();
    expect(asked).toMatchObject({ refused: "proof", bits: LEVEL_ONE.proofBits });
    const nonce = await solve((asked as { salt: string }).salt);
    expect(await read({ proof: nonce })).toHaveProperty("served", true);
    expect(await read({ proof: "wrong" })).toMatchObject({ refused: "proof" });
  });

  it("serves past the ceiling with a proof, without noting", async () => {
    await share();
    const few = { ...LEVEL_ONE, newReadersFree: 1, rowsPerOwnerADay: 1, proofBits: 1 };
    await store.note({ owner: "o1", reader: "someone", doc: ID, hour: 1, proved: false }, TODAY);
    const using = tools({ store: new Cloud(testEnv, few), limits: few });
    const asked = (await read({}, using)) as { salt: string };
    const nonce = await solve(asked.salt, 1);
    const served = await read({ proof: nonce }, using);
    expect(served).toHaveProperty("served", true);
    expect(served).not.toHaveProperty("note");
  });
});

describe("the key of the day", () => {
  it("is the same all day, another the next, and yesterday's is gone", async () => {
    const first = await store.dayKey(TODAY);
    expect(await store.dayKey(TODAY)).toBe(first);
    const next = await store.dayKey(TODAY + 1);
    expect(next).not.toBe(first);
    const object = await testEnv.ENVELOPES.get("~day-key");
    expect(await object?.text()).not.toContain(first);
  });

  it("does not go back to an earlier day when an isolate is late", async () => {
    const next = await store.dayKey(TODAY + 1);
    expect(await store.dayKey(TODAY)).toBe(next);
    expect(await store.dayKey(TODAY + 1)).toBe(next);
  });

  it("is one when many ask at once", async () => {
    const keys = await Promise.all(Array.from({ length: 5 }, () => store.dayKey(TODAY)));
    expect(new Set(keys).size).toBe(1);
  });

  it("does not go with the orphans", async () => {
    await store.dayKey(TODAY);
    await store.forgetOrphans(Date.now() + 2 * DAY_MS);
    expect(await testEnv.ENVELOPES.head("~day-key")).not.toBeNull();
  });
});

describe("a network", () => {
  it("is a whole IPv4 or the /48 of an IPv6, however it is written", () => {
    expect(netOf("203.0.113.7")).toBe("203.0.113.7");
    expect(netOf("2001:DB8:1:2:3:4:5:6")).toBe("2001:0db8:0001");
    expect(netOf("2001:db8::1")).toBe("2001:0db8:0000");
    expect(netOf("::1")).toBe("0000:0000:0000");
    expect(netOf("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(netOf("::FFFF:203.0.113.7")).toBe("203.0.113.7");
  });
});

const solve = async (salt: string, bits = LEVEL_ONE.proofBits): Promise<string> => {
  const encoder = new TextEncoder();
  for (let nonce = 0; ; nonce += 1) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}|${nonce}`)));
    const first = (hash[0] ?? 0) * 256 + (hash[1] ?? 0);
    if (first >> (16 - bits) === 0) return String(nonce);
  }
};

const countingQueries = (over: Partial<ReadTools>) => {
  let queries = 0;
  const watched = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        queries += 1;
        return value.apply(target, args);
      };
    },
  });
  return { spent: () => queries, using: tools({ store: watched, ...over }) };
};

describe("the brake on a network", () => {
  it("makes it wait past what the Worker allows in a minute, saying until when", async () => {
    await share();
    let response = await get({}, "198.51.100.200");
    for (let n = 0; n < 40 && response.status === 200; n += 1) response = await get({}, "198.51.100.200");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toMatchObject({ refused: "slow" });
    expect((await get({}, "198.51.100.201")).status).toBe(200);
  });
});
