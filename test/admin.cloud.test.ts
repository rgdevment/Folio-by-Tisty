import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AccessSettings, type Certs, isOperator, issuerOf } from "../src/admin/access";
import { answer } from "../src/admin/api";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import { dayOf } from "../src/core/limits";
import { toBase64Url } from "../src/core/start";
import type { Held } from "../src/core/store";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const NOW = Date.UTC(2026, 10, 6, 12);
const TODAY = dayOf(NOW);
const HOUR = Math.floor(NOW / 3_600_000);
const ID = "AbCdEfGh";
const ACCESS: AccessSettings = { team: "rina", audience: "the-panel", email: "mario@example.test" };
const store = new Cloud(testEnv);
const moderation = new CloudModeration(testEnv.DB);

let keys: CryptoKeyPair;
let certs: Certs;
let otherKeys: CryptoKeyPair;

const b64 = (said: unknown): string => toBase64Url(new TextEncoder().encode(JSON.stringify(said)));

const tokenBy = async (signer: CryptoKey, over: Record<string, unknown> = {}, header: object = {}): Promise<string> => {
  const body = `${b64({ alg: "RS256", kid: "one", ...header })}.${b64({
    iss: issuerOf(ACCESS.team),
    aud: [ACCESS.audience],
    email: ACCESS.email,
    exp: NOW / 1000 + 60,
    ...over,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(body));
  return `${body}.${toBase64Url(signature)}`;
};

const asked = async (path: string, init: RequestInit = {}, token?: string) => {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", token ?? (await tokenBy(keys.privateKey)));
  return answer(new Request(`https://panel.test${path}`, { ...init, headers }), {
    moderation,
    access: ACCESS,
    certs,
    now: NOW,
  });
};

const acting = (path: string, note?: string) =>
  asked(path, {
    method: "POST",
    headers: { "Folio-Operator": "1" },
    ...(note === undefined ? {} : { body: JSON.stringify({ note }) }),
  });

const share = async (signer = "o1") => {
  await store.create({ id: ID, owner: "o1", adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
  await store.upload(
    {
      id: ID,
      n: 1,
      hash: "h1",
      body: "sealed",
      net: "n",
      at: NOW,
      signer,
      machine: "m1",
      contract: "1.5.0",
      byOwner: signer === "o1",
      permit: null,
      ownerMark: "m1.t",
    },
    TODAY,
  );
};

const reported = async (category = "phishing", nets = ["n1", "n2", "n3"], sealedLink?: string) => {
  for (const [at, net] of nets.entries()) {
    await store.report(
      { doc: ID, net, asn: at + 1, category, version: 1, ...(sealedLink ? { sealedLink } : {}) },
      TODAY,
      HOUR,
    );
  }
};

const row = () =>
  testEnv.DB.prepare("SELECT blocked_at, appealed_at, appealed_hour FROM docs WHERE id = ?")
    .bind(ID)
    .first<{ blocked_at: number | null; appealed_at: number | null; appealed_hour: number | null }>();

const logged = async () =>
  (
    await testEnv.DB.prepare("SELECT action, note FROM moderation ORDER BY action").all<{
      action: string;
      note: string;
    }>()
  ).results;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const generate = () =>
    crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;
  keys = await generate();
  otherKeys = await generate();
  const cert = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  certs = async () => [{ ...cert, kid: "one" } as JsonWebKey];
});

