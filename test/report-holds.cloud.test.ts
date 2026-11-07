import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const DAY = 20_000;
const LINK = `sealed1.${"A".repeat(150)}`;
const store = new Cloud(testEnv);

const ownerOf = (id: string): string => `owner-${id}`;

const upload = (id: string, n: number, signer = ownerOf(id)) =>
  store.upload(
    {
      id,
      n,
      hash: `h${n}`,
      body: "sealed",
      net: `up-${id}`,
      at: DAY,
      signer,
      machine: "m1",
      contract: "1.5.0",
      byOwner: signer === ownerOf(id),
      permit: null,
      ownerMark: "m1.t",
    },
    DAY,
  );

const shared = async (id: string, ttlDays = 15) => {
  await store.create({ id, owner: ownerOf(id), adminHash: "a", ttlDays, net: `up-${id}` }, DAY);
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
      { id: "Pagepage", owner: ownerOf("Mainmain"), adminHash: "a", ttlDays: 15, net: "up-page", anchor: "Mainmain" },
      DAY,
    );
    await upload("Pagepage", 1, ownerOf("Mainmain"));
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'Pagepage'")
      .bind(DAY - 5)
      .run();
    await report("Pagepage", "a", "phishing", DAY);
    const taken = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(taken?.n).toBe(1);
  });
});

describe("the caps", () => {
  const cards = async (count: number, net: string, category = "phishing") => {
    for (let at = 0; at < count; at += 1) {
      const id = `Capdoc${String(at).padStart(2, "0")}`;
      if (!(await row(id))) await shared(id);
      await report(id, net, category, DAY, { detail: "imita a un banco" });
    }
  };
  const overCap = async (doc: string, net: string) =>
    (
      await testEnv.DB.prepare("SELECT over_cap FROM reports WHERE doc = ? AND net = ?")
        .bind(doc, net)
        .first<{ over_cap: number }>()
    )?.over_cap;

  it("counts a network on its first documents, and keeps the rest on record", async () => {
    await cards(21, "n");
    expect(await overCap("Capdoc19", "n")).toBe(0);
    expect(await overCap("Capdoc20", "n")).toBe(1);
    const stayed = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(stayed?.n).toBe(21);
    const { reports } = await new CloudModeration(testEnv.DB).queue(DAY * 86_400_000);
    expect(reports.filter((one) => one.overCap).map((one) => one.doc)).toEqual(["Capdoc20"]);
  });

  it("does not let what is past the cap block or hold", async () => {
    await cards(21, "n");
    await shared("OverLast");
    await report("OverLast", "n", "phishing", DAY);
    await report("OverLast", "b", "phishing", DAY);
    const { blocked } = await report("OverLast", "c", "phishing", DAY);
    expect(blocked).toBe(false);
    await testEnv.DB.prepare("DELETE FROM reports WHERE net IN ('b', 'c')").run();
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'OverLast'")
      .bind(DAY + 1)
      .run();
    await store.sweep(DAY + 10);
    expect(await row("OverLast")).toBeNull();
  });

  it("does not count cleared reports toward the cap, so a mistake does not close it", async () => {
    await cards(20, "n");
    await testEnv.DB.prepare("UPDATE reports SET cleared = 1").run();
    await shared("Afterclr");
    await report("Afterclr", "n", "phishing", DAY);
    expect(await overCap("Afterclr", "n")).toBe(0);
  });

  it("stops blocking on its own past the day's documents, and the mail says so", async () => {
    const reportedBy3 = async (id: string) => {
      await shared(id);
      let last = { blocked: false };
      for (const net of ["a", "b", "c"]) last = await report(id, net, "phishing", DAY);
      return last.blocked;
    };
    for (let at = 0; at < 10; at += 1) expect(await reportedBy3(`Blocks${String(at).padStart(2, "0")}`)).toBe(true);
    expect((await store.news(0, DAY * 24 + 1, 50)).autoBlocksFull).toBe(true);
    expect(await reportedBy3("Blocks10")).toBe(false);
    const stillThere = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE doc = 'Blocks10'").first<{
      n: number;
    }>();
    expect(stillThere?.n).toBe(3);
  });

  it("starts the count again the next day, and an operator's block does not use it", async () => {
    for (let at = 0; at < 10; at += 1) await shared(`Operator${at}`);
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?, blocked_by_operator = 1").bind(DAY).run();
    expect((await store.news(0, DAY * 24 + 1, 50)).autoBlocksFull).toBe(false);
    for (let at = 0; at < 10; at += 1) {
      const id = `Blocks${String(at).padStart(2, "0")}`;
      await shared(id);
      for (const net of ["a", "b", "c"]) await report(id, net, "phishing", DAY);
    }
    await shared("Nextdayy");
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = 'Nextdayy'")
      .bind(DAY + 20)
      .run();
    let last = { blocked: false };
    for (const net of ["a", "b", "c"]) last = await report("Nextdayy", net, "phishing", DAY + 1);
    expect(last.blocked).toBe(true);
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
