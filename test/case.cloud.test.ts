import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import { dayOf } from "../src/core/limits";
import { tokenHash } from "../src/core/start";
import worker from "../src/private/index";
import { SIGNED_BY_THE_OWNER } from "./sealed";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  FOLIO_SECRET: string;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const NOW = Date.now();
const TODAY = dayOf(NOW);
const ID = "AbCdEfGh";
const OTHER = "IjKlMnOp";
const TOKEN = "T".repeat(43);
const FILES = "F".repeat(43);
const SEALED = "case1.c2VhbGVk";
const store = new Cloud(testEnv);
const moderation = new CloudModeration(testEnv.DB);

let network = 0;

const share = async (id = ID) => {
  await store.create({ id, owner: "o1", adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
  for (const n of [1, 2]) {
    await store.upload(
      { ...SIGNED_BY_THE_OWNER, id, n, hash: `h${n}`, body: `version ${n}`, net: "n", at: 1000 + n },
      TODAY,
    );
  }
};

const send = async (path: string, token?: string) => {
  const context = createExecutionContext();
  const headers = new Headers({ "CF-Connecting-IP": `198.51.100.${network}` });
  if (token !== undefined) headers.set("Folio-Case", token);
  const response = await worker.fetch(
    new Request(`https://tisty.cl/api/v1/${path}`, { headers }) as Request<unknown, IncomingRequestCfProperties>,
    testEnv as never,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
};

const madeCase = async (version = 1, sealedRecords?: string, id = ID) =>
  moderation.makeCase(
    id,
    { version, tokenHash: await tokenHash(TOKEN), ...(sealedRecords ? { sealedRecords } : {}) },
    NOW,
  );

const openings = async () =>
  (await testEnv.DB.prepare("SELECT doc, reason FROM openings").all<{ doc: string; reason: string }>()).results;

const docRow = () =>
  testEnv.DB.prepare("SELECT blocked_at, blocked_by_operator, legal_until, dies_on, read_total FROM docs WHERE id = ?")
    .bind(ID)
    .first<{
      blocked_at: number | null;
      blocked_by_operator: number;
      legal_until: number | null;
      dies_on: number;
      read_total: number;
    }>();

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  network += 1;
  for (const table of ["docs", "reports", "cases", "openings", "moderation", "keys"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const held = await testEnv.ENVELOPES.list();
  if (held.objects.length > 0) await testEnv.ENVELOPES.delete(held.objects.map((one) => one.key));
  await share();
});

describe("the panic button", () => {
  it("blocks, holds for the evidence period, and keeps its reason on record", async () => {
    expect(await moderation.panic(ID, "looks real", NOW)).not.toBeNull();
    expect(await docRow()).toMatchObject({
      blocked_at: TODAY,
      blocked_by_operator: 1,
      legal_until: TODAY + 180,
      dies_on: TODAY + 180,
    });
    const logged = await testEnv.DB.prepare("SELECT action, note FROM moderation").all();
    expect(logged.results).toEqual([{ action: "panic", note: "looks real" }]);
  });

  it("takes over what reports already blocked, keeping when it was blocked", async () => {
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ? WHERE id = ?")
      .bind(TODAY - 5, ID)
      .run();
    await moderation.panic(ID, "looks real", NOW);
    expect(await docRow()).toMatchObject({ blocked_at: TODAY - 5, blocked_by_operator: 1 });
  });

  it("renews the hold when pressed again, and never shortens an order that asked for more", async () => {
    await moderation.panic(ID, "first", NOW);
    await moderation.panic(ID, "again", NOW + 10 * 86_400_000);
    expect((await docRow())?.legal_until).toBe(TODAY + 190);
    await testEnv.DB.prepare("UPDATE docs SET legal_until = ? WHERE id = ?")
      .bind(TODAY + 1000, ID)
      .run();
    await moderation.panic(ID, "third", NOW);
    expect((await docRow())?.legal_until).toBe(TODAY + 1000);
  });

  it("answers nothing for what does not exist", async () => {
    expect(await moderation.panic("Nothing1", "looks real", NOW)).toBeNull();
  });

  it("keeps what was reported from the sweep once its reports are past their time", async () => {
    await moderation.panic(ID, "looks real", NOW);
    await store.sweep(TODAY + 179);
    expect(await store.envelope(ID, { n: 1, hash: "h1" } as never)).not.toBeNull();
  });

  it("gathers the records and nothing about who reported", async () => {
    await store.keepKeys(["o1"], TODAY, { root: "o1", version: "7", hour: 99 });
    await store.report(
      {
        doc: ID,
        net: "secret-net",
        asn: 4242,
        category: "csam",
        version: 1,
        sealedLink: "sealed1.secret-link",
        detail: "said",
      },
      TODAY,
      1,
    );
    await moderation.opened(ID, "to verify", NOW);
    const records = (await moderation.panic(ID, "looks real", NOW + 1)) as Record<string, never>;
    const written = JSON.stringify(records);
    expect(written).not.toContain("secret-net");
    expect(written).not.toContain("4242");
    expect(written).not.toContain("secret-link");
    expect(records).toMatchObject({
      id: ID,
      owner: "o1",
      latest: 2,
      legal_until: TODAY + 180,
      ownerKey: { terms_version: "7", terms_hour: 99 },
      reports: [{ category: "csam", level: "grave", detail: "said", version: 1 }],
      actions: [{ action: "panic", note: "looks real" }],
      openings: [{ reason: "to verify" }],
    });
    expect((records.versions as unknown as { n: number }[]).map((one) => one.n)).toEqual([1, 2]);
  });
});

describe("making a case", () => {
  it("keeps only the hash of its token, and what it cannot open", async () => {
    expect(await madeCase(1, SEALED)).toBe("done");
    const row = await testEnv.DB.prepare("SELECT * FROM cases").first();
    expect(row).toEqual({
      token_hash: await tokenHash(TOKEN),
      doc: ID,
      version: 1,
      until: TODAY + 30,
      sealed_records: SEALED,
    });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("refuses a version the document does not hold, or a document that does not exist", async () => {
    expect(await madeCase(3)).toBe("missing");
    expect(await madeCase(1, undefined, "Nothing1")).toBe("missing");
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM moderation").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("saying it was handed over", () => {
  it("erases the sealed links of that document alone, and says so on record", async () => {
    await share(OTHER);
    for (const doc of [ID, OTHER]) {
      await store.report({ doc, net: "n1", asn: 1, category: "csam", version: 1, sealedLink: "sealed1.x" }, TODAY, 1);
    }
    expect(await moderation.handedOver(ID, NOW)).toBe("done");
    const left = await testEnv.DB.prepare("SELECT doc, sealed_link FROM reports ORDER BY doc = ?").bind(OTHER).all();
    expect(left.results).toEqual([
      { doc: ID, sealed_link: null },
      { doc: OTHER, sealed_link: "sealed1.x" },
    ]);
    const logged = await testEnv.DB.prepare("SELECT doc, action FROM moderation").all();
    expect(logged.results).toEqual([{ doc: ID, action: "handed_over" }]);
  });

  it("does nothing when there is nothing left to erase", async () => {
    expect(await moderation.handedOver(ID, NOW)).toBe("missing");
  });
});

describe("reading by a case link", () => {
  it("serves the version of the case on a blocked document, with what a page needs", async () => {
    await moderation.panic(ID, "looks real", NOW);
    await madeCase(1);
    const response = await send(`cases/${ID}`, TOKEN);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("version 1");
    expect(response.headers.get("Folio-Version")).toBe("1");
    expect(response.headers.get("Folio-Arrived")).toBe("1001");
    expect(Number(response.headers.get("Folio-Dies-On"))).toBe(TODAY + 180);
    expect(response.headers.get("Folio-Revocations")).toBe("[]");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("leaves the document blocked for everyone else", async () => {
    await moderation.panic(ID, "looks real", NOW);
    await madeCase(1);
    expect((await send(`docs/${ID}`)).status).toBe(403);
    expect((await send(`docs/${ID}`, TOKEN)).status).toBe(403);
  });

  it.each([
    ["no token", undefined],
    ["another token", "U".repeat(43)],
    ["what is not a token", "short"],
  ])("says nothing to %s", async (_, token) => {
    await madeCase(1);
    expect((await send(`cases/${ID}`, token)).status).toBe(404);
    expect(await openings()).toEqual([]);
  });

  it("does not open another document with the same token", async () => {
    await share(OTHER);
    await madeCase(1);
    expect((await send(`cases/${OTHER}`, TOKEN)).status).toBe(404);
  });

  it("works through its last day and not after", async () => {
    await madeCase(1);
    await testEnv.DB.prepare("UPDATE cases SET until = ?").bind(TODAY).run();
    expect((await send(`cases/${ID}`, TOKEN)).status).toBe(200);
    await testEnv.DB.prepare("UPDATE cases SET until = ?")
      .bind(TODAY - 1)
      .run();
    expect((await send(`cases/${ID}`, TOKEN)).status).toBe(404);
  });

  it("notes each opening by which link it was, and counts no reader", async () => {
    await madeCase(1);
    await send(`cases/${ID}`, TOKEN);
    expect(await openings()).toEqual([{ doc: ID, reason: `case ${(await tokenHash(TOKEN)).slice(0, 8)}` }]);
    expect((await docRow())?.read_total).toBe(0);
  });

  it("forgets the link in the sweep once it is past", async () => {
    await madeCase(1);
    await store.sweep(TODAY + 30);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM cases").first<{ n: number }>())?.n).toBe(1);
    await store.sweep(TODAY + 31);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM cases").first<{ n: number }>())?.n).toBe(0);
  });

  it("hands over the sealed records, and answers none when the link has none", async () => {
    await madeCase(1, SEALED);
    const response = await send(`cases/${ID}/records`, TOKEN);
    expect(await response.json()).toEqual({ sealed: SEALED });
    expect((await send(`cases/${ID}/records`)).status).toBe(404);
    await testEnv.DB.prepare("UPDATE cases SET sealed_records = NULL").run();
    expect((await send(`cases/${ID}/records`, TOKEN)).status).toBe(404);
  });

  it("serves the files of that version alone", async () => {
    await store.keepFiles({ id: ID, hash: FILES, body: new TextEncoder().encode("the files"), net: "n" }, TODAY);
    await testEnv.DB.prepare("UPDATE docs SET versions = json_set(versions, '$[0].files', ?) WHERE id = ?")
      .bind(FILES, ID)
      .run();
    await madeCase(1);
    expect(await (await send(`cases/${ID}/files/${FILES}`, TOKEN)).text()).toBe("the files");
    await store.keepFiles({ id: ID, hash: "G".repeat(43), body: new TextEncoder().encode("others"), net: "n" }, TODAY);
    expect((await send(`cases/${ID}/files/${"G".repeat(43)}`, TOKEN)).status).toBe(404);
    expect((await send(`cases/${ID}/files/${FILES}`)).status).toBe(404);
  });

  it("answers nothing on a path it does not know", async () => {
    expect((await send("cases/short", TOKEN)).status).toBe(404);
    expect((await send(`cases/${ID}/else`, TOKEN)).status).toBe(404);
  });
});