beforeEach(async () => {
  for (const table of [
    "docs",
    "cases",
    "reports",
    "false_reporters",
    "moderation",
    "openings",
    "net_day",
    "net_hour",
    "service_stage",
  ]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("who may enter", () => {
  const holds = (token: string | null, access = ACCESS, now = NOW) => isOperator(token, access, certs, now);

  it("takes the operator's token, signed by Access", async () => {
    expect(await holds(await tokenBy(keys.privateKey))).toBe(true);
  });

  it.each([
    ["another address", { email: "ana@example.test" }],
    ["another audience", { aud: ["another"] }],
    ["another issuer", { iss: "https://another.cloudflareaccess.com" }],
    ["one that expired", { exp: NOW / 1000 - 1 }],
    ["one not valid yet", { nbf: NOW / 1000 + 60 }],
    ["no end", { exp: undefined }],
  ])("refuses %s", async (_said, over) => {
    expect(await holds(await tokenBy(keys.privateKey, over))).toBe(false);
  });

  it("refuses a token signed by another key, under the same name", async () => {
    expect(await holds(await tokenBy(otherKeys.privateKey))).toBe(false);
  });

  it("refuses a token with no signature that says it needs none", async () => {
    const token = await tokenBy(keys.privateKey, {}, { alg: "none" });
    expect(await holds(token)).toBe(false);
    expect(await holds(`${token.split(".").slice(0, 2).join(".")}.`)).toBe(false);
  });

  it("refuses everyone when it is not configured", async () => {
    const token = await tokenBy(keys.privateKey);
    expect(await holds(token, { ...ACCESS, email: "" })).toBe(false);
    expect(await holds(token, { ...ACCESS, audience: "" })).toBe(false);
    expect(await holds(token, { ...ACCESS, team: "" })).toBe(false);
  });

  it("refuses no token, and what is not one", async () => {
    expect(await holds(null)).toBe(false);
    expect(await holds("not.a.token")).toBe(false);
  });

  it("does not answer without a token, whatever is asked", async () => {
    await share();
    const response = await answer(new Request("https://panel.test/api/queue"), {
      moderation,
      access: ACCESS,
      certs,
      now: NOW,
    });
    expect(response.status).toBe(403);
    const acted = await answer(
      new Request(`https://panel.test/api/docs/${ID}/block`, {
        method: "POST",
        headers: { "Folio-Operator": "1" },
        body: JSON.stringify({ note: "x" }),
      }),
      { moderation, access: ACCESS, certs, now: NOW },
    );
    expect(acted.status).toBe(403);
    expect((await row())?.blocked_at).toBeNull();
  });

  it("refuses an action sent from a form or a link, even with the operator's session", async () => {
    await share();
    const response = await asked(`/api/docs/${ID}/block`, { method: "POST", body: JSON.stringify({ note: "x" }) });
    expect(response.status).toBe(403);
    expect((await row())?.blocked_at).toBeNull();
  });
});

describe("what it shows", () => {
  it("shows reports, gravest first, blocks and who signed, and no light report", async () => {
    await share("someone else");
    await reported("spam", ["l1"]);
    await reported("phishing", ["n1"]);
    await reported("csam", ["n2"], "sealed1.opaque");
    const response = await asked("/api/queue");
    const queue = (await response.json()) as Awaited<ReturnType<CloudModeration["queue"]>>;
    expect(queue.reports.map((one) => one.category)).toEqual(["csam", "phishing"]);
    expect(queue.reports[0]?.sealedLink).toBe("sealed1.opaque");
    expect(queue.reports[0]?.sealedContact).toBeNull();
    await store.report(
      { doc: ID, net: "n4", asn: 9, category: "csam", version: 1, sealedContact: "contact1.mail" },
      TODAY,
      HOUR,
    );
    const again = await new CloudModeration(testEnv.DB).queue(NOW);
    expect(again.reports.map((one) => one.sealedContact)).toContain("contact1.mail");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps showing what a network marked false reports, marked, while it stops counting", async () => {
    await share();
    await reported("phishing", ["n1"]);
    await store.create({ id: "OtherDoc", owner: "o2", adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
    await store.report({ doc: "OtherDoc", net: "n1", asn: 1, category: "csam", version: 1 }, TODAY, HOUR);
    await store.report({ doc: "OtherDoc", net: "n2", asn: 2, category: "malware", version: 1 }, TODAY, HOUR);
    expect((await acting(`/api/docs/${ID}/reports/n1/false`)).status).toBe(200);
    const { reports, reportsTotal } = await moderation.queue(NOW);
    expect(reportsTotal).toBe(2);
    expect(reports.map(({ doc, category, fromFalseNet }) => [doc, category, fromFalseNet])).toEqual([
      ["OtherDoc", "csam", true],
      ["OtherDoc", "malware", false],
    ]);
  });

  it("shows the newest of the same weight first, and says when some did not fit", async () => {
    const rows = Array.from({ length: 200 }, (_, at) =>
      testEnv.DB.prepare(
        "INSERT INTO reports (doc, net, at, at_hour, category, asn, level, version) VALUES ('AaOldDoc', ?, ?, 0, 'phishing', 1, 'medium', 1)",
      ).bind(`old${at}`, TODAY - 10),
    );
    await testEnv.DB.batch(rows);
    await store.create({ id: "ZzNewDoc", owner: "o2", adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
    await store.report({ doc: "ZzNewDoc", net: "fresh", asn: 1, category: "phishing", version: 1 }, TODAY, HOUR);
    const { reports, reportsTotal } = await moderation.queue(NOW);
    expect(reports).toHaveLength(200);
    expect(reports[0]?.doc).toBe("ZzNewDoc");
    expect(reportsTotal).toBe(201);
  });

  it.each([
    ["2", 2],
    ["0", 0],
    ["-1", 0],
    ["1.5", 0],
    ["many", 0],
  ])("reads the page of reports from %s", async (said, from) => {
    const response = await asked(`/api/queue?from=${said}`);
    expect(((await response.json()) as { reportsFrom: number }).reportsFrom).toBe(from);
  });

  it("puts what waits for the operator apart, and says who signed each version", async () => {
    await share("someone else");
    await reported();
    await store.appeal(ID, TODAY, HOUR);
    const accepted = await moderation.queue(NOW);
    expect(accepted.docs[0]).toMatchObject({ waitsForOperator: false, mayCorrect: true });
    expect(accepted.docs[0]?.signers).toEqual([{ n: 1, byOwner: false }]);
  });

  it("says how many keys are new today", async () => {
    await testEnv.DB.prepare("INSERT INTO net_day (day, net, docs, bytes, keys) VALUES (?, 'n', 0, 0, 4)")
      .bind(TODAY)
      .run();
    expect((await moderation.queue(NOW)).newKeys).toBe(4);
  });
});

describe("a block the operator placed", () => {
  const ownerSends = (known?: Held) =>
    store.upload(
      {
        id: ID,
        n: 2,
        hash: "h2",
        body: "same content",
        net: "n",
        at: NOW,
        signer: "o1",
        machine: "m1",
        contract: "1.5.0",
        byOwner: true,
        permit: null,
        ownerMark: "m1.t",
      },
      TODAY,
      known,
    );

  it("is not accepted alone, whoever signed what is reported, and no version lifts it", async () => {
    await share("someone else");
    expect((await acting(`/api/docs/${ID}/block`, "phishing confirmado")).status).toBe(200);
    await reported("phishing", ["n1"]);
    expect(await store.appeal(ID, TODAY, HOUR)).toBe("review");
    expect((await store.held(ID))?.correctable).toBe(false);
    expect(await ownerSends()).toBe("blocked");
    expect((await row())?.blocked_at).toBe(TODAY);
    const [waiting] = (await moderation.queue(NOW)).docs;
    expect(waiting).toMatchObject({ waitsForOperator: true, mayCorrect: false });
  });

  it("takes over a block from reports, even one whose appeal was already accepted alone", async () => {
    await share("someone else");
    await reported();
    expect(await store.appeal(ID, TODAY, HOUR)).toBe("accepted");
    expect((await store.held(ID))?.correctable).toBe(true);
    expect((await acting(`/api/docs/${ID}/block`, "lo revisé")).status).toBe(200);
    expect((await store.held(ID))?.correctable).toBe(false);
    expect((await store.owned(ID, TODAY))?.status.mayCorrect).toBe(false);
    expect((await moderation.queue(NOW)).docs[0]?.mayCorrect).toBe(false);
    expect(await ownerSends()).toBe("blocked");
    expect((await row())?.blocked_at).toBe(TODAY);
  });

  it("stops a version already on its way when the operator decides", async () => {
    await share("someone else");
    await reported();
    await store.appeal(ID, TODAY, HOUR);
    const before = await store.held(ID);
    await acting(`/api/docs/${ID}/block`, "lo revisé");
    await ownerSends(before ?? undefined);
    expect((await row())?.blocked_at).toBe(TODAY);
    expect((await store.held(ID))?.latest).toBe(1);
  });

  it("is placed once, and logged once", async () => {
    await share();
    expect((await acting(`/api/docs/${ID}/block`, "una")).status).toBe(200);
    expect((await acting(`/api/docs/${ID}/block`, "otra")).status).toBe(404);
    expect(await logged()).toEqual([{ action: "block", note: "una" }]);
  });

  it("is lifted by the operator, and later blocks go by the usual rule", async () => {
    await share("someone else");
    await acting(`/api/docs/${ID}/block`, "phishing confirmado");
    expect((await acting(`/api/docs/${ID}/accept`)).status).toBe(200);
    expect((await row())?.blocked_at).toBeNull();
    await reported();
    expect((await row())?.blocked_at).toBe(TODAY);
    expect(await store.appeal(ID, TODAY, HOUR)).toBe("accepted");
  });
});

describe("what it can do", () => {
  it("lists a warning by light reports, and removes it with its reports", async () => {
    await share();
    await testEnv.DB.prepare("UPDATE docs SET fix_by = ? WHERE id = ?")
      .bind(TODAY + 3, ID)
      .run();
    await reported("spam", ["n1", "n2"]);
    const before = await moderation.queue(NOW);
    expect(before.warned).toEqual([{ id: ID, fixBy: TODAY + 3, nets: 2 }]);
    expect((await asked(`/api/docs/${ID}/clear_warning`, { method: "POST" })).status).toBe(403);
    expect((await acting(`/api/docs/${ID}/clear_warning`)).status).toBe(200);
    expect((await moderation.queue(NOW)).warned).toEqual([]);
    const left = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE cleared = 0").first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(await logged()).toEqual([{ action: "clear_warning", note: null }]);
    expect((await acting(`/api/docs/${ID}/clear_warning`)).status).toBe(404);
  });

  it("keeps other reports when a warning is removed, and lists no blocked document as warned", async () => {
    await share();
    await testEnv.DB.prepare("UPDATE docs SET fix_by = ? WHERE id = ?")
      .bind(TODAY + 3, ID)
      .run();
    await reported("phishing", ["n1"]);
    await acting(`/api/docs/${ID}/clear_warning`);
    const left = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE cleared = 0").first<{ n: number }>();
    expect(left?.n).toBe(1);
    await testEnv.DB.prepare("UPDATE docs SET fix_by = ?, blocked_at = ? WHERE id = ?")
      .bind(TODAY + 3, TODAY, ID)
      .run();
    expect((await moderation.queue(NOW)).warned).toEqual([]);
  });

  it("discards all of a network's reports only for the operator", async () => {
    await share();
    await reported("phishing", ["n1"]);
    await store.create({ id: "OtherDoc", owner: "o2", adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
    await store.report({ doc: "OtherDoc", net: "n1", asn: 1, category: "phishing", version: 1 }, TODAY, HOUR);
    expect((await asked(`/api/docs/${ID}/reports/n1/false_network`, { method: "POST" })).status).toBe(403);
    expect((await acting(`/api/docs/${ID}/reports/n1/false_network`)).status).toBe(200);
    expect((await moderation.queue(NOW)).reportsTotal).toBe(0);
    expect((await acting(`/api/docs/${ID}/reports/n1/false_network`)).status).toBe(404);
  });

  it("erases a reporter's email when asked, that one alone, and says so on record", async () => {
    await share();
    for (const net of ["n1", "n2"]) {
      await store.report(
        { doc: ID, net, asn: 1, category: "phishing", version: 1, sealedContact: "contact1.mail" },
        TODAY,
        HOUR,
      );
    }
    expect((await acting(`/api/docs/${ID}/reports/n1/forget_contact`)).status).toBe(200);
    const left = await testEnv.DB.prepare("SELECT net, sealed_contact FROM reports ORDER BY net").all();
    expect(left.results).toEqual([
      { net: "n1", sealed_contact: null },
      { net: "n2", sealed_contact: "contact1.mail" },
    ]);
    expect((await acting(`/api/docs/${ID}/reports/n1/forget_contact`)).status).toBe(404);
    expect(await logged()).toEqual([{ action: "forget_contact", note: null }]);
    expect((await asked(`/api/docs/${ID}/reports/n2/forget_contact`, { method: "POST" })).status).toBe(403);
  });

  describe("a case", () => {
    const HASH = "H".repeat(43);
    const sendingCase = (id: string, body: unknown) =>
      asked(`/api/docs/${id}/case`, {
        method: "POST",
        headers: { "Folio-Operator": "1" },
        body: JSON.stringify(body),
      });

    it("panics with its reason, and answers the records", async () => {
      await share();
      const response = await acting(`/api/docs/${ID}/panic`, "looks real");
      expect(response.status).toBe(200);
      expect(((await response.json()) as { records: { id: string } }).records.id).toBe(ID);
      expect((await row())?.blocked_at).toBe(TODAY);
    });

    it("will not panic without a reason, or over what does not exist", async () => {
      await share();
      expect((await acting(`/api/docs/${ID}/panic`)).status).toBe(400);
      expect((await row())?.blocked_at).toBeNull();
      expect((await acting("/api/docs/Nothing1/panic", "looks real")).status).toBe(404);
    });

    it("takes a case and says when the version is not there", async () => {
      await share();
      expect((await sendingCase(ID, { version: 1, tokenHash: HASH, sealedRecords: "case1.abc" })).status).toBe(200);
      expect((await sendingCase(ID, { version: 9, tokenHash: "J".repeat(43) })).status).toBe(404);
    });

    it.each([
      ["no version", { tokenHash: HASH }],
      ["version zero", { version: 0, tokenHash: HASH }],
      ["a broken version", { version: 1.5, tokenHash: HASH }],
      ["no hash", { version: 1 }],
      ["a short hash", { version: 1, tokenHash: "short" }],
      ["records in the clear", { version: 1, tokenHash: HASH, sealedRecords: '{"reports":[]}' }],
    ])("refuses a case with %s", async (_, body) => {
      await share();
      expect((await sendingCase(ID, body)).status).toBe(400);
    });

    it("hands over only for the operator, and answers what it did", async () => {
      await share();
      await reported("csam", ["n1"], "sealed1.x");
      await acting(`/api/docs/${ID}/panic`, "looks real");
      await sendingCase(ID, { version: 1, tokenHash: HASH, sealedRecords: "case1.abc" });
      expect((await asked(`/api/docs/${ID}/handed_over`, { method: "POST" })).status).toBe(403);
      expect((await acting(`/api/docs/${ID}/handed_over`)).status).toBe(200);
      expect((await acting(`/api/docs/${ID}/handed_over`)).status).toBe(404);
    });
  });

  it("accepts an appeal: lifts the block, and punishes no network for reporting", async () => {
    await share();
    await reported();
    await store.appeal(ID, TODAY, HOUR);
    expect((await acting(`/api/docs/${ID}/accept`)).status).toBe(200);
    expect((await row())?.blocked_at).toBeNull();
    const counted = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM false_reporters").first<{ n: number }>();
    expect(counted?.n).toBe(0);
    expect(await logged()).toEqual([{ action: "accept", note: null }]);
  });

  it("rejects an appeal: the block stands, it leaves the queue, and it cannot be sent again", async () => {
    await share();
    await reported();
    await store.appeal(ID, TODAY, HOUR);
    expect((await acting(`/api/docs/${ID}/reject`)).status).toBe(200);
    const after = await row();
    expect(after?.blocked_at).not.toBeNull();
    expect(after?.appealed_at).not.toBeNull();
    expect(after?.appealed_hour).toBeNull();
    expect((await acting(`/api/docs/${ID}/reject`)).status).toBe(404);
  });

  it("blocks with a reason, and not without one", async () => {
    await share();
    expect((await acting(`/api/docs/${ID}/block`)).status).toBe(400);
    expect((await acting(`/api/docs/${ID}/block`, "   ")).status).toBe(400);
    expect((await row())?.blocked_at).toBeNull();
    expect((await acting(`/api/docs/${ID}/block`, "phishing confirmado")).status).toBe(200);
    expect((await row())?.blocked_at).toBe(TODAY);
    expect(await logged()).toEqual([{ action: "block", note: "phishing confirmado" }]);
  });

  it("marks one report false, without touching the others", async () => {
    await share();
    await reported("phishing", ["n1", "n2"]);
    expect((await acting(`/api/docs/${ID}/reports/n1/false`)).status).toBe(200);
    const left = await testEnv.DB.prepare("SELECT net FROM reports WHERE cleared = 0").all<{ net: string }>();
    expect(left.results.map((one) => one.net)).toEqual(["n2"]);
    const named = await testEnv.DB.prepare("SELECT net FROM false_reporters").all<{ net: string }>();
    expect(named.results.map((one) => one.net)).toEqual(["n1"]);
    expect((await acting(`/api/docs/${ID}/reports/n1/false`)).status).toBe(404);
  });

  it("logs an opening with its reason, and not without one", async () => {
    await share();
    expect((await acting(`/api/docs/${ID}/opened`)).status).toBe(400);
    expect((await acting(`/api/docs/${ID}/opened`, "denuncia grave")).status).toBe(200);
    const opened = await testEnv.DB.prepare("SELECT doc, reason FROM openings").first();
    expect(opened).toEqual({ doc: ID, reason: "denuncia grave" });
  });

  it("answers missing for what is not there or not blocked, and writes nothing", async () => {
    await share();
    expect((await acting("/api/docs/NoSuchId/accept")).status).toBe(404);
    expect((await acting(`/api/docs/${ID}/accept`)).status).toBe(404);
    expect((await acting(`/api/docs/${ID}/nothing`)).status).toBe(404);
    expect(await logged()).toEqual([]);
  });

  const openings = async () =>
    (await testEnv.DB.prepare("SELECT doc FROM openings").all<{ doc: string }>()).results.map((one) => one.doc);

  it("forgets what it logged and the openings once their days pass, with the daily sweep", async () => {
    await share();
    await acting(`/api/docs/${ID}/block`, "x");
    await acting(`/api/docs/${ID}/opened`, "y");
    await store.sweep(TODAY + 180);
    expect(await logged()).toHaveLength(1);
    expect(await openings()).toEqual([ID]);
    await store.sweep(TODAY + 181);
    expect(await logged()).toEqual([]);
    expect(await openings()).toEqual([]);
  });

  it("keeps them while an order holds the document", async () => {
    await share();
    await acting(`/api/docs/${ID}/block`, "x");
    await acting(`/api/docs/${ID}/opened`, "y");
    await testEnv.DB.prepare("UPDATE docs SET legal_until = ? WHERE id = ?")
      .bind(TODAY + 400, ID)
      .run();
    await store.sweep(TODAY + 181);
    expect(await logged()).toHaveLength(1);
    expect(await openings()).toEqual([ID]);
  });

  it("writes no log for an action that changed nothing, and renews no network", async () => {
    await share();
    await reported("phishing", ["n1"]);
    await testEnv.DB.prepare("UPDATE reports SET cleared = 1").run();
    expect((await acting(`/api/docs/${ID}/reports/n1/false`)).status).toBe(404);
    const named = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM false_reporters").first<{ n: number }>();
    expect(named?.n).toBe(0);
    expect(await logged()).toEqual([]);
  });

  it("does not stand without its log, nor the log without it", async () => {
    await share();
    const failing = vi.spyOn(testEnv.DB, "batch").mockRejectedValueOnce(new Error("no database today"));
    await expect(moderation.block(ID, "x", NOW)).rejects.toThrow();
    failing.mockRestore();
    expect((await row())?.blocked_at).toBeNull();
    expect(await logged()).toEqual([]);
    expect(await moderation.block(ID, "x", NOW)).toBe("done");
    expect(await logged()).toEqual([{ action: "block", note: "x" }]);
  });
});
