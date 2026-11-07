import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cloud } from "../src/cloudflare/store";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const DAY = 20_000;
const LINK = `sealed1.${"A".repeat(150)}`;
const store = new Cloud(testEnv);

const upload = (id: string, n: number, signer = "owner") =>
  store.upload(
    {
      id,
      n,
      hash: `h${n}`,
      body: "sealed",
      net: "n",
      at: DAY,
      signer,
      machine: "m1",
      contract: "1.5.0",
      byOwner: signer === "owner",
      permit: null,
      ownerMark: "m1.t",
    },
    DAY,
  );

const shared = async (id: string, ttlDays = 15) => {
  await store.create({ id, owner: "owner", adminHash: "a", ttlDays, net: "n" }, DAY);
  await upload(id, 1);
};

const report = (doc: string, net: string, category: string, day: number, more: object = {}) =>
  store.report({ doc, net, asn: net.charCodeAt(0), category, ...more }, day, day * 24);

const row = (id: string) =>
  testEnv.DB.prepare("SELECT id, blocked_at, dies_on FROM docs WHERE id = ?").bind(id).first<{
    id: string;
    blocked_at: number | null;
    dies_on: number;
  }>();

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["docs", "reports", "false_reporters", "holds", "moderation"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("how long a report can hold a document", () => {
  it("does not go on forever by reporting again what already expired", async () => {
    await shared("Heldheld", 1);
    await store.stop("Heldheld", DAY);
    await report("Heldheld", "a", "phishing", DAY);
    await store.sweep(DAY + 170);
    expect(await row("Heldheld")).not.toBeNull();
    await report("Heldheld", "a", "phishing", DAY + 179, { sealedLink: LINK });
    await report("Heldheld", "b", "phishing", DAY + 179);
    await store.sweep(DAY + 181);
    await store.sweep(DAY + 182);
    expect(await row("Heldheld")).toBeNull();
  });

  it("takes reports while the document lives", async () => {
    await shared("Livingdc", 15);
    await report("Livingdc", "a", "phishing", DAY + 15);
    await store.sweep(DAY + 100);
    expect(await row("Livingdc")).not.toBeNull();
  });

  it("does not let reports on what expired block it and start the days again", async () => {
    await shared("Heldheld", 1);
    await report("Heldheld", "a", "phishing", DAY);
    await report("Heldheld", "b", "phishing", DAY);
    await report("Heldheld", "c", "phishing", DAY + 5);
    const held = await row("Heldheld");
    expect(held?.blocked_at).toBeNull();
    expect(held?.dies_on).toBe(DAY + 1);
  });

  it("takes reports on a page whose document still lives", async () => {
    await shared("Mainmain", 15);
    await store.create(
      { id: "Pagepage", owner: "owner", adminHash: "a", ttlDays: 15, net: "n", anchor: "Mainmain" },
      DAY,
    );
    await upload("Pagepage", 1);
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'Pagepage'")
      .bind(DAY - 5)
      .run();
    await report("Pagepage", "a", "phishing", DAY);
    const taken = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(taken?.n).toBe(1);
  });
});

describe("a block lifted through a second key", () => {
  const laundered = async () => {
    await shared("Launderd");
    await upload("Launderd", 2, "second-key");
    for (const net of ["a", "b", "c"]) await report("Launderd", net, "threat", DAY, { sealedLink: LINK, version: 2 });
    expect((await row("Launderd"))?.blocked_at).toBe(DAY);
    expect(await store.appeal("Launderd", DAY, DAY * 24)).toBe("accepted");
    await upload("Launderd", 3);
    expect((await row("Launderd"))?.blocked_at).toBeNull();
  };

  it("lets the same networks report what comes after, and block it again", async () => {
    await laundered();
    for (const net of ["a", "b", "c"]) {
      await report("Launderd", net, "threat", DAY + 1, { sealedLink: LINK, version: 3 });
    }
    expect((await row("Launderd"))?.blocked_at).toBe(DAY + 1);
  });

  it("does not let a report on what was already answered count again", async () => {
    await laundered();
    for (const net of ["a", "b", "c"]) {
      await report("Launderd", net, "threat", DAY + 1, { sealedLink: LINK, version: 2 });
    }
    expect((await row("Launderd"))?.blocked_at).toBeNull();
    const rows = await testEnv.DB.prepare("SELECT DISTINCT version, at FROM reports").all();
    expect(rows.results).toEqual([{ version: 2, at: DAY }]);
  });
});
