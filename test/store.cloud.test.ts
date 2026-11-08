import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import { DAY_MS, LEVEL_ONE, type Limits, REPORT_CATEGORIES } from "../src/core/limits";
import type { NewDoc, Reading } from "../src/core/store";
import { SIGNED_BY_THE_OWNER } from "./sealed";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const store = new Cloud(testEnv);
const DAY = 20_000;
const TABLES = [
  "docs",
  "service_day",
  "service_stage",
  "false_reporters",
  "net_day",
  "net_hour",
  "reports",
  "revocations",
  "editors",
  "holds",
  "openings",
];

const newDoc = (id: string, over: Partial<NewDoc> = {}): NewDoc => ({
  id,
  owner: "o1",
  adminHash: `admin-${id}`,
  ttlDays: 1,
  net: "n1",
  ...over,
});

const WEEK_AND_A_DAY = 8 * 86_400_000;

const upload = (id: string, n: number, hash = `h${n}`, net = "n1") => ({
  id,
  n,
  hash,
  body: "x".repeat(10),
  net,
  at: 1_000 + n,
  ...SIGNED_BY_THE_OWNER,
});
const reading = (reader: string, doc = "d1", over = {}) => ({
  owner: "o1",
  reader,
  doc,
  hour: 9,
  proved: false,
  ...over,
});

// What the Worker does around a read: it decides first and notes after answering.
const noted = async (cloud: Cloud, one: Reading, day: number) => {
  const admitted = await cloud.admit(one, day);
  if (admitted !== "new") return admitted;
  await cloud.note(one, day);
  return "noted";
};

const asnOf = (net: string): number => net.charCodeAt(0);

const row = (id: string) =>
  testEnv.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(id).first<{
    read_total: number;
    active_day: number;
    dies_on: number;
    latest: number;
    versions: string;
    bytes: number;
    blocked_at: number | null;
    paused_at: number | null;
    days: string;
  }>();

const objects = async (id: string) =>
  (await testEnv.ENVELOPES.list({ prefix: `${id}/` })).objects.map((one) => one.key);

const seenTables = async () =>
  (
    await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'seen_[0-9]*' ORDER BY name").all<{
      name: string;
    }>()
  ).results.map((one) => one.name);

const quota = (net = "n1", day = DAY) =>
  testEnv.DB.prepare("SELECT docs, bytes FROM net_day WHERE day = ? AND net = ?")
    .bind(day, net)
    .first<{ docs: number; bytes: number }>();

// Answers what the real statements read and wrote: `first` hides those numbers, so it runs through `all`.
const counting = () => {
  const spent = { read: 0, written: 0 };
  const note = (meta: { rows_read: number; rows_written: number }) => {
    spent.read += meta.rows_read;
    spent.written += meta.rows_written;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "run")
          return async () => {
            const answer = await target.run();
            note(answer.meta);
            return answer;
          };
        if (key === "all")
          return async () => {
            const answer = await target.all();
            note(answer.meta);
            return answer;
          };
        if (key === "first")
          return async () => {
            const answer = await target.all();
            note(answer.meta);
            return answer.results[0] ?? null;
          };
        if (key === "raw") return (target as unknown as { raw: unknown }).raw;
        return Reflect.get(target, key);
      },
    });
  const originals = new WeakMap<object, D1PreparedStatement>();
  const DB = {
    prepare: (sql: string) => {
      const real = testEnv.DB.prepare(sql);
      const seen = new Proxy(real, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              const wrapped = wrap(bound);
              originals.set(wrapped, bound);
              return wrapped;
            };
          return Reflect.get(wrap(target), key);
        },
      });
      originals.set(seen, real);
      return seen;
    },
    batch: async (statements: D1PreparedStatement[]) => {
      const answers = await testEnv.DB.batch(statements.map((one) => originals.get(one) ?? one));
      for (const one of answers) note(one.meta);
      return answers;
    },
  } as unknown as D1Database;
  return { spent, cloud: new Cloud({ DB, ENVELOPES: testEnv.ENVELOPES }) };
};

