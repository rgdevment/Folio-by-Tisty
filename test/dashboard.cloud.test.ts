import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AccessSettings, type Certs, issuerOf } from "../src/admin/access";
import { answer } from "../src/admin/api";
import { CloudDashboard } from "../src/cloudflare/dashboard";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import type { Top, TopDoc } from "../src/core/dashboard";
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
const LIMITS = { ...LEVEL_ONE, rowsPerOwnerADay: 6, newReadersFree: 3 };
const store = new Cloud(testEnv, LIMITS);
const dashboard = new CloudDashboard(testEnv.DB, LIMITS);
const ROOT = "R".repeat(43);
const ACCESS: AccessSettings = { team: "rina", audience: "the-panel", email: "mario@example.test" };

const shared = async (id: string, owner = ROOT, { net = "up", day = TODAY, body = "sealed", versions = 1 } = {}) => {
  await store.create({ id, owner, adminHash: "a", ttlDays: 3, net }, day);
  for (let n = 1; n <= versions; n += 1) {
    await store.upload(
      {
        id,
        n,
        hash: `h${n}`,
        body,
        net,
        at: day * 86_400_000 + 3_600_000 + n * 1000,
        signer: owner,
        machine: "m1",
        contract: "1.5.0",
        byOwner: true,
        permit: null,
        ownerMark: "m1.t",
      },
      day,
    );
  }
};

const read = (doc: string, reader: string, { owner = ROOT, hour = 3, proved = false, day = TODAY } = {}) =>
  store.note({ owner, reader, doc, hour, proved }, day);

const docDay = (doc: string, day = TODAY) =>
  testEnv.DB.prepare("SELECT nets, proved, hours, peak, by_uploader FROM doc_day WHERE doc = ? AND day = ?")
    .bind(doc, day)
    .first();

const summarized = (doc: string, day: number, nets: number, byUploader = 0) =>
  testEnv.DB.prepare(
    "INSERT INTO doc_day (doc, day, nets, proved, hours, peak, by_uploader) VALUES (?, ?, ?, 0, 1, ?, ?)",
  )
    .bind(doc, day, nets, nets, byUploader)
    .run();

