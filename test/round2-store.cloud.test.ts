import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudDashboard } from "../src/cloudflare/dashboard";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import { DAY_MS } from "../src/core/limits";
import type { Version } from "../src/core/store";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const HOUR_MS = 3_600_000;
const DAY = 20_000;
const T0 = DAY * DAY_MS;
const HOUR = Math.floor(T0 / HOUR_MS);
const LINK = `sealed1.${"A".repeat(150)}`;
const store = new Cloud(testEnv);
const moderation = new CloudModeration(testEnv.DB);

const ownerOf = (id: string): string => `owner-${id}`;

const wipe = async (): Promise<void> => {
  const tables = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
    name: string;
  }>();
  for (const { name } of tables.results) {
    if (name.startsWith("seen_")) await testEnv.DB.prepare(`DROP TABLE ${name}`).run();
    else if (!name.startsWith("_") && !name.startsWith("sqlite") && !name.startsWith("d1_"))
      await testEnv.DB.prepare(`DELETE FROM ${name}`).run();
  }
  const listed = await testEnv.ENVELOPES.list();
  if (listed.objects.length > 0) await testEnv.ENVELOPES.delete(listed.objects.map((one) => one.key));
};

const create = (id: string, over: Partial<Parameters<Cloud["create"]>[0]> = {}, day = DAY) =>
  store.create({ id, owner: ownerOf(id), adminHash: "a", ttlDays: 15, net: `up-${id}`, ...over }, day);

const put = (id: string, n: number, at: number, over: Record<string, unknown> = {}, today = Math.floor(at / DAY_MS)) =>
  store.upload(
    {
      id,
      n,
      hash: `h${n}`,
      body: "x".repeat(10),
      net: `up-${id}`,
      at,
      signer: ownerOf(id),
      machine: "m1",
      contract: "1.5.0",
      byOwner: true,
      permit: null,
      ownerMark: "m1.t",
      ...over,
    },
    today,
  );

const doc = (id: string) =>
  testEnv.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(id).first<{
    latest: number;
    versions: string;
    bytes: number;
    dies_on: number;
    blocked_at: number | null;
    paused_at: number | null;
    counts_from: number;
    files_bytes: number;
    legal_until: number | null;
    blocked_by_operator: number;
  }>();

const versionsOf = async (id: string): Promise<Version[]> => JSON.parse((await doc(id))?.versions ?? "[]") as Version[];
const object = (id: string, n: number) => testEnv.ENVELOPES.head(`${id}/${n}.h${n}`);

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(wipe);

describe("what a key holds: languages kept by an anchor", () => {
  const fill = async (bytes = 100, files = 50) => {
    await testEnv.DB.prepare("UPDATE docs SET latest = 1, versions = ?, files_bytes = ? WHERE owner = 'o1'")
      .bind(JSON.stringify([{ n: 1, hash: "h", bytes }]), files)
      .run();
  };
  const group = async (anchorDays = 15, languageDays = 1) => {
    await create("anchor", { owner: "o1", ttlDays: anchorDays });
    await create("lang1", { owner: "o1", anchor: "anchor", ttlDays: languageDays });
    await fill();
  };
  const heldAt = (day: number) => store.heldByOwner("o1", day, "");

  it("counts a language by its anchor past its own days, and stops when the anchor's days end", async () => {
    await group();
    expect(await heldAt(DAY + 5)).toBe(300);
    expect(await heldAt(DAY + 15)).toBe(300);
    expect(await heldAt(DAY + 16)).toBe(0);
  });

  it("does not count a language whose anchor is stopped, though the anchor itself keeps its day", async () => {
    await group();
    await store.stop("anchor", DAY + 2);
    expect(await heldAt(DAY + 5)).toBe(0);
  });

  it("counts a paused anchor, which still holds its place for the days of a pause, but not the language it no longer serves", async () => {
    await group();
    await store.pause("anchor", DAY + 2);
    expect(await heldAt(DAY + 5)).toBe(150);
  });

  it("does not count a language past its days while its anchor is blocked", async () => {
    await group();
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?, dies_on = ? WHERE id = 'anchor'")
      .bind(DAY + 1, DAY + 181)
      .run();
    expect(await heldAt(DAY + 5)).toBe(0);
  });

  it("does not count a language that is itself paused, nor one that is blocked", async () => {
    await group();
    await testEnv.DB.prepare("UPDATE docs SET paused_at = ?, dies_on = ? WHERE id = 'lang1'")
      .bind(DAY + 2, DAY + 2 - 1)
      .run();
    expect(await heldAt(DAY + 5)).toBe(150);
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ? WHERE id = 'lang1'")
      .bind(DAY + 2)
      .run();
    expect(await heldAt(DAY + 5)).toBe(150);
  });

  it("does not count a language whose anchor was forgotten", async () => {
    await group();
    await testEnv.DB.prepare("UPDATE docs SET latest = -1 WHERE id = 'anchor'").run();
    expect(await heldAt(DAY + 5)).toBe(0);
  });

  it("counts an anchor that never got a version as nothing, but the language as its own bytes", async () => {
    await group();
    await testEnv.DB.prepare("UPDATE docs SET latest = 0, versions = '[]', files_bytes = 0 WHERE id = 'anchor'").run();
    expect(await heldAt(DAY + 5)).toBe(150);
  });

  it("does not count a language that was only a stub (latest 0) or a nested language", async () => {
    await group();
    await create("lang2", { owner: "o1", anchor: "anchor", ttlDays: 1 });
    expect(await heldAt(DAY + 5)).toBe(300);
  });

  it("agrees with what is served: a language is held in the room only if a reader would be served it", async () => {
    await create("anchor", { owner: "o1", ttlDays: 15 });
    await create("lang1", { owner: "o1", anchor: "anchor", ttlDays: 15 });
    await fill();
    await store.stop("anchor", DAY + 2);
    const shown = await store.shown("lang1", DAY + 5);
    const held = await store.heldByOwner("o1", DAY + 5, "");
    expect(shown?.alive).toBe(false);
    expect(held, "a stopped anchor stops its languages, but their room stays charged to the owner").toBe(0);
  });
});

