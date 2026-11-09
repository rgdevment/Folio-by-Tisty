import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cloud } from "../src/cloudflare/store";
import { LEVEL_ONE } from "../src/core/limits";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const TODAY = 20_400;
const store = new Cloud(testEnv, { ...LEVEL_ONE, sharesAtMost: 100, newSharesADay: 3 });
const create = (id: string, over: { owner?: string; anchor?: string; net?: string } = {}, today = TODAY) =>
  store.create({ id, owner: "o1", adminHash: "a", ttlDays: 3, net: "n", ...over }, today);

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["docs", "net_day", "net_hour"]) await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
});

describe("new documents a key shares in a day", () => {
  it("stop at the daily cap, though more could be shared at once", async () => {
    for (const id of ["Day1aaaa", "Day2aaaa", "Day3aaaa"]) expect(await create(id)).toBe("created");
    expect(await create("Day4aaaa")).toBe("day_full");
    expect(await testEnv.DB.prepare("SELECT id FROM docs WHERE id = 'Day4aaaa'").first()).toBeNull();
  });

  it("count a document even after it stops being shared", async () => {
    for (const id of ["Day1aaaa", "Day2aaaa", "Day3aaaa"]) await create(id);
    await testEnv.DB.prepare("DELETE FROM docs").run();
    expect(await create("Day4aaaa")).toBe("day_full");
  });

  it("leave a document's languages and its retries out", async () => {
    expect(await create("Day1aaaa")).toBe("created");
    expect(await create("Day1aaaa")).toBe("same");
    for (const id of ["Lang1aaa", "Lang2aaa", "Lang3aaa"]) {
      expect(await create(id, { anchor: "Day1aaaa" })).toBe("created");
    }
    expect(await create("Day2aaaa")).toBe("created");
    expect(await create("Day3aaaa")).toBe("created");
  });

  it("are each key's, and start over the next day", async () => {
    for (const id of ["Day1aaaa", "Day2aaaa", "Day3aaaa"]) await create(id);
    expect(await create("Ana1aaaa", { owner: "o2" })).toBe("created");
    expect(await create("Day4aaaa", {}, TODAY + 1)).toBe("created");
  });

  it("give the day's place back when a document is refused for another cap", async () => {
    const two = new Cloud(testEnv, { ...LEVEL_ONE, sharesAtMost: 1, newSharesADay: 3 });
    const make = (id: string) => two.create({ id, owner: "o3", adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
    expect(await make("Two1aaaa")).toBe("created");
    for (const id of ["Two2aaaa", "Two3aaaa", "Two4aaaa", "Two5aaaa"]) expect(await make(id)).toBe("shares_full");
    await testEnv.DB.prepare("DELETE FROM docs WHERE id = 'Two1aaaa'").run();
    expect(await make("Two6aaaa")).toBe("created");
  });

  it("give back the network's share of the day when they refuse", async () => {
    for (const id of ["Day1aaaa", "Day2aaaa", "Day3aaaa"]) await create(id);
    const before = await testEnv.DB.prepare("SELECT docs FROM net_day WHERE net = 'n'").first<{ docs: number }>();
    await create("Day4aaaa");
    const after = await testEnv.DB.prepare("SELECT docs FROM net_day WHERE net = 'n'").first<{ docs: number }>();
    expect(after?.docs).toBe(before?.docs);
  });
});