const ofTop = (top: Top, id: string): TopDoc | undefined => top.docs.find((one) => one.id === id);

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  const seen = await testEnv.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'seen_[0-9]*'",
  ).all<{ name: string }>();
  for (const { name } of seen.results) await testEnv.DB.prepare(`DROP TABLE ${name}`).run();
  for (const table of [
    "docs",
    "keys",
    "editors",
    "reports",
    "moderation",
    "openings",
    "net_day",
    "net_hour",
    "net_doc",
    "doc_day",
    "service_day",
    "service_stage",
  ]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("a day of readers, added up", () => {
  it("keeps how many networks read each document, with proof, in how many hours and at the peak, never which", async () => {
    await shared("Dddddddd");
    await read("Dddddddd", "reader-a", { hour: 1, proved: true });
    await read("Dddddddd", "reader-b", { hour: 1 });
    await read("Dddddddd", "reader-c", { hour: 5 });
    await store.sweep(TODAY + 1);
    expect(await docDay("Dddddddd")).toEqual({ nets: 3, proved: 1, hours: 2, peak: 2, by_uploader: 0 });
    const all = await testEnv.DB.prepare("SELECT * FROM doc_day").all();
    expect(JSON.stringify(all.results)).not.toMatch(/reader-|"up"/);
  });

  it("knows when the only network that read it was the one that uploaded it", async () => {
    await shared("Dddddddd", ROOT, { net: "home" });
    await shared("Eeeeeeee", ROOT, { net: "home" });
    await read("Dddddddd", "home");
    await read("Eeeeeeee", "elsewhere");
    await store.sweep(TODAY + 1);
    expect((await docDay("Dddddddd"))?.by_uploader).toBe(1);
    expect((await docDay("Eeeeeeee"))?.by_uploader).toBe(0);
  });

  it("does not keep saying the uploader alone read it once a late reader adds to that day", async () => {
    await shared("Dddddddd", ROOT, { net: "home" });
    await read("Dddddddd", "home", { hour: 2 });
    await store.sweep(TODAY + 1);
    expect((await docDay("Dddddddd"))?.by_uploader).toBe(1);
    await read("Dddddddd", "late", { hour: 23 });
    await store.sweep(TODAY + 1);
    expect(await docDay("Dddddddd")).toEqual({ nets: 2, proved: 0, hours: 1, peak: 1, by_uploader: 0 });
  });

  it("does not say the uploader alone read it when others read it too", async () => {
    await shared("Dddddddd", ROOT, { net: "home" });
    await read("Dddddddd", "home");
    await read("Dddddddd", "other");
    await store.sweep(TODAY + 1);
    expect((await docDay("Dddddddd"))?.by_uploader).toBe(0);
  });

  it("notes a reader's proof on a day's table made before it carried one, and still adds that day up", async () => {
    for (const day of [TODAY - 1, TODAY]) {
      await testEnv.DB.prepare(
        `CREATE TABLE seen_${day} (owner TEXT NOT NULL, reader TEXT NOT NULL, doc TEXT NOT NULL, hour INTEGER NOT NULL,
           PRIMARY KEY (owner, reader, doc)) WITHOUT ROWID`,
      ).run();
    }
    await shared("Dddddddd", ROOT, { day: TODAY - 1 });
    await testEnv.DB.prepare(`INSERT INTO seen_${TODAY - 1} VALUES (?, 'old', 'Dddddddd', 2)`)
      .bind(ROOT)
      .run();
    await read("Dddddddd", "new", { proved: true });
    const noted = await testEnv.DB.prepare(`SELECT proved FROM seen_${TODAY}`).first<{ proved: number }>();
    expect(noted?.proved).toBe(1);
    expect((await store.sweep(TODAY)).failed).toBe(0);
    expect(await docDay("Dddddddd", TODAY - 1)).toEqual({ nets: 1, proved: 0, hours: 1, peak: 1, by_uploader: 0 });
  });

  it("forgets the uploader's network the day after, and each summary after 31 days", async () => {
    await shared("Dddddddd");
    await summarized("Gggggggg", TODAY, 4);
    await store.sweep(TODAY + 1);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM net_doc").first<{ n: number }>())?.n).toBe(1);
    await store.sweep(TODAY + 2);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM net_doc").first<{ n: number }>())?.n).toBe(0);
    await store.sweep(TODAY + 31);
    expect(await docDay("Gggggggg")).not.toBeNull();
    await store.sweep(TODAY + 32);
    expect(await docDay("Gggggggg")).toBeNull();
  });

  it("takes a forgotten document's summaries with it", async () => {
    await shared("Dddddddd");
    await read("Dddddddd", "r1");
    await store.sweep(TODAY + 1);
    expect(await docDay("Dddddddd")).not.toBeNull();
    await store.sweep(TODAY + 10);
    expect(await docDay("Dddddddd")).toBeNull();
  });

  it("keeps no summary of a day for a document gone before that day was added up", async () => {
    await shared("Dddddddd");
    await read("Dddddddd", "r1");
    await store.stop("Dddddddd", TODAY);
    await store.sweep(TODAY);
    expect(await testEnv.DB.prepare("SELECT 1 FROM docs WHERE id = 'Dddddddd'").first()).toBeNull();
    await store.sweep(TODAY + 1);
    expect(await docDay("Dddddddd")).toBeNull();
  });

  it("replaces the day's key in the sweep, even when nobody asked for it that day", async () => {
    await testEnv.ENVELOPES.delete("~day-key");
    const yesterday = await store.dayKey(TODAY);
    await store.sweep(TODAY + 1);
    const held = await testEnv.ENVELOPES.get("~day-key");
    expect(JSON.parse((await held?.text()) ?? "{}")).toMatchObject({ period: TODAY + 1 });
    expect(await store.dayKey(TODAY + 1)).not.toBe(yesterday);
  });

  it("charts each day's readers and uploads, counting today as it goes", async () => {
    await shared("Dddddddd", ROOT, { day: TODAY - 1, versions: 2 });
    await read("Dddddddd", "r1", { day: TODAY - 1 });
    await store.sweep(TODAY);
    await store.sweep(TODAY);
    await shared("Eeeeeeee");
    await read("Eeeeeeee", "r1");
    await read("Eeeeeeee", "r2");
    const days = await dashboard.days(NOW);
    expect(days).toHaveLength(30);
    expect(days.at(-2)).toEqual({ day: TODAY - 1, readers: 1, uploads: 2 });
    expect(days.at(-1)).toEqual({ day: TODAY, readers: 2, uploads: 1 });
    expect(days[0]).toEqual({ day: TODAY - 29, readers: 0, uploads: 0 });
  });
});

describe("the overview", () => {
  it("counts what is open, what came today and what the last review of the bill found", async () => {
    await shared("Dddddddd", ROOT, { day: TODAY - 1 });
    await shared("Eeeeeeee");
    await store.create(
      { id: "Ffffffff", owner: ROOT, anchor: "Eeeeeeee", adminHash: "a", ttlDays: 3, net: "up" },
      TODAY,
    );
    await store.upload(
      {
        id: "Ffffffff",
        n: 1,
        hash: "h1",
        body: "x",
        net: "up",
        at: NOW,
        signer: ROOT,
        machine: "m1",
        contract: "1.5.0",
        byOwner: true,
        permit: null,
        ownerMark: "m1.t",
      },
      TODAY,
    );
    await store.admitKey(ROOT, "up", TODAY);
    await store.keepKeys([ROOT], TODAY);
    await store.report({ doc: "Dddddddd", net: "x", category: "intimate", asn: 1, version: 1 }, TODAY, HOUR);
    await store.report({ doc: "Eeeeeeee", net: "y", category: "spam", asn: 2, version: 1 }, TODAY, HOUR);
    await read("Eeeeeeee", "r1");
    await store.noteSpend({ bill: 4.12, line: 6.3, storedGb: 3.4 }, NOW);
    const seen = await dashboard.overview(NOW);
    expect(seen.docs).toEqual({ open: 2, newToday: 1, withLanguages: 1 });
    expect(seen.keys).toEqual({ total: 1, newToday: 1, newADay: LIMITS.newKeysADay });
    expect(seen.uploads).toEqual({ today: 2, newDocs: 2 });
    expect(seen.readers).toEqual({ today: 1, yesterday: null });
    expect(seen.reports).toEqual({ grave: 1, medium: 0, light: 1 });
    expect(seen.spend).toMatchObject({ bill: 4.12, line: 6.3, at: NOW });
    expect(seen.stored.gb).toBe(3.4);
    expect(seen.beats.spentAt).toBe(NOW);
  });

  it("says when the sweep last added a day up, and not for an hour with nothing to add", async () => {
    await store.sweep(TODAY, HOUR);
    expect((await dashboard.overview(NOW)).beats.sweptHour).toBeNull();
    await store.sweep(TODAY + 1, HOUR + 24);
    await store.sweep(TODAY + 1, HOUR + 25);
    expect((await dashboard.overview(NOW)).beats.sweptHour).toBe(HOUR + 24);
  });

  it("lists what the operator did and opened, the latest first", async () => {
    await testEnv.DB.prepare("INSERT INTO moderation (at, doc, action, note) VALUES (?, 'Dddddddd', 'block', 'spam')")
      .bind(NOW - 10)
      .run();
    await testEnv.DB.prepare("INSERT INTO openings (doc, at, reason) VALUES ('Eeeeeeee', ?, 'verificar')")
      .bind(NOW)
      .run();
    expect(await dashboard.log()).toEqual([
      { at: NOW, action: "opened", on: "Eeeeeeee", note: "verificar" },
      { at: NOW - 10, action: "block", on: "Dddddddd", note: "spam" },
    ]);
  });

  it("lists the networks past half of a quota today, and not the day's sum of new keys", async () => {
    const day = (net: string, docs: number, bytes: number, keys: number) =>
      testEnv.DB.prepare("INSERT INTO net_day (day, net, docs, bytes, keys) VALUES (?, ?, ?, ?, ?)")
        .bind(TODAY, net, docs, bytes, keys)
        .run();
    await day("busy", 41, 0, 0);
    await day("calm", 3, 0, 1);
    await day("keyed", 0, 0, 3);
    await day("~new-keys", 0, LIMITS.newKeysBytesADay, 0);
    await store.takeHourly("hourly", "upload", HOUR, LIMITS.uploadsAnHour, 40);
    await day("hourly", 1, 0, 0);
    const near = await dashboard.nets(NOW);
    expect(near.nets.map((one) => [one.net, one.share])).toEqual([
      ["busy", 41 / LIMITS.netDocsADay],
      ["hourly", 40 / LIMITS.uploadsAnHour],
      ["keyed", 3 / LIMITS.newKeysADay],
    ]);
  });
});

describe("the top documents", () => {
  const BOTS = "B".repeat(43);
  const FARM_ROOTS = Array.from({ length: LIMITS.newKeysADay }, (_, at) => `${at}`.padEnd(43, "F"));

  beforeEach(async () => {
    await shared("Bbbbbbbb", BOTS);
    for (let at = 1; at <= LIMITS.rowsPerOwnerADay; at += 1) {
      await read("Bbbbbbbb", `r${at}`, { owner: BOTS, proved: at > 2 });
    }
    await shared("Llllllll", ROOT, { day: TODAY - 40, body: "a much heavier envelope than the others" });
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'Llllllll'")
      .bind(TODAY + 3)
      .run();
    for (let day = TODAY - 5; day < TODAY; day += 1) await summarized("Llllllll", day, 1, 1);
    await shared("Kkkkkkkk", FARM_ROOTS[0], { net: "farm" });
    for (const root of FARM_ROOTS) await store.admitKey(root, "farm", TODAY);
    await shared("Eeeeeeee", ROOT, { versions: 21 });
    await shared("Rrrrrrrr", "S".repeat(43));
    await store.report({ doc: "Rrrrrrrr", net: "x", category: "phishing", asn: 1, version: 1 }, TODAY, HOUR);
    await shared("Qqqqqqqq", "Q".repeat(43));
    await summarized("Qqqqqqqq", TODAY - 1, 30);
  });

  it("flags each from what is stored, and leaves a quiet one alone", async () => {
    const top = await dashboard.top(NOW, "readers", false);
    expect(ofTop(top, "Bbbbbbbb")?.signals.map((one) => one.kind)).toEqual(["cap", "proved"]);
    expect(ofTop(top, "Bbbbbbbb")?.ownerAtTop).toBe(true);
    expect(ofTop(top, "Bbbbbbbb")?.today).toEqual({ nets: 6, proved: 4, hours: 1, peak: 6 });
    expect(ofTop(top, "Llllllll")?.signals).toEqual([{ kind: "lone", days: 40, byUploader: true }]);
    expect(ofTop(top, "Kkkkkkkk")?.signals).toEqual([{ kind: "keys", keys: LIMITS.newKeysADay, docs: 1 }]);
    expect(ofTop(top, "Eeeeeeee")?.signals).toEqual([{ kind: "edits", edits: 21 }]);
    expect(ofTop(top, "Rrrrrrrr")?.signals).toEqual([{ kind: "report", level: "medium" }]);
    expect(ofTop(top, "Qqqqqqqq")?.signals).toEqual([]);
    expect(ofTop(top, "Qqqqqqqq")?.yesterday?.nets).toBe(30);
  });

  it("does not blame a quiet document for the ceiling its owner's other one reached", async () => {
    await shared("Cccccccc", BOTS);
    await read("Cccccccc", "r1", { owner: BOTS });
    const top = await dashboard.top(NOW, "readers", false);
    expect(ofTop(top, "Cccccccc")?.signals).toEqual([]);
    expect(ofTop(top, "Cccccccc")?.ownerAtTop).toBe(false);
  });

  it("bounds how long one without its first day has lived by the oldest version kept and the days it was read", async () => {
    await testEnv.DB.prepare("UPDATE docs SET first_day = NULL, days = ? WHERE id = 'Llllllll'")
      .bind(JSON.stringify({ [TODAY - 45]: { n: 1 } }))
      .run();
    const top = await dashboard.top(NOW, "oldest", false);
    expect(ofTop(top, "Llllllll")).toMatchObject({ firstDay: null, signals: [{ kind: "lone", days: 45 }] });
    expect(top.docs[0]?.id).toBe("Llllllll");
  });

  it("looks back 30 days for one network alone, and no further", async () => {
    await summarized("Llllllll", TODAY - 35, 9);
    expect(ofTop(await dashboard.top(NOW, "readers", false), "Llllllll")?.signals.map((one) => one.kind)).toEqual([
      "lone",
    ]);
    await summarized("Llllllll", TODAY - 10, 2);
    expect(ofTop(await dashboard.top(NOW, "readers", false), "Llllllll")?.signals).toEqual([]);
  });

  it("counts yesterday's edits, a network's keys of today and yesterday only, and open reports only", async () => {
    const OLD_FARM = "O".repeat(43);
    await shared("Yyyyyyyy", "Y".repeat(43), { day: TODAY - 1, versions: 21 });
    await shared("Oooooooo", OLD_FARM, { net: "old-farm", day: TODAY - 2 });
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'Oooooooo'")
      .bind(TODAY + 3)
      .run();
    for (const root of FARM_ROOTS) await store.admitKey(root, "old-farm", TODAY - 2);
    await testEnv.DB.prepare("UPDATE reports SET cleared = 1 WHERE doc = 'Rrrrrrrr'").run();
    const top = await dashboard.top(NOW, "readers", false);
    expect(ofTop(top, "Yyyyyyyy")?.signals).toEqual([{ kind: "edits", edits: 21 }]);
    expect(ofTop(top, "Oooooooo")?.signals).toEqual([]);
    expect(ofTop(top, "Rrrrrrrr")?.signals).toEqual([]);
  });

  it("flags reading spread evenly over the whole of yesterday", async () => {
    await testEnv.DB.prepare(
      "UPDATE doc_day SET nets = 2400, hours = 24, peak = 110 WHERE doc = 'Qqqqqqqq' AND day = ?",
    )
      .bind(TODAY - 1)
      .run();
    const top = await dashboard.top(NOW, "readers", false);
    expect(ofTop(top, "Qqqqqqqq")?.signals).toEqual([{ kind: "even" }]);
  });

  it("orders by readers today, weight, edits and age", async () => {
    const first = async (order: "readers" | "weight" | "edits" | "oldest") =>
      (await dashboard.top(NOW, order, false)).docs[0]?.id;
    expect(await first("readers")).toBe("Bbbbbbbb");
    expect(await first("weight")).toBe("Llllllll");
    expect(await first("edits")).toBe("Eeeeeeee");
    expect(await first("oldest")).toBe("Llllllll");
  });

  it("shows only what is flagged when asked", async () => {
    const top = await dashboard.top(NOW, "readers", true);
    expect(top.docs.map((one) => one.id).sort()).toEqual(["Bbbbbbbb", "Eeeeeeee", "Kkkkkkkk", "Llllllll", "Rrrrrrrr"]);
  });

  it("still finds among the flagged what only yesterday's reading or edits mark", async () => {
    await testEnv.DB.prepare(
      "UPDATE doc_day SET nets = 2400, hours = 24, peak = 110 WHERE doc = 'Qqqqqqqq' AND day = ?",
    )
      .bind(TODAY - 1)
      .run();
    await shared("Yyyyyyyy", "Y".repeat(43), { day: TODAY - 1, versions: 21 });
    const top = await dashboard.top(NOW, "weight", true);
    expect(ofTop(top, "Qqqqqqqq")?.signals).toEqual([{ kind: "even" }]);
    expect(ofTop(top, "Yyyyyyyy")?.signals).toEqual([{ kind: "edits", edits: 21 }]);
  });

  it("says when each was first shared and when it was to expire", async () => {
    const top = await dashboard.top(NOW, "oldest", false);
    expect(ofTop(top, "Llllllll")).toMatchObject({ firstDay: TODAY - 40, ttlDays: 3, diesOn: TODAY + 3 });
  });

  it("tells one no longer served from one served until today", async () => {
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'Llllllll'")
      .bind(TODAY - 1)
      .run();
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'Bbbbbbbb'").bind(TODAY).run();
    const top = await dashboard.top(NOW, "oldest", false);
    expect(ofTop(top, "Llllllll")?.stopped).toBe(true);
    expect(ofTop(top, "Bbbbbbbb")?.stopped).toBe(false);
  });
});

describe("a key", () => {
  beforeEach(async () => {
    await shared("Dddddddd");
    await shared("Eeeeeeee", ROOT, { body: "x".repeat(1000) });
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ? WHERE id = 'Eeeeeeee'").bind(TODAY).run();
    await store.keepKeys([ROOT], TODAY - 3, { root: ROOT, version: "14", hour: HOUR - 80 });
    await store.report(
      { doc: "Dddddddd", net: "secret-net", category: "phishing", asn: 77, version: 1, sealedLink: "sealed.opaque" },
      TODAY,
      HOUR,
    );
  });

  it("says what it holds, what it shared and what was reported", async () => {
    const view = await dashboard.key(ROOT, NOW);
    expect(view).toMatchObject({
      root: ROOT,
      firstDay: TODAY - 3,
      termsVersion: "14",
      termsHour: HOUR - 80,
      holds: 6,
      holdsAtMost: LIMITS.keyBytesAtMost,
      docs: { open: 1, expired: 0, blocked: 1 },
      versions: 2,
      asEditor: 0,
      reports: { grave: 0, medium: 1, light: 0 },
    });
    expect(view?.listed.map((one) => one.id).sort()).toEqual(["Dddddddd", "Eeeeeeee"]);
    expect(await dashboard.key("N".repeat(43), NOW)).toBeNull();
  });

  it("counts a translation alive by its anchor as open, and one whose anchor is gone as expired", async () => {
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = NULL WHERE id = 'Eeeeeeee'").run();
    await store.create(
      { id: "Ffffffff", owner: ROOT, anchor: "Dddddddd", adminHash: "a", ttlDays: 3, net: "up" },
      TODAY,
    );
    await testEnv.DB.prepare("UPDATE docs SET latest = 1, dies_on = ? WHERE id = 'Ffffffff'")
      .bind(TODAY - 2)
      .run();
    const alive = await dashboard.key(ROOT, NOW);
    expect(alive?.docs).toEqual({ open: 3, expired: 0, blocked: 0 });
    expect(alive?.listed.find((one) => one.id === "Ffffffff")?.alive).toBe(true);
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'Dddddddd'")
      .bind(TODAY - 1)
      .run();
    expect((await dashboard.key(ROOT, NOW))?.docs).toEqual({ open: 1, expired: 2, blocked: 0 });
  });

  it("exports its records without who reported", async () => {
    const records = JSON.stringify(await dashboard.keyRecords(ROOT, NOW));
    expect(records).toContain("Dddddddd");
    expect(records).toContain("phishing");
    expect(records).not.toMatch(/secret-net|sealed\.opaque|"asn"/);
  });

  it("says whose each document is and what that key holds", async () => {
    expect(await dashboard.owners(["Dddddddd", "not an id"], NOW)).toEqual({
      Dddddddd: { root: ROOT, firstDay: TODAY - 3, blockedAt: null, holds: 6 },
    });
  });

  it("finds a document, a key or a network of today, and says when it finds none", async () => {
    expect(await dashboard.find("Dddddddd", NOW)).toEqual({ kind: "doc", id: "Dddddddd", owner: ROOT });
    expect(await dashboard.find(ROOT, NOW)).toEqual({ kind: "key", root: ROOT });
    const net = "n".repeat(43);
    await testEnv.DB.prepare("INSERT INTO net_day (day, net, docs, bytes, keys) VALUES (?, ?, 2, 10, 1)")
      .bind(TODAY, net)
      .run();
    expect(await dashboard.find(net, NOW)).toEqual({
      kind: "net",
      net,
      days: [{ day: TODAY, docs: 2, bytes: 10, keys: 1 }],
    });
    expect(await dashboard.find("secret-net".padEnd(43, "x"), NOW)).toEqual({ kind: "none" });
    await testEnv.DB.prepare("UPDATE reports SET net = ?").bind("e".repeat(43)).run();
    expect(await dashboard.find("e".repeat(43), NOW)).toEqual({ kind: "reporter", net: "e".repeat(43), reports: 1 });
    expect(await dashboard.find("nothing", NOW)).toEqual({ kind: "none" });
  });
});

describe("the panel's answers", () => {
  let certs: Certs;
  let signer: CryptoKey;

  const b64 = (said: unknown): string => toBase64Url(new TextEncoder().encode(JSON.stringify(said)));
  const token = async (): Promise<string> => {
    const body = `${b64({ alg: "RS256", kid: "one" })}.${b64({
      iss: issuerOf(ACCESS.team),
      aud: [ACCESS.audience],
      email: ACCESS.email,
      exp: NOW / 1000 + 60,
    })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(body));
    return `${body}.${toBase64Url(signature)}`;
  };
  const asked = async (path: string, signed = true) =>
    answer(
      new Request(`https://panel.test${path}`, {
        headers: signed ? { "Cf-Access-Jwt-Assertion": await token() } : {},
      }),
      {
        moderation: new CloudModeration(testEnv.DB),
        dashboard,
        about: { sharingOpen: true, termsVersion: "14", limitsSerial: 25 },
        access: ACCESS,
        certs,
        now: NOW,
      },
    );

  beforeAll(async () => {
    const keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    signer = keys.privateKey;
    const cert = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    certs = async () => [{ ...cert, kid: "one" } as JsonWebKey];
  });

  it.each(["/api/overview", "/api/days", "/api/log", "/api/nets", "/api/top", `/api/keys/${ROOT}`, "/api/find?q=x"])(
    "answers %s only to the operator",
    async (path) => {
      await shared("Dddddddd");
      expect((await asked(path, false)).status).toBe(403);
      expect((await asked(path)).status).toBe(200);
    },
  );

  it("says what the signed limits say, and only the start of the operator's address", async () => {
    const said = (await (await asked("/api/overview")).json()) as Record<string, unknown>;
    expect(said).toMatchObject({ sharingOpen: true, termsVersion: "14", limitsSerial: 25, operator: "mario@…" });
    expect(JSON.stringify(said)).not.toContain("example.test");
  });

  it("takes the order and the flag of the top, and falls back to readers", async () => {
    await shared("Dddddddd");
    const top = (await (await asked("/api/top?by=weight&flagged=1")).json()) as Top;
    expect(top).toMatchObject({ order: "weight", flaggedOnly: true, docs: [] });
    expect(((await (await asked("/api/top?by=nonsense")).json()) as Top).order).toBe("readers");
  });

  it("brings the owners of what waits in the queue", async () => {
    await shared("Dddddddd");
    await store.report({ doc: "Dddddddd", net: "x", category: "phishing", asn: 1, version: 1 }, TODAY, HOUR);
    const queue = (await (await asked("/api/queue")).json()) as { owners: Record<string, { root: string }> };
    expect(queue.owners.Dddddddd?.root).toBe(ROOT);
  });

  it("answers a key and its records once it shared, and nothing for one that never did", async () => {
    await shared("Dddddddd");
    expect((await asked(`/api/keys/${ROOT}/records`)).status).toBe(200);
    expect((await asked(`/api/keys/${"N".repeat(43)}/records`)).status).toBe(404);
  });
});