describe("how long a replaced version stays when no upload follows", () => {
  const twoVersions = async (id: string, secondAt = T0 + HOUR_MS) => {
    await create(id, { ttlDays: 15 });
    await put(id, 1, T0);
    await put(id, 2, secondAt);
  };
  const sweepAt = (ms: number) => store.sweep(Math.floor(ms / DAY_MS), Math.floor(ms / HOUR_MS));

  it("lets go of it three days after its replacement, not a moment before", async () => {
    await twoVersions("Trimmed1");
    const cutoff = T0 + HOUR_MS + 3 * DAY_MS;
    await sweepAt(cutoff - HOUR_MS);
    expect((await versionsOf("Trimmed1")).map((one) => one.n)).toEqual([1, 2]);
    await sweepAt(cutoff);
    expect((await versionsOf("Trimmed1")).map((one) => one.n)).toEqual([2]);
    expect(await object("Trimmed1", 1)).toBeNull();
    expect(await object("Trimmed1", 2)).not.toBeNull();
    expect((await doc("Trimmed1"))?.bytes).toBe(10);
  });

  it("goes by the hour it runs in, so a replacement at 10:30 is let go by the sweep of 10:00 three days later only", async () => {
    await twoVersions("Trimmed2", T0 + 10.5 * HOUR_MS);
    await sweepAt(T0 + 3 * DAY_MS + 10 * HOUR_MS);
    expect((await versionsOf("Trimmed2")).map((one) => one.n)).toEqual([1, 2]);
    await sweepAt(T0 + 3 * DAY_MS + 11 * HOUR_MS);
    expect((await versionsOf("Trimmed2")).map((one) => one.n)).toEqual([2]);
  });

  it("keeps a version a counted report is about, and lets go of the rest", async () => {
    await create("Evidence", { ttlDays: 15 });
    await put("Evidence", 1, T0);
    await put("Evidence", 2, T0 + HOUR_MS);
    await put("Evidence", 3, T0 + 2 * HOUR_MS);
    await store.report({ doc: "Evidence", net: "a", asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    await sweepAt(T0 + 8 * DAY_MS);
    expect((await versionsOf("Evidence")).map((one) => one.n)).toEqual([1, 3]);
    expect(await object("Evidence", 1)).not.toBeNull();
    expect(await object("Evidence", 2)).toBeNull();
  });

  it("lets go of a version only a light report, a cleared one or a network found false is about", async () => {
    for (const [id, category, over] of [
      ["LightRep1", "spam", {}],
      ["Cleared01", "phishing", { clear: true }],
      ["FalseNet1", "phishing", { falseNet: true }],
    ] as const) {
      await create(id, { ttlDays: 15 });
      await put(id, 1, T0);
      await put(id, 2, T0 + HOUR_MS);
      await store.report({ doc: id, net: `n-${id}`, asn: 1, category, version: 1 }, DAY, HOUR);
      if ("clear" in over) await testEnv.DB.prepare("UPDATE reports SET cleared = 1 WHERE doc = ?").bind(id).run();
      if ("falseNet" in over)
        await testEnv.DB.prepare("INSERT INTO false_reporters (net, at, since, since_hour) VALUES (?, ?, ?, ?)")
          .bind(`n-${id}`, DAY, DAY, HOUR)
          .run();
    }
    await sweepAt(T0 + 8 * DAY_MS);
    for (const id of ["LightRep1", "Cleared01", "FalseNet1"])
      expect(
        (await versionsOf(id)).map((one) => one.n),
        id,
      ).toEqual([2]);
  });

  it("keeps every version of a document under an order, and trims it once the order ends", async () => {
    await twoVersions("Ordered01");
    await testEnv.DB.prepare("UPDATE docs SET legal_until = ? WHERE id = 'Ordered01'")
      .bind(DAY + 12)
      .run();
    await sweepAt(T0 + 8 * DAY_MS);
    expect((await versionsOf("Ordered01")).map((one) => one.n)).toEqual([1, 2]);
    await sweepAt(T0 + 13 * DAY_MS);
    expect((await versionsOf("Ordered01")).map((one) => one.n)).toEqual([2]);
  });

  it("deletes the attachments of what it lets go of, unless a version that stays names them", async () => {
    await create("Attached1", { ttlDays: 15 });
    await put("Attached1", 1, T0, { files: "FILESA" });
    await put("Attached1", 2, T0 + HOUR_MS, { files: "FILESA" });
    await put("Attached1", 3, T0 + 2 * HOUR_MS, { files: "FILESB" });
    for (const hash of ["FILESA", "FILESB"]) await testEnv.ENVELOPES.put(`Attached1/files.${hash}`, "attachment");
    await sweepAt(T0 + 8 * DAY_MS);
    expect((await versionsOf("Attached1")).map((one) => one.n)).toEqual([3]);
    expect(await testEnv.ENVELOPES.head("Attached1/files.FILESA")).toBeNull();
    expect(await testEnv.ENVELOPES.head("Attached1/files.FILESB")).not.toBeNull();
  });

  it("keeps an attachment the latest version still names, whichever replaced version shared it", async () => {
    await create("Attached2", { ttlDays: 15 });
    await put("Attached2", 1, T0, { files: "SAMEFILE" });
    await put("Attached2", 2, T0 + HOUR_MS, { files: "SAMEFILE" });
    await testEnv.ENVELOPES.put("Attached2/files.SAMEFILE", "attachment");
    await sweepAt(T0 + 8 * DAY_MS);
    expect((await versionsOf("Attached2")).map((one) => one.n)).toEqual([2]);
    expect(await testEnv.ENVELOPES.head("Attached2/files.SAMEFILE")).not.toBeNull();
  });

  it("does not touch a document with one version, an unshared one, or one that is being forgotten", async () => {
    await create("OneOnly01", { ttlDays: 15 });
    await put("OneOnly01", 1, T0);
    await create("Unshared1", { ttlDays: 15 });
    await sweepAt(T0 + 8 * DAY_MS);
    expect((await versionsOf("OneOnly01")).map((one) => one.n)).toEqual([1]);
    expect((await doc("Unshared1"))?.latest).toBe(0);
  });

  it("trims a paused and a blocked document too, since a replaced version is not what a block keeps", async () => {
    await twoVersions("Paused001");
    await store.pause("Paused001", DAY + 1);
    await twoVersions("Blocked01");
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?, dies_on = ? WHERE id = 'Blocked01'")
      .bind(DAY + 1, DAY + 181)
      .run();
    await sweepAt(T0 + 8 * DAY_MS);
    expect((await versionsOf("Paused001")).map((one) => one.n)).toEqual([2]);
    expect((await versionsOf("Blocked01")).map((one) => one.n)).toEqual([2]);
  });

  it("does nothing while the service is blocked, as with forgetting", async () => {
    await twoVersions("Stage0001");
    await store.setStage("blocked");
    await sweepAt(T0 + 8 * DAY_MS);
    expect((await versionsOf("Stage0001")).map((one) => one.n)).toEqual([1, 2]);
  });

  it("is idempotent: a second sweep changes nothing", async () => {
    await twoVersions("Twice001");
    await sweepAt(T0 + 8 * DAY_MS);
    const first = await doc("Twice001");
    await sweepAt(T0 + 8 * DAY_MS + HOUR_MS);
    expect(await doc("Twice001")).toEqual(first);
  });

  it("lets go of a long list that was waiting, all but the latest", async () => {
    await create("Many00001", { ttlDays: 15 });
    for (let n = 1; n <= 6; n += 1) await put("Many00001", n, T0 + n * 60_000);
    await sweepAt(T0 + 8 * DAY_MS);
    expect((await versionsOf("Many00001")).map((one) => one.n)).toEqual([6]);
    for (let n = 1; n <= 5; n += 1) expect(await object("Many00001", n)).toBeNull();
  });

  describe("more than 100 documents", () => {
    const direct = async (id: string, held: boolean) => {
      await create(id, { ttlDays: 15 });
      await testEnv.DB.prepare("UPDATE docs SET latest = 2, versions = ?, bytes = 20, legal_until = ? WHERE id = ?")
        .bind(
          JSON.stringify([
            { n: 1, hash: "h1", bytes: 10, at: T0, signer: "s", machine: "m", contract: "c" },
            { n: 2, hash: "h2", bytes: 10, at: T0 + HOUR_MS, signer: "s", machine: "m", contract: "c" },
          ]),
          held ? DAY + 100 : null,
          id,
        )
        .run();
    };

    it("lets go of 150 waiting, 100 at a sweep, losing none", async () => {
      for (let n = 0; n < 150; n += 1) await direct(`Wait${String(n).padStart(4, "0")}`, false);
      await sweepAt(T0 + 8 * DAY_MS);
      const left = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS n FROM docs WHERE json_array_length(versions) > 1",
      ).first<{ n: number }>();
      expect(left?.n).toBe(50);
      await sweepAt(T0 + 8 * DAY_MS + HOUR_MS);
      const none = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS n FROM docs WHERE json_array_length(versions) > 1",
      ).first<{ n: number }>();
      expect(none?.n).toBe(0);
    });

    it("is not starved by 100 documents whose replacement is too recent to trim", async () => {
      for (let n = 0; n < 101; n += 1) {
        const id = `Arecent${String(n).padStart(3, "0")}`;
        await direct(id, false);
        await testEnv.DB.prepare("UPDATE docs SET versions = json_set(versions, '$[1].at', ?) WHERE id = ?")
          .bind(T0 + 7 * DAY_MS, id)
          .run();
      }
      await direct("Zold000001", false);
      await sweepAt(T0 + 8 * DAY_MS);
      expect((await versionsOf("Zold000001")).map((one) => one.n)).toEqual([2]);
    });

    it("is not starved by 100 documents that cannot be trimmed, which come first and come back every hour", async () => {
      for (let n = 0; n < 101; n += 1) await direct(`Aheld${String(n).padStart(4, "0")}`, true);
      await direct("Zwaiting1", false);
      await sweepAt(T0 + 8 * DAY_MS);
      await sweepAt(T0 + 8 * DAY_MS + HOUR_MS);
      await sweepAt(T0 + 8 * DAY_MS + 2 * HOUR_MS);
      expect(
        (await versionsOf("Zwaiting1")).map((one) => one.n),
        "a replaced version outlived its three days",
      ).toEqual([2]);
    });
  });

  describe("an upload and the trim at once", () => {
    it("never leaves a version listed without its object, nor an object nobody lists", async () => {
      for (let round = 0; round < 12; round += 1) {
        const id = `Race${String(round).padStart(4, "0")}`;
        await twoVersions(id);
        const now = T0 + 8 * DAY_MS + round * 1000;
        await Promise.all([sweepAt(now), put(id, 3, now, {}, Math.floor(now / DAY_MS))]);
        const listed = await versionsOf(id);
        const row = await doc(id);
        expect(row?.latest).toBe(3);
        expect(listed.at(-1)?.n).toBe(3);
        for (const one of listed) expect(await object(id, one.n), `${id} v${one.n}`).not.toBeNull();
        const objects = (await testEnv.ENVELOPES.list({ prefix: `${id}/` })).objects.map((one) => one.key);
        expect(objects.sort(), id).toEqual(listed.map((one) => `${id}/${one.n}.h${one.n}`).sort());
        expect(row?.bytes).toBe(listed.reduce((sum, one) => sum + one.bytes, 0));
      }
    });
  });

  describe("when R2 fails after the list was written", () => {
    it("is counted as failed, and the object it left is still found and forgotten", async () => {
      await twoVersions("R2Fails01");
      const failing = new Cloud({
        DB: testEnv.DB,
        ENVELOPES: new Proxy(testEnv.ENVELOPES, {
          get: (target, property) =>
            property === "delete"
              ? async () => {
                  throw new Error("R2 fails");
                }
              : Reflect.get(target, property).bind(target),
        }),
      });
      const swept = await failing.sweep(DAY + 8, (DAY + 8) * 24);
      expect(swept.failed).toBe(1);
      expect((await versionsOf("R2Fails01")).map((one) => one.n)).toEqual([2]);
      await store.forgetOrphans(Date.now() + 2 * DAY_MS);
      expect(await object("R2Fails01", 1), "a replaced version stayed in R2 for good").toBeNull();
      expect(await object("R2Fails01", 2)).not.toBeNull();
    });
  });
});