// Fails the R2 steps it is told to, leaving the rest real.
const failing = (fail: { put?: boolean; delete?: boolean }) =>
  new Cloud({
    DB: testEnv.DB,
    ENVELOPES: new Proxy(testEnv.ENVELOPES, {
      get(target, key) {
        if ((key === "put" && fail.put) || (key === "delete" && fail.delete)) {
          return () => Promise.reject(new Error("R2 fails"));
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });

const withLimits = (over: Partial<Limits>) => new Cloud(testEnv, { ...LEVEL_ONE, ...over });

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of await seenTables()) await testEnv.DB.prepare(`DROP TABLE ${table}`).run();
  for (const table of TABLES) await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  let page = await testEnv.ENVELOPES.list();
  while (page.objects.length > 0) {
    await testEnv.ENVELOPES.delete(page.objects.map((one) => one.key));
    page = await testEnv.ENVELOPES.list();
  }
});

describe("adding up the days", () => {
  it("counts every day it missed, and keeps the last activity", async () => {
    await store.create(newDoc("d1", { ttlDays: 3 }), DAY);
    await noted(store, reading("r1"), DAY);
    await noted(store, reading("r2"), DAY + 1);
    await noted(store, reading("r3"), DAY + 2);
    const swept = await store.sweep(DAY + 4);
    expect(swept.summed).toBe(3);
    const after = await row("d1");
    expect(after?.read_total).toBe(3);
    expect(after?.active_day).toBe(DAY + 2);
    expect(after?.dies_on).toBe(DAY + 5);
  });

  it("never moves the activity back when an older day is added last", async () => {
    await store.create(newDoc("d1", { ttlDays: 7 }), DAY + 5);
    await noted(store, reading("r1"), DAY);
    await store.sweep(DAY + 6);
    const after = await row("d1");
    expect(after?.active_day).toBe(DAY + 5);
    expect(after?.dies_on).toBe(DAY + 12);
  });

  it("does not add twice when it runs again", async () => {
    await store.create(newDoc("d1", { ttlDays: 3 }), DAY);
    await noted(store, reading("r1"), DAY);
    await store.sweep(DAY + 1);
    await store.sweep(DAY + 1);
    expect((await row("d1"))?.read_total).toBe(1);
  });

  it("does not count today, nor forget it", async () => {
    await store.create(newDoc("d1", { ttlDays: 3 }), DAY);
    await noted(store, reading("r1"), DAY);
    await store.sweep(DAY);
    expect((await row("d1"))?.read_total).toBe(0);
    expect(await noted(store, reading("r1"), DAY)).toBe("here");
  });

  it("keeps a day it cannot add, adds the rest, and forgets nothing meanwhile", async () => {
    await store.create(newDoc("d1", { ttlDays: 3 }), DAY);
    await store.create(newDoc("gone", { owner: "o2" }), DAY);
    await testEnv.DB.prepare(`CREATE TABLE seen_${DAY} (broken TEXT PRIMARY KEY) WITHOUT ROWID`).run();
    await noted(store, reading("r1"), DAY + 1);
    const swept = await store.sweep(DAY + 2);
    expect(swept).toMatchObject({ summed: 1, failed: 1, forgotten: 0 });
    expect((await row("d1"))?.read_total).toBe(1);
    expect(await row("gone")).not.toBeNull();
    expect(await seenTables()).toContain(`seen_${DAY}`);
  });

  it("prepares today and tomorrow, and drops what it added", async () => {
    await store.create(newDoc("d1"), DAY);
    await noted(store, reading("r1"), DAY);
    await store.sweep(DAY + 1);
    expect(await seenTables()).toEqual([`seen_${DAY + 1}`, `seen_${DAY + 2}`]);
  });
});

describe("the history of each day", () => {
  const days = async (id = "d1") => JSON.parse((await row(id))?.days ?? "{}");
  const readers = (count: number, hour: number, from = 0) =>
    Promise.all(Array.from({ length: count }, (_, i) => noted(store, reading(`r${from + i}`, "d1", { hour }), DAY)));

  it("keeps the readers and hours of a day with enough readers", async () => {
    await store.create(newDoc("d1", { ttlDays: 3 }), DAY);
    await readers(3, 9);
    await readers(2, 14, 3);
    await store.sweep(DAY + 1);
    expect(await days()).toEqual({ [DAY]: { n: 5, h: { 9: 3, 14: 2 } } });
  });

  it("keeps no hours below the least, so a link sent to one person is no read receipt", async () => {
    await store.create(newDoc("d1", { ttlDays: 3 }), DAY);
    await readers(LEVEL_ONE.hoursFromReaders - 1, 9);
    await store.sweep(DAY + 1);
    expect(await days()).toEqual({ [DAY]: { n: LEVEL_ONE.hoursFromReaders - 1 } });
  });

  it("adds a reader who arrives once the day was added, without losing what was there", async () => {
    await store.create(newDoc("d1", { ttlDays: 3 }), DAY);
    await readers(5, 9);
    await store.sweep(DAY + 1);
    await noted(store, reading("late", "d1", { hour: 23 }), DAY);
    await store.sweep(DAY + 1);
    expect(await days()).toEqual({ [DAY]: { n: 6, h: { 9: 5 } } });
    expect((await row("d1"))?.read_total).toBe(6);
    const kept = await testEnv.DB.prepare("SELECT readers FROM service_day WHERE day = ?")
      .bind(DAY)
      .first<{ readers: number }>();
    expect(kept?.readers).toBe(6);
  });

  it("lets go of what is past its days and keeps the total", async () => {
    await store.create(newDoc("d1", { ttlDays: 15 }), DAY);
    await noted(store, reading("r1"), DAY);
    await store.sweep(DAY + 1);
    const later = DAY + LEVEL_ONE.historyDays;
    await noted(store, reading("r2"), later);
    await store.sweep(later + 1);
    expect(Object.keys(await days())).toEqual([String(later)]);
    expect((await row("d1"))?.read_total).toBe(2);
  });

  it("keeps each day for the service for good, even when the document is gone", async () => {
    await store.create(newDoc("d1"), DAY);
    await noted(store, reading("r1", "d1", { hour: 9 }), DAY);
    await noted(store, reading("r2", "d1", { hour: 14 }), DAY);
    await noted(store, reading("r2", "d2", { owner: "o2", hour: 14 }), DAY);
    await store.sweep(DAY + 30);
    expect(await row("d1")).toBeNull();
    const kept = await testEnv.DB.prepare("SELECT * FROM service_day WHERE day = ?").bind(DAY).first<{
      readers: number;
      docs: number;
      hours: string;
    }>();
    expect(kept).toMatchObject({ readers: 3, docs: 2 });
    expect(JSON.parse(kept?.hours ?? "{}")).toEqual({ 9: 1, 14: 2 });
  });

  it("writes one row for the document and one for the service, however many read it", async () => {
    await store.create(newDoc("d1", { ttlDays: 3 }), DAY);
    await store.sweep(DAY + 1);
    await readers(5, 9);
    const { spent, cloud } = counting();
    await cloud.sweep(DAY + 1);
    expect(spent.written).toBe(2);
  });

  it("adds nothing to the service on a day nobody read", async () => {
    await store.sweep(DAY);
    await store.sweep(DAY + 1);
    const kept = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM service_day").first<{ n: number }>();
    expect(kept?.n).toBe(0);
  });
});

describe("expiring", () => {
  it("forgets what ran out, with its objects, and spares a document read in time", async () => {
    await store.create(newDoc("gone"), DAY);
    await store.upload(upload("gone", 1), DAY);
    await store.create(newDoc("read", { owner: "o2" }), DAY);
    await noted(store, reading("r1", "read", { owner: "o2" }), DAY + 1);
    await store.sweep(DAY + 2);
    expect(await row("gone")).toBeNull();
    expect(await objects("gone")).toEqual([]);
    expect(await row("read")).not.toBeNull();
  });

  it("forgets who edited it along with the document, and then that root has signed nothing here", async () => {
    await store.create(newDoc("gone"), DAY);
    await store.upload({ ...upload("gone", 1), signer: "editor", byOwner: false }, DAY);
    expect(await store.haveSigned(["editor", "o1"])).toBe(true);
    expect(await store.haveSigned(["editor", "nobody"])).toBe(false);
    await store.sweep(DAY + 2);
    expect(await store.haveSigned(["editor"])).toBe(false);
  });

  it("lasts between its days and one more, never less", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.sweep(DAY + 1);
    expect(await row("d1")).not.toBeNull();
    await store.sweep(DAY + 2);
    expect(await row("d1")).toBeNull();
  });

  it("does not let a late reader stretch a paused document, and ends it after its 30 days", async () => {
    await store.create(newDoc("d1", { ttlDays: 15 }), DAY);
    await store.pause("d1", DAY);
    await noted(store, reading("r1"), DAY + 29);
    await store.sweep(DAY + 30);
    expect((await row("d1"))?.dies_on).toBe(DAY + LEVEL_ONE.pausedDays);
    await store.sweep(DAY + 31);
    expect(await row("d1")).toBeNull();
  });

  it("does not let an upload reach a paused document, or stretch it", async () => {
    await store.create(newDoc("d1", { ttlDays: 15 }), DAY);
    await store.pause("d1", DAY);
    expect(await store.upload(upload("d1", 1), DAY + 29)).toBe("paused");
    expect((await row("d1"))?.dies_on).toBe(DAY + LEVEL_ONE.pausedDays);
  });

  it("does not start a pause over when it is paused again", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.pause("d1", DAY);
    await store.pause("d1", DAY + 20);
    expect((await row("d1"))?.dies_on).toBe(DAY + LEVEL_ONE.pausedDays);
  });

  it("gives a document its days back when it resumes, and only if it was paused", async () => {
    await store.create(newDoc("d1", { ttlDays: 7 }), DAY);
    await store.resume("d1", DAY + 5);
    expect((await row("d1"))?.dies_on).toBe(DAY + 7);
    await store.pause("d1", DAY);
    await store.resume("d1", DAY + 20);
    expect((await row("d1"))?.dies_on).toBe(DAY + 27);
  });

  it("keeps a blocked document as evidence for its days, even if read late", async () => {
    await store.create(newDoc("d1", { ttlDays: 15 }), DAY);
    for (const net of ["a", "b", "c"])
      await store.report({ doc: "d1", net, category: "phishing", asn: asnOf(net) }, DAY, DAY * 24);
    const lastDay = DAY + LEVEL_ONE.evidenceDays;
    await noted(store, reading("r1"), lastDay - 5);
    await store.sweep(lastDay);
    expect((await row("d1"))?.dies_on).toBe(lastDay);
    // One round lets the reports go, and the next the document they held.
    await store.sweep(lastDay + 1);
    await store.sweep(lastDay + 1);
    expect(await row("d1")).toBeNull();
  });

  it("does not let a pause or a resume touch a blocked document", async () => {
    await store.create(newDoc("d1"), DAY);
    for (const net of ["a", "b", "c"])
      await store.report({ doc: "d1", net, category: "phishing", asn: asnOf(net) }, DAY, DAY * 24);
    await store.pause("d1", DAY + 1);
    await store.resume("d1", DAY + 1);
    const after = await row("d1");
    expect(after?.dies_on).toBe(DAY + LEVEL_ONE.evidenceDays);
    expect(after?.paused_at).toBeNull();
  });

  it("keeps what is held while something holds it, and lets it go after", async () => {
    await store.create(newDoc("holder", { ttlDays: 7 }), DAY);
    await store.create(newDoc("held", { owner: "o2" }), DAY);
    await testEnv.DB.prepare("INSERT INTO holds (held, holder) VALUES ('held', 'holder')").run();
    await store.sweep(DAY + 5);
    expect(await row("held")).not.toBeNull();
    await store.sweep(DAY + 8);
    expect(await row("holder")).toBeNull();
    await store.sweep(DAY + 9);
    expect(await row("held")).toBeNull();
  });

  it("counts a language past its own days, since it lives by its anchor, and not one blocked or stopped", async () => {
    await store.create(newDoc("anchor", { ttlDays: 15 }), DAY);
    const language = (id: string) => newDoc(id, { anchor: "anchor", ttlDays: 1 });
    for (let n = 1; n < LEVEL_ONE.languagesAtMost; n += 1) {
      expect(await store.create(language(`lang${n}`), DAY)).toBe("created");
    }
    await testEnv.DB.prepare("UPDATE docs SET latest = 1 WHERE anchor = 'anchor'").run();
    expect(await store.create(language("toomany"), DAY)).toBe("languages_full");
    expect(await store.create(language("toomany"), DAY + 2)).toBe("languages_full");
    expect(await store.create(newDoc("stranger", { owner: "stranger", anchor: "anchor" }), DAY)).toBe("no_anchor");

    await store.stop("lang1", DAY + 2);
    expect(await store.create(language("afterstop"), DAY + 2)).toBe("created");
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?, dies_on = ? WHERE id = 'lang2'")
      .bind(DAY + 2, DAY + 182)
      .run();
    expect(await store.create(language("afterblock"), DAY + 2)).toBe("created");
    await testEnv.DB.prepare("UPDATE docs SET latest = 1 WHERE anchor = 'anchor'").run();
    expect(await store.create(language("toomany"), DAY + 2)).toBe("languages_full");
    await testEnv.DB.prepare("UPDATE docs SET latest = -1 WHERE id = 'lang3'").run();
    expect(await store.create(language("afterclaim"), DAY + 2)).toBe("created");
  });

  it("does not count a language that never got a version once its days pass", async () => {
    await store.create(newDoc("anchor", { ttlDays: 15 }), DAY);
    const language = (id: string) => newDoc(id, { anchor: "anchor", ttlDays: 1 });
    for (let n = 1; n < LEVEL_ONE.languagesAtMost; n += 1) await store.create(language(`lang${n}`), DAY);
    expect(await store.create(language("sameday"), DAY)).toBe("languages_full");
    expect(await store.create(language("lastday"), DAY + 1)).toBe("languages_full");
    expect(await store.create(language("later"), DAY + 2)).toBe("created");
  });

  it("counts a paused language up to its last day", async () => {
    await store.create(newDoc("anchor", { ttlDays: 15 }), DAY);
    const language = (id: string) => newDoc(id, { anchor: "anchor", ttlDays: 15 });
    for (let n = 1; n < LEVEL_ONE.languagesAtMost; n += 1) await store.create(language(`lang${n}`), DAY);
    await testEnv.DB.prepare("UPDATE docs SET paused_at = ?1, dies_on = ?1 WHERE id = 'lang1'").bind(DAY).run();
    expect(await store.create(language("sameday"), DAY)).toBe("languages_full");
    expect(await store.create(language("nextday"), DAY + 1)).toBe("created");
  });

  it("calls an anchor that is not there, or not this owner's, missing", async () => {
    expect(await store.create(newDoc("orphan", { anchor: "nothing" }), DAY)).toBe("no_anchor");
    await store.create(newDoc("anchor", { owner: "someone else" }), DAY);
    expect(await store.create(newDoc("orphan", { anchor: "anchor" }), DAY)).toBe("no_anchor");
  });

  it("keeps to the machines a root may take back, and a known one can still move earlier", async () => {
    const taken = (machine: string, at = "2026-11-02T00:00:00Z") => ({ root: "o1", machine, at, signed: "s" });
    const top = LEVEL_ONE.revokedMachinesAtMost;
    expect(await store.revoke(Array.from({ length: top }, (_, n) => taken(`m${n}`)))).toBe(true);
    expect(await store.revoke([taken("one more")])).toBe(false);
    expect(await store.revoke([taken("m0", "2026-11-01T00:00:00Z")])).toBe(true);
    const held = await testEnv.DB.prepare("SELECT COUNT(*) AS n, MIN(at) AS earliest FROM revocations").first();
    expect(held).toEqual({ n: top, earliest: Date.parse("2026-11-01T00:00:00Z") / 1000 });
    expect(await store.revoke([{ ...taken("x"), root: "another" }])).toBe(true);
    expect(await store.revoke([taken("x")])).toBe(false);
  });

  it("keeps the note of the earliest date, and no other", async () => {
    const taken = (at: string, signed: string) => ({ root: "o1", machine: "m1", at, signed });
    const signedNow = () => testEnv.DB.prepare("SELECT signed FROM revocations").first<{ signed: string }>();
    await store.revoke([taken("2026-11-02T00:00:00Z", "first")]);
    await store.revoke([taken("2026-11-02T00:00:00Z", "same date")]);
    expect((await signedNow())?.signed).toBe("first");
    await store.revoke([taken("2026-11-03T00:00:00Z", "later")]);
    expect((await signedNow())?.signed).toBe("first");
    await store.revoke([taken("2026-11-01T00:00:00Z", "earlier")]);
    expect((await signedNow())?.signed).toBe("earlier");
  });

  it("knows keys by the day they first signed", async () => {
    await store.keepKeys(["o1", "o2"], DAY);
    expect(await store.newRootsOf(["o1", "o2", "o1"], DAY)).toEqual([]);
    expect(await store.newRootsOf(["o1"], DAY - 1)).toEqual(["o1"]);
    expect(await store.newRootsOf(["o1", "nobody", "nobody"], DAY)).toEqual(["nobody"]);
  });

  it("takes a language with its anchor, and never on its own", async () => {
    await store.create(newDoc("anchor", { ttlDays: 3 }), DAY);
    await store.create(newDoc("en", { anchor: "anchor", ttlDays: 1 }), DAY);
    await store.upload(upload("en", 1), DAY);
    await store.sweep(DAY + 2);
    expect(await row("en")).not.toBeNull();
    await store.sweep(DAY + 4);
    expect(await row("anchor")).toBeNull();
    expect(await row("en")).toBeNull();
    expect(await objects("en")).toEqual([]);
  });

  it("keeps an anchor while a language of it is evidence, and lets both go after", async () => {
    await store.create(newDoc("anchor"), DAY);
    await store.create(newDoc("en", { anchor: "anchor" }), DAY);
    for (const net of ["a", "b", "c"])
      await store.report({ doc: "en", net, category: "phishing", asn: asnOf(net) }, DAY, DAY * 24);
    await store.sweep(DAY + 3);
    expect(await row("anchor")).not.toBeNull();
    expect(await row("en")).not.toBeNull();
    const after = DAY + LEVEL_ONE.evidenceDays + 1;
    await store.sweep(after);
    await store.sweep(after);
    expect(await row("en")).toBeNull();
    await store.sweep(after);
    expect(await row("anchor")).toBeNull();
  });

  it("keeps an anchor while a language of it is held", async () => {
    await store.create(newDoc("anchor"), DAY);
    await store.create(newDoc("en", { anchor: "anchor" }), DAY);
    await testEnv.DB.prepare("INSERT INTO holds (held, holder) VALUES ('en', 'other')").run();
    await store.sweep(DAY + 3);
    expect(await row("anchor")).not.toBeNull();
  });

  it("leaves what an upload left behind for the orphans, without listing R2", async () => {
    await store.create(newDoc("d1"), DAY);
    await testEnv.ENVELOPES.put("d1/9.orphan", "left behind");
    await store.sweep(DAY + 2);
    expect(await row("d1")).toBeNull();
    expect(await store.forgetOrphans(Date.now() + 2 * DAY_MS)).toBe(1);
    expect(await objects("d1")).toEqual([]);
  });

  it("forgets more objects than R2 deletes at once", async () => {
    await store.create(newDoc("d1"), DAY);
    const versions = Array.from({ length: 1005 }, (_, n) => ({ n, hash: "x", bytes: 1, at: 1 }));
    await testEnv.DB.prepare("UPDATE docs SET latest = 1004, versions = ? WHERE id = 'd1'")
      .bind(JSON.stringify(versions))
      .run();
    await Promise.all(versions.map(({ n }) => testEnv.ENVELOPES.put(`d1/${n}.x`, "x")));
    await store.sweep(DAY + 2);
    expect(await objects("d1")).toEqual([]);
  });

  it("forgets the most it may at once in a few queries, far under what D1 takes", async () => {
    for (let n = 0; n < 40; n += 1) await store.create(newDoc(`d${n}`, { owner: `o${n}` }), DAY);
    let queries = 0;
    const counted = new Cloud({
      DB: new Proxy(testEnv.DB, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "prepare") {
            return (sql: string) => {
              queries += 1;
              return target.prepare(sql);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      ENVELOPES: testEnv.ENVELOPES,
    });
    expect((await counted.sweep(DAY + 2)).forgotten).toBe(40);
    expect(queries).toBeLessThan(20);
  });

  it("forgets a language with its anchor, and lets go of what they held", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.create(newDoc("en", { anchor: "d1" }), DAY);
    await store.upload(upload("en", 1), DAY);
    await store.create(newDoc("cited", { ttlDays: 15 }), DAY);
    await testEnv.DB.prepare("INSERT INTO holds (held, holder) VALUES ('cited', 'en')").run();
    await store.sweep(DAY + 2);
    expect(await row("d1")).toBeNull();
    expect(await row("en")).toBeNull();
    expect(await objects("en")).toEqual([]);
    const held = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM holds").first<{ n: number }>();
    expect(held?.n).toBe(0);
    expect(await row("cited")).not.toBeNull();
  });

  it("forgets at most what it is allowed to at once", async () => {
    for (let n = 0; n < 5; n += 1) await store.create(newDoc(`d${n}`, { owner: `o${n}` }), DAY);
    const few = withLimits({ sweptAtOnce: 3 });
    expect((await few.sweep(DAY + 2)).forgotten).toBe(3);
    expect((await few.sweep(DAY + 2)).forgotten).toBe(2);
  });

  it("does not let R2 failing stop the cleaning", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1), DAY);
    await testEnv.DB.prepare("INSERT INTO net_day (day, net, docs, bytes) VALUES (?, 'old', 1, 1)").bind(DAY).run();
    const swept = await failing({ delete: true }).sweep(DAY + 2);
    expect(swept).toMatchObject({ failed: 1, forgotten: 0 });
    expect(await quota("old")).toBeNull();
  });

  it("finishes a document it claimed before failing, and refuses uploads to it meanwhile", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1), DAY);
    await failing({ delete: true }).sweep(DAY + 2);
    expect((await row("d1"))?.latest).toBe(-1);
    expect(await store.upload(upload("d1", 2), DAY + 2)).toBe("missing");
    expect(await store.create(newDoc("d1"), DAY + 2)).toBe("taken");
    expect((await store.sweep(DAY + 2)).forgotten).toBe(1);
    expect(await row("d1")).toBeNull();
    expect(await objects("d1")).toEqual([]);
  });

  it("does not forget a document saved after it was listed", async () => {
    await store.create(newDoc("d1"), DAY);
    const raced = new Cloud({
      DB: new Proxy(testEnv.DB, {
        get(target, key) {
          if (key === "prepare") {
            return (sql: string) => {
              if (sql.startsWith("UPDATE docs SET latest = -1")) {
                return {
                  bind: (...values: unknown[]) => ({
                    run: async () => {
                      await store.upload(upload("d1", 1), DAY + 2);
                      return target
                        .prepare(sql)
                        .bind(...values)
                        .run();
                    },
                  }),
                };
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      ENVELOPES: testEnv.ENVELOPES,
    });
    expect((await raced.sweep(DAY + 2)).forgotten).toBe(0);
    expect((await row("d1"))?.latest).toBe(1);
    expect(await objects("d1")).toEqual(["d1/1.h1"]);
  });
});

describe("room for what new keys upload", () => {
  const tenBytes = (id: string, n = 1) => ({ ...upload(id, n), newKey: true });

  it("forgets only a first version that never went, and gives its place back", async () => {
    await store.create(newDoc("sent"), DAY);
    await store.upload(upload("sent", 1), DAY);
    await store.create(newDoc("unsent"), DAY);
    const placesOf = () => testEnv.DB.prepare("SELECT docs FROM net_day WHERE net = 'n1'").first<{ docs: number }>();
    expect((await placesOf())?.docs).toBe(2);
    await store.forgetUnsent("sent", "n1", DAY);
    expect(await row("sent")).not.toBeNull();
    expect((await placesOf())?.docs).toBe(2);
    await store.forgetUnsent("unsent", "n1", DAY);
    expect(await row("unsent")).toBeNull();
    expect((await placesOf())?.docs).toBe(1);
  });

  it("lets a network reach its own share to the byte, and not one past it", async () => {
    const limited = new Cloud(testEnv, { ...LEVEL_ONE, newKeysNetBytesADay: 20 });
    await limited.create(newDoc("up"), DAY);
    await limited.create(newDoc("other", { owner: "o2" }), DAY);
    await limited.create(newDoc("third", { owner: "o3" }), DAY);
    expect(await limited.upload(tenBytes("up"), DAY)).toBe("stored");
    expect(await limited.upload(tenBytes("other"), DAY)).toBe("stored");
    expect(await limited.upload(tenBytes("third"), DAY)).toBe("new_keys_full");
  });
});

describe("orphans", () => {
  it("forgets objects with no row once they are old, and nothing else", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1), DAY);
    await testEnv.ENVELOPES.put("lost/1.x", "no row");
    const later = Date.now() + 2 * DAY_MS;
    expect(await store.forgetOrphans(later)).toBe(1);
    expect(await objects("lost")).toEqual([]);
    expect(await objects("d1")).toEqual(["d1/1.h1"]);
  });

  it("leaves one that just arrived, which may be an upload on its way", async () => {
    await testEnv.ENVELOPES.put("lost/1.x", "no row yet");
    expect(await store.forgetOrphans(Date.now())).toBe(0);
  });
});

describe("readers", () => {
  const fill = async (count: number, doc = "d1") => {
    await noted(store, reading("first", doc), DAY);
    await testEnv.DB.prepare(
      `INSERT OR IGNORE INTO seen_${DAY} WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       SELECT 'o1', 'r' || i, '${doc}', 9 FROM n`,
    )
      .bind(count - 1)
      .run();
  };

  it("writes one row for a new reader and none for one who came back", async () => {
    await noted(store, reading("r0"), DAY);
    const { spent, cloud } = counting();
    await noted(cloud, reading("r1"), DAY);
    expect(spent.written).toBe(1);
    await noted(cloud, reading("r1"), DAY);
    expect(spent.written).toBe(1);
  });

  it("creates the day's table if nothing did", async () => {
    expect(await noted(store, reading("r1"), DAY)).toBe("noted");
    expect(await noted(store, reading("r1"), DAY)).toBe("here");
  });

  it("asks for a proof past the free readers", async () => {
    await fill(LEVEL_ONE.newReadersFree);
    expect(await noted(store, reading("new"), DAY)).toBe("over");
    expect(await noted(store, reading("new", "d1", { proved: true }), DAY)).toBe("noted");
  });

  it("never asks again of one who already read today, on any document", async () => {
    await fill(LEVEL_ONE.newReadersFree);
    expect(await noted(store, reading("first"), DAY)).toBe("here");
    expect(await noted(store, reading("first", "d2"), DAY)).toBe("noted");
  });

  it("stops noting at the ceiling, even with a proof", async () => {
    await fill(LEVEL_ONE.rowsPerOwnerADay);
    expect(await noted(store, reading("new", "d1", { proved: true }), DAY)).toBe("full");
    const held = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM seen_${DAY}`).first<{ n: number }>();
    expect(held?.n).toBe(LEVEL_ONE.rowsPerOwnerADay);
  });

  it("deciding writes nothing, and without a table it lets the reader in without making one", async () => {
    const { spent, cloud } = counting();
    expect(await cloud.admit(reading("r1"), DAY)).toBe("new");
    expect(spent.written).toBe(0);
    expect(await seenTables()).toEqual([]);
    await cloud.note(reading("r1"), DAY);
    expect(await cloud.admit(reading("r1"), DAY)).toBe("here");
  });

  it("asks for the proof before the ceiling, so nobody gets in free or makes it count every row", async () => {
    await fill(LEVEL_ONE.rowsPerOwnerADay);
    const { spent, cloud } = counting();
    expect(await cloud.admit(reading("new"), DAY)).toBe("over");
    expect(spent.read).toBeLessThanOrEqual(LEVEL_ONE.newReadersFree + 5);
  });

  it("reads a few hundred rows at most while readers are free", async () => {
    await fill(LEVEL_ONE.newReadersFree - 1);
    const { spent, cloud } = counting();
    await noted(cloud, reading("new"), DAY);
    expect(spent.read).toBeLessThanOrEqual(LEVEL_ONE.newReadersFree + 5);
  });

  it("reads at most its ceiling and its free readers however many there are", async () => {
    await fill(LEVEL_ONE.rowsPerOwnerADay);
    await testEnv.DB.prepare(`INSERT INTO seen_${DAY} VALUES ('o1', 'extra', 'd1', 9)`).run();
    const { spent, cloud } = counting();
    await noted(cloud, reading("new", "d1", { proved: true }), DAY);
    expect(spent.read).toBeLessThanOrEqual(LEVEL_ONE.rowsPerOwnerADay + LEVEL_ONE.newReadersFree + 5);
  });
});

describe("what was claimed", () => {
  it("goes a round at a time, however much there is", async () => {
    const few = withLimits({ sweptAtOnce: 1 });
    for (const id of ["d1", "d2", "d3"]) await store.create(newDoc(id, { owner: id }), DAY);
    await testEnv.DB.prepare("UPDATE docs SET latest = -1").run();
    expect((await few.sweep(DAY)).forgotten).toBe(1);
    expect((await few.sweep(DAY)).forgotten).toBe(1);
    expect((await few.sweep(DAY)).forgotten).toBe(1);
  });
});

describe("what the hour's count writes", () => {
  it("writes one row while it counts, and none past the ceiling", async () => {
    const { spent, cloud } = counting();
    expect(await cloud.takeHourly("n", "report", 1, 2)).toBe(true);
    expect(await cloud.takeHourly("n", "report", 1, 2)).toBe(true);
    expect(spent.written).toBe(2);
    expect(await cloud.takeHourly("n", "report", 1, 2)).toBe(false);
    expect(spent.written).toBe(2);
    expect(await cloud.takeHourly("n", "report", 2, 2)).toBe(true);
    expect(spent.written).toBe(3);
    expect(await cloud.takeHourly("n", "report", 2, 2)).toBe(true);
    expect(await cloud.takeHourly("n", "report", 2, 2)).toBe(false);
  });
});

describe("creating", () => {
  it("stops at the owner's shares", async () => {
    expect(await store.create(newDoc("d1"), DAY)).toBe("created");
    expect(await store.create(newDoc("d2"), DAY)).toBe("created");
    expect(await store.create(newDoc("d3"), DAY)).toBe("shares_full");
  });

  it("does not count as a share what only evidence keeps", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.create(newDoc("d2", { ttlDays: 15 }), DAY);
    await store.report({ doc: "d1", net: "n", category: "phishing", asn: 1 }, DAY, DAY * 24);
    expect(await store.create(newDoc("d3"), DAY + 5)).toBe("created");
  });

  it("gives the quota back when it refuses", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.create(newDoc("d2"), DAY);
    await store.create(newDoc("d3"), DAY);
    expect((await quota())?.docs).toBe(2);
  });

  it("stops at the shares when many arrive at once", async () => {
    const answers = await Promise.all(["a", "b", "c", "d"].map((id) => store.create(newDoc(id), DAY)));
    expect(answers.filter((one) => one === "created").length).toBe(LEVEL_ONE.sharesAtMost);
  });

  it("does not count languages or what is held as shares", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.create(newDoc("en", { anchor: "d1" }), DAY);
    await store.create(newDoc("d2"), DAY);
    await testEnv.DB.prepare("INSERT INTO holds (held, holder) VALUES ('d2', 'd1')").run();
    expect(await store.create(newDoc("d3"), DAY)).toBe("created");
  });

  it("does not count what is blocked, so three networks cannot leave someone without shares", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.create(newDoc("d2"), DAY);
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ? WHERE id = 'd1'").bind(DAY).run();
    expect(await store.create(newDoc("d3"), DAY)).toBe("created");
  });

  it("refuses a language of an anchor that is missing, another's, or a language itself", async () => {
    await store.create(newDoc("mine"), DAY);
    await store.create(newDoc("theirs", { owner: "o2" }), DAY);
    await store.create(newDoc("en", { anchor: "mine" }), DAY);
    expect(await store.create(newDoc("x1", { anchor: "nobody" }), DAY)).toBe("no_anchor");
    expect(await store.create(newDoc("x2", { anchor: "" }), DAY)).toBe("no_anchor");
    expect(await store.create(newDoc("x3", { anchor: "theirs" }), DAY)).toBe("no_anchor");
    expect(await store.create(newDoc("x4", { anchor: "en" }), DAY)).toBe("no_anchor");
  });

  it("takes a lost answer as the same document, and another's id as taken", async () => {
    await store.create(newDoc("d1"), DAY);
    expect(await store.create(newDoc("d1"), DAY)).toBe("same");
    expect(await store.create(newDoc("d1", { adminHash: "other" }), DAY)).toBe("taken");
    expect(await store.create(newDoc("d1", { owner: "o2" }), DAY)).toBe("taken");
    expect(await store.create(newDoc("d1", { permit: "another-key" }), DAY)).toBe("taken");
    expect((await quota())?.docs).toBe(1);
  });

  it("keeps who may edit, and nobody when its owner allowed no one", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.create(newDoc("d2", { permit: "a-public-key" }), DAY);
    const permits = await testEnv.DB.prepare("SELECT id, permit FROM docs WHERE id IN ('d1', 'd2') ORDER BY id").all();
    expect(permits.results).toEqual([
      { id: "d1", permit: null },
      { id: "d2", permit: "a-public-key" },
    ]);
  });

  it("refuses a time nobody can choose", async () => {
    for (const ttlDays of [0, 2, 16, Number.NaN, 1e300, -1]) {
      expect(await store.create(newDoc("d1", { ttlDays }), DAY)).toBe("bad_ttl");
    }
  });

  it("stops a network at its documents of the day", async () => {
    const few = withLimits({ netDocsADay: 2, sharesAtMost: 10 });
    expect(await few.create(newDoc("d1"), DAY)).toBe("created");
    expect(await few.create(newDoc("d2"), DAY)).toBe("created");
    expect(await few.create(newDoc("d3"), DAY)).toBe("quota");
    expect(await few.create(newDoc("d3", { net: "other" }), DAY)).toBe("created");
  });
});

describe("uploading", () => {
  it("keeps when each version arrived (decision 134)", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload({ ...upload("d1", 1), at: 12_345 }, DAY);
    const versions = JSON.parse((await row("d1"))?.versions ?? "[]") as { at: number }[];
    expect(versions.map((one) => one.at)).toEqual([12_345]);
  });

  it("keeps the latest, and the one it just replaced for its days, with their objects", async () => {
    await store.create(newDoc("d1"), DAY);
    for (let n = 1; n <= 3; n += 1) {
      expect(await store.upload({ ...upload("d1", n), at: n * WEEK_AND_A_DAY }, DAY)).toBe("stored");
    }
    const after = await row("d1");
    const versions = JSON.parse(after?.versions ?? "[]") as { n: number }[];
    expect(versions.map((one) => one.n)).toEqual([2, 3]);
    expect(after?.bytes).toBe(20);
    expect((await objects("d1")).length).toBe(2);
  });

  it("gives one winner to two uploads at once, whose object and sizes agree", async () => {
    await store.create(newDoc("d1"), DAY);
    const answers = await Promise.all([
      store.upload(upload("d1", 1, "a"), DAY),
      store.upload(upload("d1", 1, "b"), DAY),
    ]);
    expect(answers.sort()).toEqual(["behind", "stored"]);
    const versions = JSON.parse((await row("d1"))?.versions ?? "[]") as { hash: string }[];
    expect(versions.length).toBe(1);
    expect(await objects("d1")).toEqual([`d1/1.${versions[0]?.hash}`]);
    expect((await quota())?.bytes).toBe(10);
  });

  it("does not delete what it kept when the same bytes go up twice at once", async () => {
    await store.create(newDoc("d1"), DAY);
    const answers = await Promise.all([
      store.upload(upload("d1", 1, "a"), DAY),
      store.upload(upload("d1", 1, "a"), DAY),
    ]);
    expect(answers.sort()).toEqual(["same", "stored"]);
    expect(await objects("d1")).toEqual(["d1/1.a"]);
  });

  it("takes a retry as done and an old version as behind", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1, "a"), DAY);
    expect(await store.upload(upload("d1", 1, "a"), DAY)).toBe("same");
    expect(await store.upload(upload("d1", 1, "other"), DAY)).toBe("behind");
    expect(await store.upload(upload("d1", 5), DAY)).toBe("behind");
  });

  it("is not stuck by an object an upload left behind", async () => {
    await store.create(newDoc("d1"), DAY);
    await testEnv.ENVELOPES.put("d1/1.dead", "died before D1");
    expect(await store.upload(upload("d1", 1, "a"), DAY)).toBe("stored");
  });

  it("gives the quota back when R2 fails", async () => {
    await store.create(newDoc("d1"), DAY);
    await expect(failing({ put: true }).upload(upload("d1", 1), DAY)).rejects.toThrow("R2 fails");
    expect((await quota())?.bytes).toBe(0);
    expect((await row("d1"))?.latest).toBe(0);
  });

  it("keeps a document alive, and refuses one that is blocked or missing", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1), DAY + 1);
    expect((await row("d1"))?.dies_on).toBe(DAY + 2);
    expect(await store.upload(upload("nobody", 1), DAY)).toBe("missing");
    for (const net of ["a", "b", "c"])
      await store.report({ doc: "d1", net, category: "malware", asn: asnOf(net) }, DAY, DAY * 24);
    expect(await store.upload(upload("d1", 2), DAY)).toBe("blocked");
  });

  it("keeps the group alive when a language gets a new version", async () => {
    await store.create(newDoc("anchor"), DAY);
    await store.create(newDoc("en", { anchor: "anchor" }), DAY);
    await store.upload(upload("en", 1), DAY + 1);
    await store.sweep(DAY + 2);
    expect(await row("anchor")).not.toBeNull();
    expect(await row("en")).not.toBeNull();
  });

  it("counts a document once, not once per version", async () => {
    await store.create(newDoc("d1"), DAY);
    for (let n = 1; n <= LEVEL_ONE.netDocsADay + 2; n += 1) {
      expect(await store.upload(upload("d1", n), DAY)).toBe("stored");
    }
    expect((await quota())?.docs).toBe(1);
  });

  it("stops a network at its bytes of the day, however it adds up", async () => {
    const few = withLimits({ netBytesADay: 25 });
    await few.create(newDoc("d1"), DAY);
    expect(await few.upload(upload("d1", 1), DAY)).toBe("stored");
    expect(await few.upload(upload("d1", 2), DAY)).toBe("stored");
    expect(await few.upload(upload("d1", 3), DAY)).toBe("quota");
    expect(await few.upload(upload("d1", 3, "h", "other"), DAY)).toBe("stored");
    expect(await few.upload({ ...upload("d1", 4, "big", "third"), body: "x".repeat(26) }, DAY)).toBe("quota");
  });

  it("counts what arrived, whatever anyone says it weighs", async () => {
    await store.create(newDoc("d1"), DAY);
    const bytes = new TextEncoder().encode("añó");
    await store.upload({ ...upload("d1", 1), body: bytes }, DAY);
    expect((await row("d1"))?.bytes).toBe(bytes.byteLength);
    await store.upload({ ...upload("d1", 2), body: "añó" }, DAY);
    expect((await row("d1"))?.bytes).toBe(2 * bytes.byteLength);
  });
});

describe("the levels of a report", () => {
  const TEN_NETS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const SEALED = "sealed1.link";
  const report = (category: string, net: string, sealedLink?: string, day = DAY) =>
    store.report(
      { doc: "d1", net, category, asn: asnOf(net), ...(sealedLink === undefined ? {} : { sealedLink }) },
      day,
      day * 24,
    );
  const fixBy = async () =>
    (await testEnv.DB.prepare("SELECT fix_by FROM docs WHERE id = 'd1'").first<{ fix_by: number | null }>())?.fix_by;
  const reportRows = () =>
    testEnv.DB.prepare("SELECT net, version, level, cleared FROM reports ORDER BY net").all<{
      net: string;
      version: number;
      level: string;
      cleared: number;
    }>();

  beforeEach(async () => {
    await store.create(newDoc("d1", { ttlDays: 15 }), DAY);
    await store.upload(upload("d1", 1), DAY);
  });

  it("keeps which version and what level each one was", async () => {
    await report("spam", "a");
    await store.upload(upload("d1", 2), DAY);
    await report("csam", "b");
    expect((await reportRows()).results).toEqual([
      { net: "a", version: 1, level: "light", cleared: 1 },
      { net: "b", version: 2, level: "grave", cleared: 0 },
    ]);
  });

  it("warns the author at ten networks of light reports, and blocks nobody", async () => {
    for (const net of TEN_NETS.slice(0, 9)) await report(net === "a" ? "offensive" : "spam", net);
    expect(await fixBy()).toBeNull();
    expect((await report("spam", "j", undefined, DAY)).blocked).toBe(false);
    expect(await fixBy()).toBe(DAY + LEVEL_ONE.lightFixDays);
    expect((await row("d1"))?.blocked_at).toBeNull();
    await report("spam", "k", undefined, DAY + 1);
    expect(await fixBy()).toBe(DAY + LEVEL_ONE.lightFixDays);
  });

  it("counts only the last day's light reports", async () => {
    for (const net of TEN_NETS.slice(0, 9)) await report("spam", net, undefined, DAY);
    await report("spam", "j", undefined, DAY + 1);
    expect(await fixBy()).toBeNull();
    await testEnv.DB.prepare("UPDATE reports SET at_hour = ? WHERE net = 'a'")
      .bind((DAY + 1) * 24 - 23)
      .run();
    await report("spam", "k", undefined, DAY + 1);
    expect(await fixBy()).toBeNull();
    await testEnv.DB.prepare("UPDATE reports SET at_hour = ?")
      .bind((DAY + 1) * 24 - 23)
      .run();
    await report("spam", "l", undefined, DAY + 1);
    expect(await fixBy()).toBe(DAY + 1 + LEVEL_ONE.lightFixDays);
  });

  it("does not warn for ten networks of one operator, as with what blocks", async () => {
    const sameOperator = (net: string) => store.report({ doc: "d1", net, category: "spam", asn: 7 }, DAY, DAY * 24);
    for (const net of TEN_NETS) await sameOperator(net);
    expect(await fixBy()).toBeNull();
    await report("spam", "k");
    expect(await fixBy()).toBe(DAY + LEVEL_ONE.lightFixDays);
  });

  it("keeps the version the reader saw, even after clean ones replace it", async () => {
    await store.upload(upload("d1", 2), DAY);
    await store.report({ doc: "d1", net: "a", category: "phishing", asn: 1, version: 1 }, DAY, DAY * 24);
    for (let n = 3; n <= LEVEL_ONE.versionsKept + 4; n += 1) {
      await store.upload({ ...upload("d1", n), at: n * WEEK_AND_A_DAY }, DAY);
    }
    expect((await reportRows()).results[0]?.version).toBe(1);
    expect(await objects("d1")).toContain("d1/1.h1");
    expect(await objects("d1")).not.toContain("d1/2.h2");
  });

  it("goes to the latest version when it names one the server does not hold", async () => {
    await store.report({ doc: "d1", net: "a", category: "phishing", asn: 1, version: 99 }, DAY, DAY * 24);
    expect((await reportRows()).results[0]?.version).toBe(1);
  });

  it("takes the link a network brings later, and that one counts to block", async () => {
    await report("threat", "a");
    await report("threat", "a", SEALED);
    const linked = await testEnv.DB.prepare("SELECT sealed_link FROM reports WHERE net = 'a'").first<{
      sealed_link: string;
    }>();
    expect(linked?.sealed_link).toBe(SEALED);
    await report("threat", "b", SEALED);
    expect((await report("threat", "c", SEALED)).blocked).toBe(true);
  });

  it("rises with a network that says it is worse, and never falls or loses its link", async () => {
    await report("spam", "a");
    await report("csam", "a");
    await report("phishing", "b", SEALED);
    await report("threat", "b");
    await report("spam", "b");
    await report("phishing", "b");
    const rows = await testEnv.DB.prepare("SELECT net, category, level, sealed_link FROM reports ORDER BY net").all();
    expect(rows.results).toEqual([
      { net: "a", category: "csam", level: "grave", sealed_link: null },
      { net: "b", category: "threat", level: "grave", sealed_link: SEALED },
    ]);
  });

  it("does not move a report that says nothing new", async () => {
    await report("threat", "a", SEALED, DAY);
    await report("threat", "a", SEALED, DAY + 1);
    const kept = await testEnv.DB.prepare("SELECT at FROM reports WHERE net = 'a'").first<{ at: number }>();
    expect(kept?.at).toBe(DAY);
  });

  it("leaves nothing to correct once an appeal is accepted", async () => {
    for (const net of ["a", "b", "c"]) await report("spam", net);
    for (const net of ["d", "e", "f"]) await report("phishing", net);
    expect((await row("d1"))?.blocked_at).not.toBeNull();
    await store.appeal("d1", DAY, DAY * 24);
    await store.appealAccepted("d1", DAY);
    expect(await fixBy()).toBeNull();
    expect((await row("d1"))?.blocked_at).toBeNull();
  });

  it("clears light reports with a new version, on record, and they can come again", async () => {
    for (const net of TEN_NETS) await report("spam", net);
    expect(await store.upload(upload("d1", 2), DAY + 9)).toBe("stored");
    expect(await fixBy()).toBeNull();
    expect((await reportRows()).results.every((one) => one.cleared === 1)).toBe(true);
    for (const net of TEN_NETS.slice(0, 9)) await report("spam", net);
    expect(await fixBy()).toBeNull();
    await report("spam", "j");
    expect(await fixBy()).toBe(DAY + LEVEL_ONE.lightFixDays);
  });

  it("does not clear with a new version what is not light", async () => {
    await report("phishing", "a");
    await report("phishing", "b");
    await store.upload(upload("d1", 2), DAY);
    expect((await report("phishing", "c")).blocked).toBe(true);
  });

  it("does not mix light reports with those that block", async () => {
    await report("spam", "a");
    await report("spam", "b");
    expect((await report("phishing", "c")).blocked).toBe(false);
    expect(await fixBy()).toBeNull();
  });

  it("blocks for a grave one only with the link, so someone can review it", async () => {
    await report("threat", "a");
    await report("threat", "b");
    expect((await report("threat", "c")).blocked).toBe(false);
    await report("threat", "d", SEALED);
    await report("threat", "e", SEALED);
    expect((await report("doxxing", "f", SEALED)).blocked).toBe(true);
  });

  it("holds as evidence a grave one that brought no link", async () => {
    await report("threat", "a");
    await store.sweep(DAY + 30);
    expect(await row("d1")).not.toBeNull();
  });
});

describe("reports", () => {
  const report = (net: string, doc = "d1", day = DAY) =>
    store.report({ doc, net, category: "phishing", asn: asnOf(net) }, day, day * 24);

  it("blocks at three networks, once", async () => {
    await store.create(newDoc("d1"), DAY);
    expect((await report("a")).blocked).toBe(false);
    expect((await report("b")).blocked).toBe(false);
    expect((await report("c")).blocked).toBe(true);
    expect((await report("d")).blocked).toBe(false);
    expect((await row("d1"))?.blocked_at).toBe(DAY);
  });

  it("does not let one network count twice", async () => {
    await store.create(newDoc("d1"), DAY);
    for (let n = 0; n < 5; n += 1) expect((await report("a")).blocked).toBe(false);
  });

  it("blocks when the third arrives at once with the others", async () => {
    await store.create(newDoc("d1"), DAY);
    const answers = await Promise.all(["a", "b", "c", "d"].map((net) => report(net)));
    expect(answers.filter((one) => one.blocked).length).toBe(1);
  });

  it("writes nothing for a document that does not exist", async () => {
    await report("a", "nobody");
    const held = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(held?.n).toBe(0);
  });

  it("does not block with three networks of one operator, and does with a second", async () => {
    await store.create(newDoc("d1"), DAY);
    const from = (net: string, asn: number) =>
      store.report({ doc: "d1", net, category: "phishing", asn }, DAY, DAY * 24);
    expect((await from("a", 7)).blocked).toBe(false);
    expect((await from("b", 7)).blocked).toBe(false);
    expect((await from("c", 7)).blocked).toBe(false);
    expect((await from("d", 7)).blocked).toBe(false);
    expect((await from("e", 8)).blocked).toBe(true);
  });

  it("does not block with two operators and only two networks", async () => {
    await store.create(newDoc("d1"), DAY);
    expect((await report("a")).blocked).toBe(false);
    expect((await report("b")).blocked).toBe(false);
  });

  const foundFalse = (net: string, doc = "d1", day = DAY) =>
    new CloudModeration(testEnv.DB).reportWasFalse(doc, net, day * DAY_MS);

  it("does not let the same networks undo an accepted appeal, and asks others for three", async () => {
    await store.create(newDoc("d1"), DAY);
    for (const net of ["a", "b", "c"]) await report(net);
    await store.appealAccepted("d1", DAY);
    expect((await row("d1"))?.blocked_at).toBeNull();
    for (const net of ["a", "b", "c"]) expect((await report(net)).blocked).toBe(false);
    expect((await report("d")).blocked).toBe(false);
    expect((await report("e")).blocked).toBe(false);
    expect((await report("f")).blocked).toBe(true);
  });

  describe("the email a reporter leaves", () => {
    const contactOf = async (net = "a") =>
      (
        await testEnv.DB.prepare("SELECT sealed_contact FROM reports WHERE net = ?")
          .bind(net)
          .first<{ sealed_contact: string | null }>()
      )?.sealed_contact;
    const reporting = (net: string, sealedContact?: string) =>
      store.report(
        { doc: "d1", net, category: "phishing", asn: 1, ...(sealedContact ? { sealedContact } : {}) },
        DAY,
        DAY * 24,
      );

    it("is kept as it came", async () => {
      await store.create(newDoc("d1"), DAY);
      await store.report(
        { doc: "d1", net: "a", category: "spam", asn: 1, sealedContact: "contact1.one" },
        DAY,
        DAY * 24,
      );
      expect(await contactOf()).toBe("contact1.one");
    });

    it("can arrive on a second report, without moving anything else", async () => {
      await store.create(newDoc("d1"), DAY);
      await reporting("a");
      await reporting("a", "contact1.one");
      expect(await contactOf()).toBe("contact1.one");
    });

    it("stays when the same network reports again without one", async () => {
      await store.create(newDoc("d1"), DAY);
      await reporting("a", "contact1.one");
      await store.report({ doc: "d1", net: "a", category: "malware", asn: 1 }, DAY, DAY * 24);
      expect(await contactOf()).toBe("contact1.one");
    });

    it("does not take another person's on the same network", async () => {
      await store.create(newDoc("d1"), DAY);
      await reporting("a", "contact1.one");
      await reporting("a", "contact1.two");
      expect(await contactOf()).toBe("contact1.one");
    });

    it("keeps the first when a link arrives with another address", async () => {
      await store.create(newDoc("d1"), DAY);
      await reporting("a", "contact1.one");
      await store.report(
        {
          doc: "d1",
          net: "a",
          category: "phishing",
          asn: 1,
          sealedLink: "sealed1.link",
          sealedContact: "contact1.two",
        },
        DAY,
        DAY * 24,
      );
      expect(await contactOf()).toBe("contact1.one");
    });

    it("goes with who raised the report, so nobody is asked about what another said", async () => {
      await store.create(newDoc("d1"), DAY);
      await reporting("a", "contact1.one");
      const raising = { doc: "d1", net: "a", category: "csam", asn: 1, sealedLink: "sealed1.link" };
      await store.report({ ...raising, sealedContact: "contact1.two" }, DAY, DAY * 24);
      expect(await contactOf()).toBe("contact1.two");
      await store.create(newDoc("d2"), DAY);
      await store.report(
        { doc: "d2", net: "b", category: "phishing", asn: 1, sealedContact: "contact1.one" },
        DAY,
        DAY * 24,
      );
      await store.report({ doc: "d2", net: "b", category: "csam", asn: 1, sealedLink: "sealed1.link" }, DAY, DAY * 24);
      expect(await contactOf("b")).toBeNull();
    });

    it("moves nothing else when it arrives alone", async () => {
      await store.create(newDoc("d1"), DAY);
      await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'd1'")
        .bind(DAY + 200)
        .run();
      await store.report({ doc: "d1", net: "a", category: "phishing", asn: 1, detail: "first" }, DAY, DAY * 24);
      await store.report(
        { doc: "d1", net: "a", category: "phishing", asn: 2, detail: "second", sealedContact: "contact1.one" },
        DAY + 170,
        (DAY + 170) * 24,
      );
      const row = await testEnv.DB.prepare("SELECT at, at_hour, asn, detail, sealed_contact FROM reports").first();
      expect(row).toEqual({ at: DAY, at_hour: DAY * 24, asn: 1, detail: "first", sealed_contact: "contact1.one" });
    });

    it("leaves a link that arrives later moving the report as before", async () => {
      await store.create(newDoc("d1"), DAY);
      await reporting("a");
      await store.report(
        { doc: "d1", net: "a", category: "phishing", asn: 2, sealedLink: "sealed1.link" },
        DAY + 1,
        (DAY + 1) * 24,
      );
      const row = await testEnv.DB.prepare("SELECT at, asn FROM reports").first();
      expect(row).toEqual({ at: DAY + 1, asn: 2 });
    });

    it("does not revive a cleared report", async () => {
      await store.create(newDoc("d1"), DAY);
      for (const net of ["a", "b", "c"]) await report(net);
      await store.appealAccepted("d1", DAY);
      await reporting("a", "contact1.one");
      expect(await contactOf()).toBeNull();
      const row = await testEnv.DB.prepare("SELECT cleared FROM reports WHERE net = 'a'").first<{ cleared: number }>();
      expect(row?.cleared).toBe(1);
    });

    it("is erased with its report", async () => {
      await store.create(newDoc("d1"), DAY);
      await reporting("a", "contact1.one");
      await store.sweep(DAY + 181);
      expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>())?.n).toBe(0);
    });
  });

  describe("after an accepted appeal", () => {
    const lifted = async () => {
      await store.create(newDoc("d1"), DAY);
      for (const net of ["a", "b", "c"]) await report(net);
      await store.appealAccepted("d1", DAY);
    };
    const reportingAgain = (net: string, category: string, sealedLink?: string) =>
      store.report({ doc: "d1", net, category, asn: 1, ...(sealedLink ? { sealedLink } : {}) }, DAY, DAY * 24);
    const counted = async () =>
      (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE cleared = 0").first<{ n: number }>())?.n;

    it("does not revive a report for bringing its link now", async () => {
      await lifted();
      for (const net of ["a", "b", "c"]) await reportingAgain(net, "phishing", "sealed1.link");
      expect(await counted()).toBe(0);
      expect((await row("d1"))?.blocked_at).toBeNull();
    });

    it("does not revive a report for saying it is worse about the same version", async () => {
      await lifted();
      for (const net of ["a", "b", "c"]) await reportingAgain(net, "csam", "sealed1.link");
      expect(await counted()).toBe(0);
    });

    it("hears the same networks about a newer version, child abuse included", async () => {
      await lifted();
      await testEnv.DB.prepare("UPDATE docs SET latest = latest + 1 WHERE id = 'd1'").run();
      await reportingAgain("a", "csam", "sealed1.link");
      const heard = await testEnv.DB.prepare("SELECT category, cleared FROM reports WHERE net = 'a'").first();
      expect(heard).toEqual({ category: "csam", cleared: 0 });
    });
  });

  it("does not count against a network elsewhere that its report on an appealed document was cleared", async () => {
    await store.create(newDoc("d1"), DAY);
    for (const net of ["a", "b", "c"]) await report(net);
    await store.appealAccepted("d1", DAY);
    await store.create(newDoc("d2", { owner: "o2" }), DAY);
    expect((await report("a", "d2")).blocked).toBe(false);
    expect((await report("b", "d2")).blocked).toBe(false);
    expect((await report("c", "d2")).blocked).toBe(true);
  });

  it("carries a report found false to other documents, and does not let them hold one past its days", async () => {
    await store.create(newDoc("d1"), DAY);
    for (const net of ["a", "b", "c"]) await report(net);
    for (const net of ["a", "b", "c"]) await foundFalse(net, "d1", DAY - 1);
    await store.create(newDoc("d2", { owner: "o2" }), DAY);
    for (const net of ["a", "b", "c"]) expect((await report(net, "d2")).blocked).toBe(false);
    await store.sweep(DAY + 5);
    expect(await row("d2")).toBeNull();
  });

  it("keeps their reports as a record", async () => {
    await store.create(newDoc("d1"), DAY);
    for (const net of ["a", "b", "c"]) await report(net);
    await store.appealAccepted("d1", DAY);
    const held = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(held?.n).toBe(3);
  });

  it("counts them again once the evidence days pass", async () => {
    await store.create(newDoc("d1"), DAY);
    for (const net of ["a", "b", "c"]) await report(net);
    for (const net of ["a", "b", "c"]) await foundFalse(net);
    const flagged = () => testEnv.DB.prepare("SELECT COUNT(*) AS n FROM false_reporters").first<{ n: number }>();
    expect((await flagged())?.n).toBe(3);
    await store.sweep(DAY + LEVEL_ONE.evidenceDays);
    expect((await flagged())?.n).toBe(3);
    await store.sweep(DAY + LEVEL_ONE.evidenceDays + 1);
    expect((await flagged())?.n).toBe(0);
  });

  it("starts the days again when the same network reports falsely once more", async () => {
    await store.create(newDoc("d1"), DAY);
    for (const net of ["a", "b", "c"]) await report(net);
    await foundFalse("a");

    await store.create(newDoc("d2"), DAY + 100);
    await store.report({ doc: "d2", net: "a", category: "phishing", asn: 1 }, DAY + 100, (DAY + 100) * 24);
    await foundFalse("a", "d2", DAY + 100);

    const again = await testEnv.DB.prepare("SELECT at FROM false_reporters WHERE net = 'a'").first<{ at: number }>();
    expect(again?.at).toBe(DAY + 100);
  });

  it("marks nobody when the appeal finds nothing blocked", async () => {
    await store.create(newDoc("d1"), DAY);
    await report("a");
    await store.appealAccepted("d1", DAY);
    const flagged = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM false_reporters").first<{ n: number }>();
    expect(flagged?.n).toBe(0);
  });

  it("keeps a paused document's days through an appeal, and does nothing if it was not blocked", async () => {
    await store.create(newDoc("d1", { ttlDays: 15 }), DAY);
    await store.pause("d1", DAY);
    await store.appealAccepted("d1", DAY + 1);
    expect((await row("d1"))?.dies_on).toBe(DAY + LEVEL_ONE.pausedDays);
    await store.resume("d1", DAY + 1);
    for (const net of ["a", "b", "c"]) await report(net, "d1", DAY + 1);
    await store.pause("d1", DAY + 1);
    await store.appealAccepted("d1", DAY + 2);
    expect((await row("d1"))?.dies_on).toBe(DAY + 17);
  });

  it("keeps a report for its evidence days, past a document whose report was cleared", async () => {
    await store.create(newDoc("d1"), DAY);
    await report("a");
    await testEnv.DB.prepare("UPDATE reports SET cleared = 1").run();
    await store.sweep(DAY + 5);
    expect(await row("d1")).toBeNull();
    const kept = () => testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect((await kept())?.n).toBe(1);
    await store.sweep(DAY + LEVEL_ONE.evidenceDays + 1);
    expect((await kept())?.n).toBe(0);
  });
});

describe("what was reported", () => {
  const report = (doc = "d1", category = "phishing", net = "a", day = DAY) =>
    store.report({ doc, net, category, asn: asnOf(net) }, day, day * 24);
  const sealedRows = () => testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();

  it("outlives its days until the evidence runs out, and then goes", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1), DAY);
    await report();
    await store.sweep(DAY + 5);
    expect(await row("d1")).not.toBeNull();
    expect(await objects("d1")).toEqual(["d1/1.h1"]);
    const lastDay = DAY + LEVEL_ONE.evidenceDays;
    await store.sweep(lastDay);
    expect(await row("d1")).not.toBeNull();
    await store.sweep(lastDay + 1);
    expect((await sealedRows())?.n).toBe(0);
    await store.sweep(lastDay + 1);
    expect(await row("d1")).toBeNull();
    expect(await objects("d1")).toEqual([]);
  });

  it("is not served past its days, and is served until then", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1), DAY);
    await report();
    expect((await store.shown("d1", DAY + 1))?.alive).toBe(true);
    await store.sweep(DAY + 5);
    expect((await store.shown("d1", DAY + 5))?.alive).toBe(false);
  });

  it("does not take the place of what can really be forgotten in a round", async () => {
    await store.create(newDoc("held"), DAY);
    await report("held");
    await store.create(newDoc("free", { ttlDays: 3 }), DAY);
    const few = withLimits({ sweptAtOnce: 1 });
    expect((await few.sweep(DAY + 10)).forgotten).toBe(1);
    expect(await row("free")).toBeNull();
    expect(await row("held")).not.toBeNull();
  });

  it("lasts 180 days by default", () => {
    expect(LEVEL_ONE.evidenceDays).toBe(180);
  });

  it("stops holding the document once the report is cleared", async () => {
    await store.create(newDoc("d1"), DAY);
    await report();
    await testEnv.DB.prepare("UPDATE reports SET cleared = 1").run();
    await store.sweep(DAY + 5);
    expect(await row("d1")).toBeNull();
  });

  it("keeps the anchor of a language that was reported", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.create(newDoc("en", { anchor: "d1" }), DAY);
    await report("en");
    await store.sweep(DAY + 5);
    expect(await row("d1")).not.toBeNull();
    expect(await row("en")).not.toBeNull();
  });

  it("does not take a report that arrives as it is being forgotten", async () => {
    await store.create(newDoc("d1"), DAY);
    const raced = new Cloud({
      DB: new Proxy(testEnv.DB, {
        get(target, key) {
          if (key === "prepare") {
            return (sql: string) => {
              if (!sql.startsWith("UPDATE docs SET latest = -1")) return target.prepare(sql);
              return {
                bind: (...values: unknown[]) => ({
                  run: async () => {
                    await report();
                    return target
                      .prepare(sql)
                      .bind(...values)
                      .run();
                  },
                }),
              };
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      ENVELOPES: testEnv.ENVELOPES,
    });
    await raced.sweep(DAY + 5);
    expect((await row("d1"))?.latest).toBe(0);
  });

  it("does not lose the version it was about to clean uploads, however long after", async () => {
    await store.create(newDoc("d1", { ttlDays: 15 }), DAY);
    await store.upload(upload("d1", 1), DAY);
    await report();
    for (let n = 2; n <= LEVEL_ONE.versionsKept + 3; n += 1) {
      await store.upload({ ...upload("d1", n), at: n * WEEK_AND_A_DAY }, DAY);
    }
    expect(await objects("d1")).toContain("d1/1.h1");
    const versions = JSON.parse((await row("d1"))?.versions ?? "[]") as { n: number }[];
    expect(versions.map((one) => one.n)).toEqual([1, LEVEL_ONE.versionsKept + 2, LEVEL_ONE.versionsKept + 3]);
    expect((await objects("d1")).length).toBe(3);
  });

  it("does not keep a version for a light report, and an order keeps them all", async () => {
    await store.create(newDoc("d1", { ttlDays: 15 }), DAY);
    await store.upload(upload("d1", 1), DAY);
    await report("d1", "spam");
    const more = async (from: number, to: number) => {
      for (let n = from; n <= to; n += 1) await store.upload({ ...upload("d1", n), at: n * WEEK_AND_A_DAY }, DAY);
    };
    await more(2, 5);
    expect(await objects("d1")).not.toContain("d1/1.h1");
    const before = (await objects("d1")).length;
    await testEnv.DB.prepare("UPDATE docs SET legal_until = ? WHERE id = 'd1'")
      .bind(DAY + 1)
      .run();
    await more(6, 7);
    expect((await objects("d1")).length).toBe(before + 2);
  });

  it("does not hold a document past its days for a light report", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1), DAY);
    await report("d1", "offensive");
    await store.sweep(DAY + 5);
    expect(await row("d1")).toBeNull();
  });

  it("does not hold anything for what anyone cannot report", async () => {
    await store.create(newDoc("d1"), DAY);
    expect((await report("d1", "copyright")).blocked).toBe(false);
    expect((await sealedRows())?.n).toBe(0);
    await store.sweep(DAY + 5);
    expect(await row("d1")).toBeNull();
  });

  it("takes every category there is", async () => {
    await store.create(newDoc("d1"), DAY);
    for (const [n, category] of REPORT_CATEGORIES.entries()) await report("d1", category, `net${n}`);
    expect((await sealedRows())?.n).toBe(REPORT_CATEGORIES.length);
  });
});

describe("an order", () => {
  const order = (until: number) =>
    testEnv.DB.prepare("UPDATE docs SET legal_until = ? WHERE id = 'd1'").bind(until).run();

  it("keeps the document and its reports for as long as it says, and not a day more", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.report({ doc: "d1", net: "a", category: "csam", asn: 1 }, DAY, DAY * 24);
    const until = DAY + LEVEL_ONE.evidenceDays + 50;
    await order(until);
    await store.sweep(DAY + LEVEL_ONE.evidenceDays + 10);
    expect(await row("d1")).not.toBeNull();
    const held = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(held?.n).toBe(1);
    await store.sweep(until + 1);
    await store.sweep(until + 1);
    expect(await row("d1")).toBeNull();
  });

  it("holds a document with no report at all", async () => {
    await store.create(newDoc("d1"), DAY);
    await order(DAY + 10);
    await store.sweep(DAY + 5);
    expect(await row("d1")).not.toBeNull();
    await store.sweep(DAY + 11);
    expect(await row("d1")).toBeNull();
  });

  it("is told to no one who reads", async () => {
    await store.create(newDoc("d1"), DAY);
    await store.upload(upload("d1", 1), DAY);
    await order(DAY + 10);
    expect(JSON.stringify(await store.shown("d1", DAY))).not.toContain(String(DAY + 10));
  });
});

describe("what each event writes, from start to end", () => {
  it("a first upload writes what the model says", async () => {
    const { spent, cloud } = counting();
    await cloud.create(newDoc("d1"), DAY);
    await cloud.upload(upload("d1", 1), DAY);
    expect(spent.written).toBe(5);
    await cloud.upload(upload("d1", 2), DAY);
    expect(spent.written).toBe(7);
  });

  it("a report and a rejected report write a row with its index and none", async () => {
    await store.create(newDoc("d1"), DAY);
    const { spent, cloud } = counting();
    await cloud.report({ doc: "d1", net: "a", category: "phishing", asn: 1 }, DAY, DAY * 24);
    expect(spent.written).toBe(2);
    await cloud.report({ doc: "d1", net: "a", category: "phishing", asn: 1 }, DAY, DAY * 24);
    expect(spent.written).toBe(2);
  });

  it("an idle sweep writes only what creating tomorrow's table costs", async () => {
    await store.sweep(DAY);
    const { spent, cloud } = counting();
    await cloud.sweep(DAY);
    expect(spent.written).toBe(0);
  });
});
