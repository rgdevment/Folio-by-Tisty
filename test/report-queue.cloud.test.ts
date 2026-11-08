import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import { sendDigest } from "../src/core/digest";
import { DAY_MS } from "../src/core/limits";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const DAY = 20_000;
const NOW = DAY * DAY_MS;
const HOUR = DAY * 24;
const store = new Cloud(testEnv);
const moderation = new CloudModeration(testEnv.DB);

const LINK = `sealed1.${"A".repeat(150)}`;

const shared = async (id: string, ttlDays = 3) => {
  await store.create({ id, owner: `o-${id}`, adminHash: "a", ttlDays, net: "n" }, DAY);
  await store.upload(
    {
      id,
      n: 1,
      hash: "h1",
      body: "sealed",
      net: "n",
      at: NOW,
      signer: `o-${id}`,
      machine: "m1",
      contract: "1.5.0",
      byOwner: true,
      permit: null,
      ownerMark: "m1.t",
    },
    DAY,
  );
};

const reportBy = (doc: string, net: string, category = "csam", day = DAY) =>
  store.report({ doc, net, asn: 1, category, version: 1, sealedLink: LINK }, day, day * 24);

const flood = async (nets: string[], docs: number) => {
  await testEnv.DB.batch(
    Array.from({ length: docs }, (_, at) =>
      testEnv.DB.prepare(
        "INSERT INTO docs (id, owner, admin_hash, latest, versions, ttl_days, dies_on, active_day) VALUES (?, 'x', 'a', 1, '[]', 3, ?, ?)",
      ).bind(`Flood${String(at).padStart(3, "0")}`, DAY + 3, DAY),
    ),
  );
  await testEnv.DB.batch(
    nets.flatMap((net) =>
      Array.from({ length: docs }, (_, at) =>
        testEnv.DB.prepare(
          "INSERT INTO reports (doc, net, at, at_hour, category, asn, level, version, sealed_link) VALUES (?, ?, ?, ?, 'csam', 1, 'grave', 1, ?)",
        ).bind(`Flood${String(at).padStart(3, "0")}`, net, DAY + 1, HOUR + 24, LINK),
      ),
    ),
  );
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["docs", "reports", "false_reporters", "moderation", "openings", "service_stage"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("a flood of false reports", () => {
  const realFirst = async () => {
    await shared("RealDocu");
    await reportBy("RealDocu", "a-real-reader");
    await flood(["attacker-1", "attacker-2"], 150);
  };

  it("does not push a real report out of the panel, however new it is", async () => {
    await realFirst();
    const { reports, reportsTotal } = await moderation.queue(NOW + DAY_MS * 2);
    expect(reportsTotal).toBe(301);
    expect(reports.slice(0, 3).map((one) => one.doc)).toContain("RealDocu");
  });

  it("does not bury other categories for being labeled child abuse", async () => {
    await shared("Threatdc");
    await shared("Phishdoc");
    await reportBy("Threatdc", "a-real-reader", "threat");
    await store.report({ doc: "Phishdoc", net: "another-reader", asn: 2, category: "phishing", version: 1 }, DAY, HOUR);
    await flood(["attacker-1", "attacker-2"], 150);
    const { reports } = await moderation.queue(NOW + DAY_MS * 2);
    expect(reports.slice(0, 4).map((one) => one.doc)).toEqual(expect.arrayContaining(["Threatdc", "Phishdoc"]));
    const send = vi.fn(async (_subject: string, _text: string) => {});
    await sendDigest(NOW + DAY_MS * 2, { store, send });
    const [subject, text] = send.mock.calls[0] ?? [];
    expect(text).toContain("Threatdc");
    expect(text).toContain("Phishdoc");
    expect(text).toContain("(hay más)");
    expect(subject).toContain("CSAM");
  });

  it("does not say there is more when all of it is listed", async () => {
    await shared("OneDocum");
    await reportBy("OneDocum", "a");
    await reportBy("OneDocum", "b");
    const send = vi.fn(async (_subject: string, _text: string) => {});
    await sendDigest(NOW + DAY_MS, { store, send });
    const text = send.mock.calls[0]?.[1] ?? "";
    expect(text).toContain("Denuncias nuevas (2):");
    expect(text).not.toContain("(hay más)");
  });

  it("lists a network already found false last in the mail too", async () => {
    await shared("Aaaaaaaa");
    await shared("Zzzzzzzz");
    await store.report({ doc: "Aaaaaaaa", net: "flagged", asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    await store.report({ doc: "Zzzzzzzz", net: "clean", asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    await testEnv.DB.prepare("INSERT INTO false_reporters (net, at) VALUES ('flagged', ?)").bind(DAY).run();
    const news = await store.news(HOUR - 1, HOUR + 1, 50);
    expect(news.reports.map((one) => one.doc)).toEqual(["Zzzzzzzz", "Aaaaaaaa"]);
  });

  it("lists first in the mail what more clean networks say", async () => {
    await shared("Aaaaaaaa");
    await shared("Zzzzzzzz");
    for (const net of ["flag-1", "flag-2"]) {
      await store.report({ doc: "Aaaaaaaa", net, asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
      await testEnv.DB.prepare("INSERT INTO false_reporters (net, at) VALUES (?, ?)").bind(net, DAY).run();
    }
    await store.report({ doc: "Aaaaaaaa", net: "clean-0", asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    for (const net of ["clean-1", "clean-2"]) {
      await store.report({ doc: "Zzzzzzzz", net, asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    }
    const news = await store.news(HOUR - 1, HOUR + 1, 50);
    expect(news.reports.map((one) => one.doc)).toEqual(["Zzzzzzzz", "Aaaaaaaa"]);
  });

  it("lists a network already found false after the others of the same weight", async () => {
    await shared("Aaaaaaaa");
    await shared("Zzzzzzzz");
    await reportBy("Aaaaaaaa", "flagged");
    await reportBy("Zzzzzzzz", "clean");
    await testEnv.DB.prepare("INSERT INTO false_reporters (net, at) VALUES ('flagged', ?)").bind(DAY).run();
    const { reports } = await moderation.queue(NOW);
    expect(reports.map((one) => one.net)).toEqual(["clean", "flagged"]);
  });

  it("lets the operator reach every report, page by page", async () => {
    await realFirst();
    const seen = new Set<string>();
    for (let from = 0; from < 301; from += 200) {
      const { reports } = await moderation.queue(NOW, from);
      for (const one of reports) seen.add(`${one.doc}|${one.net}`);
    }
    expect(seen.size).toBe(301);
  });

  it("does not push a real report out of the mail, and says how many there are", async () => {
    await realFirst();
    const send = vi.fn(async (_subject: string, _text: string) => {});
    await sendDigest(NOW + DAY_MS * 2, { store, send });
    const text = send.mock.calls[0]?.[1] ?? "";
    expect(text).toContain("RealDocu");
    expect(text).toContain("Denuncias nuevas (301):");
  });

  it("still lists first what more networks say, among those of the same weight", async () => {
    await shared("OneDocum");
    await shared("TwoDocum");
    await store.report({ doc: "OneDocum", net: "a", asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    await store.report({ doc: "TwoDocum", net: "b", asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    await store.report({ doc: "TwoDocum", net: "c", asn: 2, category: "phishing", version: 1 }, DAY, HOUR);
    const news = await store.news(HOUR - 1, HOUR + 1, 50);
    expect(news.reports.map((one) => one.doc)).toEqual(["TwoDocum", "OneDocum"]);
  });
});

describe("the mail", () => {
  it("lists the gravest above what more networks say", async () => {
    await shared("Gravedoc");
    await shared("Mediumdc");
    await reportBy("Gravedoc", "a", "threat");
    for (const net of ["b", "c"]) {
      await store.report({ doc: "Mediumdc", net, asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    }
    const news = await store.news(HOUR - 1, HOUR + 1, 50);
    expect(news.reports.map((one) => one.doc)).toEqual(["Gravedoc", "Mediumdc"]);
    expect(news.reportsTotal).toBe(3);
    expect(news.reportLines).toBe(2);
  });
});

describe("marking a report false", () => {
  const evidence = async (doc: string) => {
    await testEnv.DB.prepare("UPDATE docs SET dies_on = ? WHERE id = ?")
      .bind(DAY + 1, doc)
      .run();
    await store.sweep(DAY + 10);
    return testEnv.DB.prepare("SELECT id FROM docs WHERE id = ?").bind(doc).first();
  };

  it("keeps the evidence of what that network reported before", async () => {
    await shared("Victimdc");
    await shared("Falsedoc");
    await reportBy("Victimdc", "shared", "csam", DAY);
    await reportBy("Falsedoc", "shared", "phishing", DAY + 1);
    await moderation.reportWasFalse("Falsedoc", "shared", (DAY + 2) * DAY_MS);
    expect(await evidence("Victimdc")).not.toBeNull();
  });

  it("keeps measuring from the first time, when that network is found false again", async () => {
    await shared("Falsedoc");
    await shared("Seconddc");
    await shared("Laterdoc");
    await reportBy("Falsedoc", "shared", "phishing", DAY);
    await moderation.reportWasFalse("Falsedoc", "shared", DAY * DAY_MS);
    await reportBy("Laterdoc", "shared", "phishing", DAY + 1);
    await store.report(
      { doc: "Seconddc", net: "shared", asn: 1, category: "phishing", version: 1 },
      DAY + 1,
      HOUR + 24,
    );
    await moderation.reportWasFalse("Seconddc", "shared", (DAY + 2) * DAY_MS);
    const row = await testEnv.DB.prepare("SELECT at, since FROM false_reporters").first();
    expect(row).toEqual({ at: DAY + 2, since: DAY });
    expect(await evidence("Laterdoc")).toBeNull();
  });

  it("keeps the evidence when a report it made before brings its link afterwards", async () => {
    await shared("Victimdc");
    await shared("Falsedoc");
    await store.report({ doc: "Victimdc", net: "shared", asn: 1, category: "phishing", version: 1 }, DAY, HOUR);
    await reportBy("Falsedoc", "shared", "phishing", DAY + 1);
    await moderation.reportWasFalse("Falsedoc", "shared", (DAY + 2) * DAY_MS);
    await reportBy("Victimdc", "shared", "phishing", DAY + 3);
    const row = await testEnv.DB.prepare("SELECT at, sealed_link FROM reports WHERE doc = 'Victimdc'").first();
    expect(row).toEqual({ at: DAY, sealed_link: LINK });
    expect(await evidence("Victimdc")).not.toBeNull();
  });

  it("gives a cleared report that comes back its new date, so it holds nothing", async () => {
    await shared("Falsedoc");
    await reportBy("Falsedoc", "shared", "phishing", DAY);
    await moderation.reportWasFalse("Falsedoc", "shared", DAY * DAY_MS);
    await testEnv.DB.prepare(
      "UPDATE docs SET latest = 2, versions = json_insert(versions, '$[#]', json_object('n', 2)) WHERE id = 'Falsedoc'",
    ).run();
    await store.report(
      { doc: "Falsedoc", net: "shared", asn: 1, category: "csam", version: 2, sealedLink: LINK },
      DAY + 1,
      HOUR + 24,
    );
    const row = await testEnv.DB.prepare("SELECT at, cleared FROM reports").first();
    expect(row).toEqual({ at: DAY + 1, cleared: 0 });
    expect(await evidence("Falsedoc")).toBeNull();
  });

  it("can discard everything that network reported at once, and no other network's", async () => {
    await shared("Falsedoc");
    await shared("Otherdoc");
    await reportBy("Falsedoc", "shared", "phishing", DAY);
    await reportBy("Otherdoc", "shared", "phishing", DAY);
    await reportBy("Otherdoc", "clean", "phishing", DAY);
    expect(await moderation.networkWasFalse("Falsedoc", "shared", (DAY + 1) * DAY_MS)).toBe("done");
    const left = await testEnv.DB.prepare("SELECT doc, net FROM reports WHERE cleared = 0").all();
    expect(left.results).toEqual([{ doc: "Otherdoc", net: "clean" }]);
    const named = await testEnv.DB.prepare("SELECT net, at, since FROM false_reporters").all();
    expect(named.results).toEqual([{ net: "shared", at: DAY + 1, since: DAY + 1 }]);
    const logged = await testEnv.DB.prepare("SELECT doc, action FROM moderation ORDER BY doc").all();
    expect(logged.results).toEqual([
      { doc: "Falsedoc", action: "false_network" },
      { doc: "Otherdoc", action: "false_network" },
    ]);
    expect(await moderation.networkWasFalse("Falsedoc", "shared", (DAY + 1) * DAY_MS)).toBe("missing");
  });

  it("does not let that network hold anything afterwards", async () => {
    await shared("Falsedoc");
    await shared("Laterdoc");
    await reportBy("Falsedoc", "shared", "phishing", DAY);
    await moderation.reportWasFalse("Falsedoc", "shared", DAY * DAY_MS);
    await reportBy("Laterdoc", "shared", "phishing", DAY + 1);
    expect(await evidence("Laterdoc")).toBeNull();
  });

  it("tells the same day apart by the hour: what came after the mark holds nothing, what came before still does", async () => {
    await shared("Falsedoc");
    await shared("Beforedc");
    await shared("Laterdoc");
    const at = (doc: string, hour: number) =>
      store.report({ doc, net: "shared", asn: 1, category: "phishing", version: 1 }, DAY, DAY * 24 + hour);
    await at("Falsedoc", 2);
    await at("Beforedc", 3);
    await moderation.reportWasFalse("Falsedoc", "shared", (DAY * 24 + 5) * 3_600_000);
    await at("Laterdoc", 9);
    expect(await evidence("Laterdoc")).toBeNull();
    expect(await testEnv.DB.prepare("SELECT id FROM docs WHERE id = 'Beforedc'").first()).not.toBeNull();
  });

  it("does not let an appeal lift itself over child abuse reported before", async () => {
    await shared("Victimdc");
    await testEnv.DB.prepare(
      "UPDATE docs SET blocked_at = ?, blocked_hour = ?, versions = json_set(versions, '$[0].signer', 'other') WHERE id = 'Victimdc'",
    )
      .bind(DAY, HOUR)
      .run();
    await reportBy("Victimdc", "shared", "csam", DAY);
    await store.report({ doc: "Victimdc", net: "other", asn: 2, category: "phishing", version: 1 }, DAY, HOUR);
    await shared("Falsedoc");
    await reportBy("Falsedoc", "shared", "phishing", DAY + 1);
    await moderation.reportWasFalse("Falsedoc", "shared", (DAY + 2) * DAY_MS);
    expect(await store.appeal("Victimdc", DAY + 3, (DAY + 3) * 24)).toBe("review");
  });

  it("still stops that network from blocking", async () => {
    await shared("Falsedoc");
    await shared("Laterdoc");
    await reportBy("Falsedoc", "shared", "phishing", DAY);
    await moderation.reportWasFalse("Falsedoc", "shared", DAY * DAY_MS);
    await store.report(
      { doc: "Laterdoc", net: "shared", asn: 1, category: "phishing", version: 1 },
      DAY + 1,
      HOUR + 24,
    );
    await store.report({ doc: "Laterdoc", net: "b", asn: 2, category: "phishing", version: 1 }, DAY + 1, HOUR + 24);
    const { blocked } = await store.report(
      { doc: "Laterdoc", net: "c", asn: 3, category: "phishing", version: 1 },
      DAY + 1,
      HOUR + 24,
    );
    expect(blocked).toBe(false);
  });
});