describe("an upload that lands between the trim's reading and its writing", () => {
  it("leaves the objects of the list the upload wrote, which still names them", async () => {
    await create("Landing01", { ttlDays: 15 });
    await put("Landing01", 1, T0);
    await put("Landing01", 2, T0 + HOUR_MS);
    const landing = new Proxy(testEnv.DB, {
      get(database, name) {
        if (name === "prepare") {
          return (sql: string) => {
            const statement = database.prepare(sql);
            if (!sql.startsWith("UPDATE docs SET versions = ?1, bytes = ?2")) return statement;
            return new Proxy(statement, {
              get(target, member) {
                if (member !== "bind") return Reflect.get(target, member).bind(target);
                return (...values: unknown[]) => {
                  const bound = target.bind(...values);
                  return new Proxy(bound, {
                    get(inner, call) {
                      if (call !== "run") return Reflect.get(inner, call).bind(inner);
                      return async () => {
                        await database
                          .prepare(
                            "UPDATE docs SET versions = json_set(versions, '$[0].bytes', 11) WHERE id = 'Landing01'",
                          )
                          .run();
                        return inner.run();
                      };
                    },
                  });
                };
              },
            });
          };
        }
        const value = Reflect.get(database, name);
        return typeof value === "function" ? value.bind(database) : value;
      },
    });
    const racing = new Cloud({ DB: landing as D1Database, ENVELOPES: testEnv.ENVELOPES });
    await racing.sweep(DAY + 8, (DAY + 8) * 24);
    expect((await versionsOf("Landing01")).map((one) => one.n)).toEqual([1, 2]);
    expect(await object("Landing01", 1), "an object the list still names was deleted").not.toBeNull();
  });
});

