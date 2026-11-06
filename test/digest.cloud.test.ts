import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMail } from "../src/cloudflare/mail";
import { Cloud } from "../src/cloudflare/store";
import { sendDigest } from "../src/core/digest";
import { dayOf } from "../src/core/limits";
import { hourOf } from "../src/core/start";
import worker from "../src/private/index";

vi.mock("../src/cloudflare/mail", () => ({ sendMail: vi.fn() }));

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const store = new Cloud(testEnv);
const NOW = Date.UTC(2026, 10, 20, 12);
const LATER = NOW + 12 * 3_600_000;
const TODAY = dayOf(NOW);
const HOUR = hourOf(NOW);
const ID = "k7Qm2xPa";
const OTHER = "wordsOnl";

const share = (id: string) => store.create({ id, owner: "o1", adminHash: "a", ttlDays: 3, net: "n" }, TODAY - 5);
const report = (doc: string, net: string, category: string, hour = HOUR - 1) =>
  store.report({ doc, net, asn: 1, category }, TODAY, hour);

const mailbox = () => vi.fn(async (_subject: string, _text: string) => {});
const digest = (now = NOW, send = mailbox()) => sendDigest(now, { store, send }).then((sent) => ({ sent, send }));

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["docs", "reports", "holds", "service_stage"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await share(ID);
  await share(OTHER);
});

describe("the mail", () => {
  it("does not go when there is nothing to tell, and writes nothing", async () => {
    const { sent, send } = await digest();
    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect((await store.digested()).hour).toBe(0);
  });

  it("tells of each document and how many networks reported it", async () => {
    await report(ID, "n1", "phishing");
    await report(ID, "n2", "phishing");
    await report(OTHER, "n3", "malware");
    const { send } = await digest();
    const [subject, text] = send.mock.calls[0] as [string, string];
    expect(subject).toBe("Folio: resumen");
    expect(text).toContain(`phishing: ${ID}, 2 redes`);
    expect(text).toContain(`malware: ${OTHER}, 1 red`);
  });

  it("puts CSAM first, and says so in the subject", async () => {
    await report(ID, "n1", "phishing");
    await report(ID, "n2", "phishing");
    await report(OTHER, "n3", "csam");
    const { send } = await digest();
    const [subject, text] = send.mock.calls[0] as [string, string];
    expect(subject).toBe("Folio: resumen, con CSAM");
    expect(text.indexOf("csam")).toBeLessThan(text.indexOf("phishing"));
  });

  it("tells once, and the next mail only of what came after", async () => {
    await report(ID, "n1", "csam");
    expect((await digest()).sent).toBe(true);
    expect((await digest()).sent).toBe(false);

    await report(OTHER, "n2", "csam", HOUR + 3);
    const { send } = await digest(LATER);
    const text = send.mock.calls[0]?.[1] as string;
    expect(text).toContain(OTHER);
    expect(text).not.toContain(ID);
  });

  it("tells it all the next time when the mail fails", async () => {
    await report(ID, "n1", "csam");
    const failing = vi.fn(async () => {
      throw new Error("no mail");
    });
    await expect(sendDigest(NOW, { store, send: failing })).rejects.toThrow("no mail");
    const { send } = await digest(LATER);
    expect(send.mock.calls[0]?.[1]).toContain(ID);
  });

  it("does not tell of light reports, which nobody has to look at", async () => {
    await report(ID, "n1", "spam");
    await report(ID, "n2", "offensive");
    expect((await digest()).sent).toBe(false);
  });

  it("does not tell of reports an accepted appeal cleared", async () => {
    await report(ID, "n1", "phishing");
    await testEnv.DB.prepare("UPDATE reports SET cleared = 1").run();
    expect((await digest()).sent).toBe(false);
  });

  it("tells of a block when three networks made it, and of an appeal", async () => {
    await store.report({ doc: ID, net: "n1", asn: 1, category: "phishing" }, TODAY, HOUR - 1);
    await store.report({ doc: ID, net: "n2", asn: 2, category: "phishing" }, TODAY, HOUR - 1);
    await store.report({ doc: ID, net: "n3", asn: 3, category: "phishing" }, TODAY, HOUR - 1);
    await store.appeal(ID, TODAY, HOUR - 1);
    const { send } = await digest();
    const text = send.mock.calls[0]?.[1] as string;
    expect(text).toContain(`Bloqueados:\n${ID}`);
    expect(text).toContain(`Reclamos:\n${ID}`);
  });

  it("tells of the spending stage only when it changed", async () => {
    await store.setStage("blocked");
    const { send } = await digest();
    expect(send.mock.calls[0]?.[1]).toContain("Gasto: blocked (antes: open)");
    expect((await digest()).sent).toBe(false);
    expect(await store.stage()).toBe("blocked");
  });

  it("ends with the link to the panel when there is one", async () => {
    await report(ID, "n1", "csam");
    const send = mailbox();
    await sendDigest(NOW, { store, send, panel: "https://panel.example" });
    expect(send.mock.calls[0]?.[1]).toMatch(/Panel: https:\/\/panel\.example$/);
  });

  it("never holds the words of a document or who reported it", async () => {
    await store.report(
      { doc: ID, net: "a-network", asn: 1, category: "csam", detail: "palabras", sealedLink: "llave" },
      TODAY,
      HOUR - 1,
    );
    const { send } = await digest();
    const text = send.mock.calls[0]?.[1] as string;
    for (const hidden of ["a-network", "palabras", "llave"]) expect(text).not.toContain(hidden);
  });

  it("says when it could not fit them all", async () => {
    const rows = Array.from({ length: 60 }, (_, at) => `('doc${at}', 'net', ${TODAY}, ${HOUR - 1}, 'phishing', 1)`);
    await testEnv.DB.prepare(`INSERT INTO reports (doc, net, at, at_hour, category, asn) VALUES ${rows.join()}`).run();
    const { send } = await digest();
    expect(send.mock.calls[0]?.[1]).toContain("(hay más)");
  });
});

describe("the round", () => {
  const scheduled = (more: object) =>
    worker.scheduled(
      { cron: "0 0,12 * * *", scheduledTime: NOW, noRetry: () => {} } as never,
      { ...testEnv, ...more } as never,
    );

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sendMail).mockReset();
  });

  it("sends the mail with the panel's link, and the heartbeat says it went", async () => {
    await report(ID, "n1", "csam");
    const beat = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    vi.mocked(sendMail).mockResolvedValueOnce();
    await scheduled({ ADMIN_URL: "https://panel.example", DIGEST_HEARTBEAT_URL: "https://beat.example/d" });
    expect(vi.mocked(sendMail).mock.calls[0]?.[2]).toContain("Panel: https://panel.example");
    expect(beat).toHaveBeenCalledExactlyOnceWith("https://beat.example/d");
  });

  it("sends no heartbeat when the mail fails, and that is the alert", async () => {
    await report(ID, "n1", "csam");
    const beat = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    vi.mocked(sendMail).mockRejectedValueOnce(new Error("no mail"));
    await expect(scheduled({ DIGEST_HEARTBEAT_URL: "https://beat.example/d" })).rejects.toThrow("no mail");
    expect(beat).not.toHaveBeenCalled();
  });
});