describe("the key of the day", () => {
  const stored = async () =>
    JSON.parse((await (await testEnv.ENVELOPES.get("~day-key"))?.text()) ?? "{}") as { period: number; key: string };

  it("is replaced by the sweep, though nobody read that day", async () => {
    const yesterday = await store.dayKey(DAY - 1);
    expect((await stored()).period).toBe(DAY - 1);
    await store.sweep(DAY);
    const now = await stored();
    expect(now.period).toBe(DAY);
    expect(now.key).not.toBe(yesterday);
  });

  it("is the same one for every sweep of the day and for a reader after it", async () => {
    await store.sweep(DAY);
    const first = (await stored()).key;
    await store.sweep(DAY, DAY * 24 + 5);
    expect((await stored()).key).toBe(first);
    expect(await store.dayKey(DAY)).toBe(first);
  });

  it("gives one key when two sweeps and a reader race for the first of the day", async () => {
    await store.dayKey(DAY - 1);
    const [, , reader] = await Promise.all([store.sweep(DAY), store.sweep(DAY), store.dayKey(DAY)]);
    expect(reader).toBe((await stored()).key);
  });

  it("is never taken back by a sweep that runs with an older day", async () => {
    await store.sweep(DAY);
    const key = (await stored()).key;
    await store.sweep(DAY - 1);
    expect((await stored()).key).toBe(key);
    expect((await stored()).period).toBe(DAY);
  });

  it("is replaced even when the rest of the sweep fails", async () => {
    await store.dayKey(DAY - 1);
    await testEnv.DB.prepare("CREATE TABLE seen_19999 (x)").run();
    const swept = await store.sweep(DAY);
    expect(swept.failed).toBeGreaterThan(0);
    expect((await stored()).period).toBe(DAY);
  });
});

describe("what a day of readers adds to a document", () => {
  const seen = async (day: number, rows: [string, string, string][]) => {
    await store.note({ owner: "o", reader: "x", doc: "none", hour: 1, proved: false }, day);
    await testEnv.DB.prepare(`DELETE FROM seen_${day}`).run();
    for (const [owner, reader, docId] of rows)
      await store.note({ owner, reader, doc: docId, hour: 3, proved: false }, day);
  };
  const days = () =>
    testEnv.DB.prepare("SELECT doc, day, nets FROM doc_day ORDER BY doc").all<{
      doc: string;
      day: number;
      nets: number;
    }>();

  it("is kept for a document stopped that same day while an order keeps it, and goes with it when it is forgotten", async () => {
    await create("Stopped01", { ttlDays: 15 });
    await put("Stopped01", 1, T0);
    await create("Stopped02", { ttlDays: 15 });
    await put("Stopped02", 1, T0);
    await testEnv.DB.prepare("UPDATE docs SET legal_until = ? WHERE id = 'Stopped01'")
      .bind(DAY + 100)
      .run();
    await seen(DAY, [
      ["o1", "r1", "Stopped01"],
      ["o1", "r2", "Stopped01"],
      ["o1", "r2", "Stopped02"],
    ]);
    await store.stop("Stopped01", DAY);
    await store.stop("Stopped02", DAY);
    await store.sweep(DAY + 1);
    expect((await days()).results).toEqual([{ doc: "Stopped01", day: DAY, nets: 2 }]);
    expect(await doc("Stopped02")).toBeNull();
  });

  it("is not kept for a document that is not there, which no reader could have been served", async () => {
    await create("Present01", { ttlDays: 15 });
    await put("Present01", 1, T0);
    await seen(DAY, [
      ["o1", "r1", "Present01"],
      ["o1", "r1", "Gone0001"],
      ["o2", "r9", "Gone0001"],
    ]);
    await store.sweep(DAY + 1);
    expect((await days()).results.map((one) => one.doc)).toEqual(["Present01"]);
  });

  it("is not brought back for a document forgotten before its late day is added", async () => {
    await create("Late0001", { ttlDays: 1 });
    await put("Late0001", 1, T0);
    await seen(DAY, [["o1", "r1", "Late0001"]]);
    await testEnv.DB.prepare("UPDATE docs SET latest = -1 WHERE id = 'Late0001'").run();
    await store.sweep(DAY + 1);
    expect((await days()).results).toEqual([]);
    expect(await doc("Late0001")).toBeNull();
  });

  it("adds twice the same day to one row, and counts the document's service day once", async () => {
    await create("Twice002", { ttlDays: 15 });
    await put("Twice002", 1, T0);
    await seen(DAY, [["o1", "r1", "Twice002"]]);
    await store.sweep(DAY + 1);
    await seen(DAY, [["o1", "r2", "Twice002"]]);
    await store.sweep(DAY + 1);
    expect((await days()).results).toEqual([{ doc: "Twice002", day: DAY, nets: 2 }]);
  });
});

describe("the sweep that blocks what waited", () => {
  const net = (n: number) => `net-${n}`;
  const insertReports = async (docId: string, asns: number[], at = DAY) => {
    for (const [i, asn] of asns.entries())
      await testEnv.DB.prepare(
        `INSERT INTO reports (doc, net, at, at_hour, category, asn, level, version, over_cap)
         VALUES (?, ?, ?, ?, 'phishing', ?, 'medium', 1, 0)`,
      )
        .bind(docId, `${docId}-${i}`, at, at * 24, asn)
        .run();
  };

  it("blocks nothing three reports from one provider make, and everything two providers make", async () => {
    await create("OneAsn001");
    await put("OneAsn001", 1, T0);
    await insertReports("OneAsn001", [7, 7, 7]);
    await create("TwoAsn001");
    await put("TwoAsn001", 1, T0);
    await insertReports("TwoAsn001", [7, 7, 8]);
    await store.sweep(DAY);
    expect((await doc("OneAsn001"))?.blocked_at).toBeNull();
    expect((await doc("TwoAsn001"))?.blocked_at).toBe(DAY);
  });

  it("is not filled up by documents that cannot be blocked: one real document behind 500 of them is still blocked", async () => {
    for (let n = 0; n < 501; n += 1) {
      const id = `Junk${String(n).padStart(4, "0")}`;
      await create(id, {}, DAY);
      await put(id, 1, T0);
      await insertReports(id, [7, 7, 7], DAY - 3);
    }
    await create("RealOne01");
    await put("RealOne01", 1, T0);
    await insertReports("RealOne01", [7, 8, 9], DAY);
    await store.sweep(DAY);
    expect((await doc("RealOne01"))?.blocked_at).toBe(DAY);
  }, 60_000);

  it("goes on with the oldest first, 500 at a time", async () => {
    for (let n = 0; n < 520; n += 1) {
      const id = `Old${String(n).padStart(5, "0")}`;
      await create(id);
      await put(id, 1, T0);
      await insertReports(id, [7, 8, 9], DAY - 1 - (n % 3));
    }
    await store.sweep(DAY);
    const blocked = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE blocked_at IS NOT NULL").first<{
      n: number;
    }>();
    expect(blocked?.n).toBeLessThanOrEqual(500);
    const left = await testEnv.DB.prepare(
      "SELECT DISTINCT r.at FROM reports r JOIN docs d ON d.id = r.doc WHERE d.blocked_at IS NULL",
    ).all<{ at: number }>();
    expect(
      left.results.map((one) => one.at),
      "the newest reports wait, the oldest are blocked first",
    ).toEqual([DAY - 1]);
    await store.sweep(DAY, DAY * 24 + 1);
    const all = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE blocked_at IS NOT NULL").first<{
      n: number;
    }>();
    expect(all?.n).toBe(520);
    expect(net(1)).toBe("net-1");
  }, 60_000);

  it("does not block a document whose reports are from a network found false", async () => {
    await create("FalseSw01");
    await put("FalseSw01", 1, T0);
    await insertReports("FalseSw01", [7, 8, 9]);
    await testEnv.DB.prepare("INSERT INTO false_reporters (net, at) VALUES ('FalseSw01-0', ?)").bind(DAY).run();
    await store.sweep(DAY);
    expect((await doc("FalseSw01"))?.blocked_at).toBeNull();
  });
});

describe("an appeal that accepts itself", () => {
  const byOthers = async (id: string, version: number, day: number) => {
    for (const [i, asn] of [1, 2, 3].entries())
      await store.report({ doc: id, net: `${id}-${day}-${i}`, asn, category: "phishing", version }, day, day * 24);
  };
  const BY_ANOTHER = { signer: "another-editor", byOwner: false };

  it("happens once for a document: the second block goes to the operator", async () => {
    await create("Appeal001");
    await put("Appeal001", 1, T0, BY_ANOTHER);
    await byOthers("Appeal001", 1, DAY);
    expect((await doc("Appeal001"))?.blocked_at).toBe(DAY);
    expect(await store.appeal("Appeal001", DAY, DAY * 24)).toBe("accepted");
    await store.appealAccepted("Appeal001", DAY);
    expect((await doc("Appeal001"))?.blocked_at).toBeNull();
    expect((await doc("Appeal001"))?.counts_from).toBe(2);

    await put("Appeal001", 2, T0 + 2 * DAY_MS, BY_ANOTHER, DAY + 2);
    await byOthers("Appeal001", 2, DAY + 3);
    expect((await doc("Appeal001"))?.blocked_at).toBe(DAY + 3);
    expect(await store.appeal("Appeal001", DAY + 3, (DAY + 3) * 24)).toBe("review");
    expect((await doc("Appeal001"))?.counts_from).toBe(2);
  });

  it("does not accept a second appeal of the same block, nor one on a block that is the operator's", async () => {
    await create("Appeal002");
    await put("Appeal002", 1, T0, BY_ANOTHER);
    await byOthers("Appeal002", 1, DAY);
    await moderation.block("Appeal002", "looks real", T0);
    expect(await store.appeal("Appeal002", DAY, DAY * 24)).toBe("review");
  });

  it("does not accept the appeal of a block that reports from the owner's own signature made", async () => {
    await create("Appeal003");
    await put("Appeal003", 1, T0);
    await byOthers("Appeal003", 1, DAY);
    expect(await store.appeal("Appeal003", DAY, DAY * 24)).toBe("review");
  });

  it("keeps accepting for another document of the same owner", async () => {
    for (const id of ["Appeal004", "Appeal005"]) {
      await create(id, { owner: "same-owner" });
      await put(id, 1, T0, { ...BY_ANOTHER });
      await byOthers(id, 1, DAY);
      expect(await store.appeal(id, DAY, DAY * 24)).toBe("accepted");
    }
  });

  it("does not accept it while a child abuse report still counts, and then goes to the operator", async () => {
    await create("Appeal006");
    await put("Appeal006", 1, T0, BY_ANOTHER);
    await byOthers("Appeal006", 1, DAY);
    await store.report(
      { doc: "Appeal006", net: "csam-net", asn: 9, category: "csam", sealedLink: LINK, version: 1 },
      DAY,
      DAY * 24,
    );
    expect(await store.appeal("Appeal006", DAY, DAY * 24)).toBe("review");
  });
});

describe("a network found false, by the hour", () => {
  const report = (id: string, net: string, hour: number, over: Record<string, unknown> = {}) =>
    store.report({ doc: id, net, asn: 1, category: "phishing", version: 1, ...over }, DAY, hour);
  const setup = async (id: string) => {
    await create(id, { ttlDays: 15 });
    await put(id, 1, T0);
    await put(id, 2, T0 + HOUR_MS);
  };
  const markedAt = (id: string, net: string, hour: number) => moderation.reportWasFalse(id, net, hour * HOUR_MS);
  // A document past its days stays only while a report still counts as evidence, so what survives says what counts.
  const evidenceAmong = async (ids: string[]): Promise<Record<string, boolean>> => {
    await testEnv.DB.prepare(`UPDATE docs SET dies_on = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(DAY - 5, ...ids)
      .run();
    await store.sweep(DAY);
    const found: Record<string, boolean> = {};
    for (const id of ids) found[id] = (await doc(id)) !== null;
    return found;
  };

  it("counts what the network reported in the hours before the mark, and nothing from the hour of the mark on", async () => {
    for (const id of ["FalseHr01", "FalseHr02", "FalseHr03", "FalseHr04", "FalseHr05"]) await setup(id);
    await report("FalseHr01", "shared", HOUR + 5);
    await report("FalseHr02", "shared", HOUR + 4);
    await report("FalseHr03", "shared", HOUR + 5);
    await report("FalseHr04", "shared", HOUR + 6);
    await report("FalseHr05", "other-net", HOUR + 9);
    await markedAt("FalseHr01", "shared", HOUR + 5);
    const marked = await testEnv.DB.prepare(
      "SELECT since, since_hour FROM false_reporters WHERE net = 'shared'",
    ).first();
    expect(marked).toEqual({ since: DAY, since_hour: HOUR + 5 });
    expect(await evidenceAmong(["FalseHr01", "FalseHr02", "FalseHr03", "FalseHr04", "FalseHr05"])).toEqual({
      FalseHr01: false,
      FalseHr02: true,
      FalseHr03: false,
      FalseHr04: false,
      FalseHr05: true,
    });
  });

  it("keeps counting what the network said before the mark when it says nothing more", async () => {
    await setup("FalseHr06");
    await setup("FalseHr07");
    await report("FalseHr06", "shared", HOUR + 1);
    await report("FalseHr07", "shared", HOUR + 2);
    await markedAt("FalseHr07", "shared", HOUR + 5);
    await report("FalseHr06", "shared", HOUR + 9);
    const row = await testEnv.DB.prepare("SELECT at_hour FROM reports WHERE doc = 'FalseHr06'").first<{
      at_hour: number;
    }>();
    expect(row?.at_hour).toBe(HOUR + 1);
    expect(await evidenceAmong(["FalseHr06", "FalseHr07"])).toEqual({ FalseHr06: true, FalseHr07: false });
  });

  it("does not count as evidence a report the marked network raised to child abuse after the mark", async () => {
    await setup("FalseHr16");
    await setup("FalseHr17");
    await report("FalseHr16", "shared", HOUR + 1);
    await report("FalseHr17", "shared", HOUR + 2);
    await markedAt("FalseHr17", "shared", HOUR + 5);
    await report("FalseHr16", "shared", HOUR + 9, { category: "csam", sealedLink: LINK });
    const row = await testEnv.DB.prepare("SELECT level, at_hour FROM reports WHERE doc = 'FalseHr16'").first<{
      level: string;
      at_hour: number;
    }>();
    expect(row?.level, "a network found false cannot raise what it said before").toBe("medium");
    expect(await evidenceAmong(["FalseHr16"]), "what it said before the mark still holds, as the terms say").toEqual({
      FalseHr16: true,
    });
  });

  it("takes a report the network makes again after being found false on that document as one of the mark's hour or later", async () => {
    await setup("FalseHr08");
    await report("FalseHr08", "shared", HOUR + 1, { category: "spam" });
    await markedAt("FalseHr08", "shared", HOUR + 5);
    await report("FalseHr08", "shared", HOUR + 9, { version: 2 });
    const row = await testEnv.DB.prepare("SELECT at_hour, cleared, level FROM reports WHERE doc = 'FalseHr08'").first();
    expect(row).toMatchObject({ at_hour: HOUR + 9 });
    expect(await evidenceAmong(["FalseHr08"])).toEqual({ FalseHr08: false });
  });

  it("falls back to the day for a network marked before the hour was kept: a later day does not count, the same day still does", async () => {
    for (const id of ["FalseHr10", "FalseHr11", "FalseHr12"]) await setup(id);
    await store.report(
      { doc: "FalseHr10", net: "legacy", asn: 1, category: "phishing", version: 1 },
      DAY - 1,
      (DAY - 1) * 24,
    );
    await store.report(
      { doc: "FalseHr11", net: "legacy", asn: 1, category: "phishing", version: 1 },
      DAY + 1,
      (DAY + 1) * 24,
    );
    await store.report(
      { doc: "FalseHr12", net: "legacy", asn: 1, category: "phishing", version: 1 },
      DAY,
      DAY * 24 + 3,
    );
    await testEnv.DB.prepare("INSERT INTO false_reporters (net, at, since, since_hour) VALUES ('legacy', ?, ?, NULL)")
      .bind(DAY, DAY)
      .run();
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'FalseHr11'")
      .bind(DAY + 5)
      .run();
    expect(await evidenceAmong(["FalseHr10", "FalseHr12"])).toEqual({ FalseHr10: true, FalseHr12: true });
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'FalseHr11'")
      .bind(DAY - 5)
      .run();
    expect((await evidenceAmong(["FalseHr11"])).FalseHr11).toBe(false);
  });

  it("falls back to the day when there is no day either, for a mark that kept neither", async () => {
    await setup("FalseHr13");
    await store.report(
      { doc: "FalseHr13", net: "oldest", asn: 1, category: "phishing", version: 1 },
      DAY + 1,
      (DAY + 1) * 24,
    );
    await testEnv.DB.prepare("INSERT INTO false_reporters (net, at) VALUES ('oldest', ?)").bind(DAY).run();
    expect(await evidenceAmong(["FalseHr13"])).toEqual({ FalseHr13: false });
  });

  it("keeps the first hour of a network when it is found false again", async () => {
    await setup("FalseHr14");
    await setup("FalseHr15");
    await report("FalseHr14", "again", HOUR + 1);
    await report("FalseHr15", "again", HOUR + 2);
    await markedAt("FalseHr14", "again", HOUR + 3);
    await moderation.networkWasFalse("FalseHr15", "again", (HOUR + 9) * HOUR_MS);
    const row = await testEnv.DB.prepare("SELECT since_hour FROM false_reporters WHERE net = 'again'").first<{
      since_hour: number;
    }>();
    expect(row?.since_hour).toBe(HOUR + 3);
  });

  it("logs a false network on every document it clears, and only on those", async () => {
    for (const id of ["NetLog001", "NetLog002", "NetLog003", "NetLog004"]) await setup(id);
    for (const id of ["NetLog001", "NetLog002", "NetLog003"]) await report(id, "wide", HOUR);
    await report("NetLog004", "narrow", HOUR);
    expect(await moderation.networkWasFalse("NetLog001", "wide", T0 + 7 * HOUR_MS)).toBe("done");
    const rows = await testEnv.DB.prepare("SELECT doc, action FROM moderation ORDER BY doc").all<{
      doc: string;
      action: string;
    }>();
    expect(rows.results).toEqual([
      { doc: "NetLog001", action: "false_network" },
      { doc: "NetLog002", action: "false_network" },
      { doc: "NetLog003", action: "false_network" },
    ]);
    expect(await moderation.networkWasFalse("NetLog001", "wide", T0 + 8 * HOUR_MS)).toBe("missing");
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM moderation").first<{ n: number }>())?.n).toBe(3);
  });
});

describe("handing a document over to an authority", () => {
  const ready = async (id: string) => {
    await create(id);
    await put(id, 1, T0);
    await store.report({ doc: id, net: "n1", asn: 1, category: "phishing", sealedLink: LINK, version: 1 }, DAY, HOUR);
    await moderation.panic(id, "the court asked", T0);
    await moderation.makeCase(id, { version: 1, tokenHash: "T".repeat(43), sealedRecords: "case1.xx" }, T0);
  };
  const mayHandOver = async (id: string): Promise<boolean> =>
    (await moderation.queue(T0)).docs.find((one) => one.id === id)?.mayHandOver ?? false;
  const sealed = async (id: string): Promise<number> =>
    (
      await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE doc = ? AND sealed_link IS NOT NULL")
        .bind(id)
        .first<{ n: number }>()
    )?.n ?? 0;
  let tick = 0;
  const open = (id: string, reason: string) => moderation.opened(id, reason, T0 + 1000 + ++tick);

  it("is offered only after the report was opened with a reason of the operator's", async () => {
    await ready("Hand00001");
    expect(await mayHandOver("Hand00001")).toBe(false);
    expect(await moderation.handedOver("Hand00001", T0 + 5000)).toBe("missing");
    expect(await sealed("Hand00001")).toBe(1);
    await open("Hand00001", "verificar la denuncia");
    expect(await mayHandOver("Hand00001")).toBe(true);
    expect(await moderation.handedOver("Hand00001", T0 + 9000)).toBe("done");
    expect(await sealed("Hand00001")).toBe(0);
  });

  it("is not offered after only a case link was opened by whoever has it", async () => {
    await ready("Hand00002");
    await testEnv.DB.prepare("INSERT INTO openings (doc, at, reason, kind) SELECT ?1, ?2, 'case ' || ?3, 'case'")
      .bind("Hand00002", T0 + 5, "abcdefgh")
      .run();
    expect(await mayHandOver("Hand00002")).toBe(false);
    expect(await moderation.handedOver("Hand00002", T0 + 6000)).toBe("missing");
    expect(await sealed("Hand00002")).toBe(1);
  });

  it("is not offered after only the reporter's email was read, which brings nobody the key", async () => {
    await ready("Hand00003");
    await moderation.opened("Hand00003", "preguntar algo", T0 + 1000 + ++tick, "contact");
    expect(await mayHandOver("Hand00003")).toBe(false);
    expect(await moderation.handedOver("Hand00003", T0 + 6000)).toBe("missing");
    await open("Hand00003", "ahora si el link");
    expect(await mayHandOver("Hand00003")).toBe(true);
  });

  it("does not erase the seal of a document that is not blocked by the operator or has no case for the authority", async () => {
    await create("Hand00004");
    await put("Hand00004", 1, T0);
    await store.report(
      { doc: "Hand00004", net: "n1", asn: 1, category: "phishing", sealedLink: LINK, version: 1 },
      DAY,
      HOUR,
    );
    await open("Hand00004", "verificar");
    expect(await moderation.handedOver("Hand00004", T0 + 7000)).toBe("missing");
    await moderation.panic("Hand00004", "x", T0);
    expect(await moderation.handedOver("Hand00004", T0 + 7000)).toBe("missing");
    await moderation.makeCase("Hand00004", { version: 1, tokenHash: "U".repeat(43) }, T0);
    expect(await moderation.handedOver("Hand00004", T0 + 7000)).toBe("missing");
    expect(await sealed("Hand00004")).toBe(1);
  });

  it("does not take an operator's own reason that merely starts with those words for the other kinds of opening", async () => {
    await ready("Hand00005");
    await open("Hand00005", "Case urgente: la policia pidio verlo");
    expect(await mayHandOver("Hand00005"), "an opening typed with a capital C").toBe(true);
  });

  it("does not take a reason that starts with «Correo: » in capitals for reading the email either way", async () => {
    await ready("Hand00006");
    await open("Hand00006", "Correo: la policia pidio verlo");
    expect(await mayHandOver("Hand00006")).toBe(true);
  });

  it("says a document that is not there is missing, writes nothing about it, and says done for one that is", async () => {
    expect(await moderation.opened("Nothing01", "x", T0)).toBe("missing");
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM openings").first<{ n: number }>())?.n).toBe(0);
    await create("Exists001");
    expect(await moderation.opened("Exists001", "x", T0)).toBe("done");
    expect(await moderation.opened("Exists001", "x", T0)).toBe("done");
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM openings").first<{ n: number }>())?.n).toBe(1);
  });

  it("says a document is there even while it is being forgotten, since its row is", async () => {
    await create("Claimed01");
    await testEnv.DB.prepare("UPDATE docs SET latest = -1 WHERE id = 'Claimed01'").run();
    expect(await moderation.opened("Claimed01", "x", T0)).toBe("done");
  });
});

describe("every view of what a key holds says the same", () => {
  const dashboard = new CloudDashboard(testEnv.DB);
  const NOW = (DAY + 5) * DAY_MS + HOUR_MS;
  const fill = async () => {
    await testEnv.DB.prepare(
      "UPDATE docs SET latest = 1, versions = ?, files_bytes = 50, first_day = ? WHERE owner = 'o1'",
    )
      .bind(JSON.stringify([{ n: 1, hash: "h", bytes: 100, at: T0, signer: "s", machine: "m", contract: "c" }]), DAY)
      .run();
  };
  const group = async () => {
    await create("anchor1", { owner: "o1", ttlDays: 15 });
    await create("langOk1", { owner: "o1", anchor: "anchor1", ttlDays: 1 });
    await create("anchor2", { owner: "o1", ttlDays: 15 });
    await create("langBad", { owner: "o1", anchor: "anchor2", ttlDays: 1 });
    await fill();
    await store.stop("anchor2", DAY + 2);
  };

  it("counts the same documents as open and the same bytes as held in the dashboard, a key's view and the top", async () => {
    await group();
    const overview = await dashboard.overview(NOW);
    const key = await dashboard.key("o1", NOW);
    const top = await dashboard.top(NOW, "oldest", false);
    const held = await store.heldByOwner("o1", DAY + 5, "");
    expect(overview.docs.open, "anchors served").toBe(1);
    expect(overview.docs.withLanguages).toBe(1);
    expect(key?.holds).toBe(held);
    const served = key?.listed
      .filter((one) => one.alive)
      .map((one) => one.id)
      .sort();
    const notStopped = top.docs
      .filter((one) => !one.stopped)
      .map((one) => one.id)
      .sort();
    expect(served).toEqual(notStopped);
    expect(served, "a language its stopped anchor no longer serves").toEqual(["anchor1", "langOk1"]);
    expect(held).toBe(300);
  });

  it("calls a language unserved in every view when its anchor is stopped, though its own days have not ended", async () => {
    await create("anchor3", { owner: "o1", ttlDays: 15 });
    await create("langOwn", { owner: "o1", anchor: "anchor3", ttlDays: 15 });
    await fill();
    await store.stop("anchor3", DAY + 2);
    const key = await dashboard.key("o1", NOW);
    const top = await dashboard.top(NOW, "oldest", false);
    const overview = await dashboard.overview(NOW);
    expect((await store.shown("langOwn", DAY + 5))?.alive).toBe(false);
    expect(key?.listed.find((one) => one.id === "langOwn")?.alive, "key view").toBe(false);
    expect(top.docs.find((one) => one.id === "langOwn")?.stopped, "top").toBe(true);
    expect(overview.docs.withLanguages, "dashboard").toBe(0);
    expect(key?.holds, "room").toBe(0);
  });
});

describe("the top of documents, flagged only", () => {
  const dashboard = new CloudDashboard(testEnv.DB);
  const NOW = (DAY + 5) * DAY_MS + HOUR_MS;

  it("finds a flagged document wherever it comes in the order, not only among the first thousand", async () => {
    const insert = testEnv.DB.prepare(
      `INSERT INTO docs (id, owner, admin_hash, latest, versions, bytes, ttl_days, dies_on, active_day, first_day)
       VALUES (?1, ?2, 'a', 1, ?3, 10, 15, ?4, ?5, ?5)`,
    );
    const versions = JSON.stringify([{ n: 1, hash: "h", bytes: 10, at: T0, signer: "s", machine: "m", contract: "c" }]);
    const rows = [];
    for (let n = 0; n < 1001; n += 1)
      rows.push(insert.bind(`Top${String(n).padStart(5, "0")}`, `owner${n}`, versions, DAY + 15, DAY));
    for (let from = 0; from < rows.length; from += 100) await testEnv.DB.batch(rows.slice(from, from + 100));
    await testEnv.DB.prepare(
      "INSERT INTO reports (doc, net, at, at_hour, category, asn, level, version, over_cap) VALUES ('Top01000', 'n', ?, ?, 'csam', 1, 'grave', 1, 0)",
    )
      .bind(DAY + 5, (DAY + 5) * 24)
      .run();
    const flagged = await dashboard.top(NOW, "oldest", true);
    expect(flagged.docs.map((one) => one.id)).toContain("Top01000");
  });
});
