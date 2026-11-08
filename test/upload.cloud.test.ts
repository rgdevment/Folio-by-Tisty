import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import { administer } from "../src/core/admin";
import type { Bytes } from "../src/core/bytes";
import { DAY_MS, dayOf, LEVEL_ONE, type Limits } from "../src/core/limits";
import { latestVersion, readDoc, readFiles } from "../src/core/read";
import { takeRevocations } from "../src/core/revocations";
import { saltFor, solveProof, startNow, toBase64Url, tokenHash } from "../src/core/start";
import type { Stage, Version } from "../src/core/store";
import {
  type FirstUpload,
  filesEnvelopeBytesAtMost,
  type UploadTools,
  uploadDoc,
  uploadFiles,
} from "../src/core/upload";
import { keptVersions, listFreesAt, uploadAllowedAt } from "../src/core/versions";
import {
  filesHashOf,
  machineOf,
  newPerson,
  newToken,
  type Person,
  revocationBy,
  rootOf,
  sealedEnvelope,
  TERMS_ACCEPTED,
} from "./sealed";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const SECRET = "a secret of the server";
const NOW = Date.UTC(2026, 10, 20, 12);
const LIMITS: Limits = { ...LEVEL_ONE, proofBits: 2 };
const store = new Cloud(testEnv, LIMITS);
const tools = {
  store,
  limits: LIMITS,
  secret: SECRET,
  sharingOpen: true,
  termsVersion: TERMS_ACCEPTED,
  limiter: { allows: async () => true },
  syncLimiter: { allows: async () => true },
  dayKey: async () => "a key for the day",
};

let mario: Person;
let ana: Person;

// Each start names its own id, so a test takes it from the server and not the other way around.
const started = async (now = NOW): Promise<FirstUpload & { id: string }> => {
  const { id, mac } = await startNow(SECRET, now);
  const proof = await solveProof(await saltFor(SECRET, id, Math.floor(now / 3_600_000)), LIMITS.proofBits);
  return { id, start: mac, proof, adminToken: "the admin token", ttlDays: 3 };
};

const send = (id: string, bytes: Bytes, now = NOW, first?: FirstUpload) =>
  uploadDoc({ id, now, ip: "203.0.113.9", bytes: async () => bytes, ...(first ? { first } : {}) }, tools);

const shared = async (over: { permit?: string } = {}) => {
  const first = await started();
  const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario, ...over });
  expect(await send(first.id, bytes, NOW, first)).toEqual({ stored: true, version: 1 });
  return first.id;
};

const row = (id: string) =>
  testEnv.DB.prepare("SELECT owner, permit, latest, versions, owner_mark, paused_at FROM docs WHERE id = ?")
    .bind(id)
    .first<{ owner: string; permit: string | null; latest: number; versions: string; owner_mark: string }>();

const LATER = NOW + 2 * DAY_MS;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  mario = await newPerson();
  ana = await newPerson();
});

beforeEach(async () => {
  for (const table of ["docs", "keys", "net_day", "net_hour", "service_stage", "revocations", "editors", "reports"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("sharing something new", () => {
  it("keeps who owns it and when it arrived, with the time of the server", async () => {
    const id = await shared();
    const held = await row(id);
    expect(held?.owner).toBe(rootOf(mario));
    const [version] = JSON.parse(held?.versions ?? "[]") as Version[];
    expect(version).toMatchObject({ n: 1, at: NOW, signer: rootOf(mario), contract: expect.any(String) });
    expect(await testEnv.ENVELOPES.head(`${id}/1.${version?.hash}`)).not.toBeNull();
  });

  it("keeps who may edit, from what its owner signed", async () => {
    const { permit } = await newToken();
    expect((await row(await shared({ permit })))?.permit).toBe(permit);
  });

  it("takes the same bytes again as the same version", async () => {
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    await send(first.id, bytes, NOW, first);
    expect(await send(first.id, bytes, NOW + 1, first)).toEqual({ stored: true, version: 1 });
    expect((await row(first.id))?.latest).toBe(1);
  });

  it("asks for what the server gave, and for the proof", async () => {
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    expect(await send(first.id, bytes)).toEqual({ refused: "missing" });
    expect(await send(first.id, bytes, NOW, { ...first, start: "not what it gave" })).toEqual({
      refused: "bad_upload",
    });
    expect(await send(first.id, bytes, NOW, { ...first, adminToken: "" })).toEqual({ refused: "bad_upload" });
    expect(await send(first.id, bytes, NOW, { ...first, ttlDays: 2 })).toEqual({ refused: "bad_upload" });
    expect((await row(first.id))?.latest).toBeUndefined();
  });

  it("does not take a retry that brings another admin token, or the owner would lose the link", async () => {
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    await store.create(
      { id: first.id, owner: rootOf(mario), adminHash: await tokenHash("the admin token"), ttlDays: 3, net: "n" },
      dayOf(NOW),
    );
    expect(await send(first.id, bytes, NOW, { ...first, adminToken: "another one" })).toEqual({ refused: "not_yours" });
    expect((await row(first.id))?.latest).toBe(0);
    expect(await send(first.id, bytes, NOW, first)).toEqual({ stored: true, version: 1 });
  });

  it("asks for the proof before it keeps anything", async () => {
    const hard = { ...tools, limits: { ...LIMITS, proofBits: 24 } };
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    const answer = await uploadDoc(
      { id: first.id, now: NOW, ip: "203.0.113.9", bytes: async () => bytes, first },
      hard,
    );
    expect(answer).toMatchObject({ refused: "proof", bits: 24 });
    expect(await row(first.id)).toBeNull();
  });

  it("stops at the shares a person may keep", async () => {
    for (let at = 0; at < LIMITS.sharesAtMost; at += 1) await shared();
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    expect(await send(first.id, bytes, NOW, first)).toEqual({ refused: "shares_full" });
  });

  it("refuses what is sealed for another id, and what does not hold", async () => {
    const first = await started();
    const other = await sealedEnvelope({ id: "anotherO", version: 1, owner: mario });
    expect(await send(first.id, other, NOW, first)).toEqual({ refused: "envelope", why: "damaged" });
    const editor = await sealedEnvelope({ id: first.id, version: 1, owner: mario, signer: ana });
    expect(await send(first.id, editor, NOW, first)).toEqual({ refused: "envelope", why: "unsigned" });
  });
});

describe("who may send a new version", () => {
  it("is its owner, from any machine and under any name", async () => {
    const id = await shared();
    const otherName = new Uint8Array(32).fill(9);
    const next = await sealedEnvelope({ id, version: 2, owner: mario, nameTag: otherName });
    expect(await send(id, next, LATER)).toEqual({ stored: true, version: 2 });
    expect((await row(id))?.owner_mark).toContain(toBase64Url(otherName));
  });

  it("is nobody else, when its owner allowed no one", async () => {
    const id = await shared();
    const stolen = await sealedEnvelope({ id, version: 2, owner: ana });
    expect(await send(id, stolen, LATER)).toEqual({ refused: "not_yours" });
  });

  it("is who holds the token, under the block its owner signed", async () => {
    const { pair, permit } = await newToken();
    const id = await shared({ permit });
    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    expect(await send(id, edited, LATER)).toEqual({ stored: true, version: 2 });
    const [, second] = JSON.parse((await row(id))?.versions ?? "[]") as Version[];
    expect(second?.signer).toBe(rootOf(ana));
  });

  it("is not who holds a token its owner took back, or who brings an old block", async () => {
    const old = await newToken();
    const id = await shared({ permit: old.permit });
    const fresh = await newToken();
    await store.setPermit(id, fresh.permit);
    const edited = await sealedEnvelope({
      id,
      version: 2,
      owner: mario,
      signer: ana,
      permit: old.permit,
      token: old.pair,
    });
    expect(await send(id, edited, LATER)).toEqual({ refused: "not_yours" });
    expect((await row(id))?.permit).toBe(fresh.permit);
  });

  it("does not let an upload change who may edit", async () => {
    const id = await shared();
    const { permit } = await newToken();
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario, permit });
    expect(await send(id, bytes, LATER)).toEqual({ refused: "not_yours" });
    expect((await row(id))?.permit).toBeNull();
  });

  it("does not let an editor change the owner's name", async () => {
    const { pair, permit } = await newToken();
    const id = await shared({ permit });
    const bytes = await sealedEnvelope({
      id,
      version: 2,
      owner: mario,
      signer: ana,
      permit,
      token: pair,
      nameTag: new Uint8Array(32).fill(9),
    });
    expect(await send(id, bytes, LATER)).toEqual({ refused: "not_yours" });
  });
});

describe("the files a version names", () => {
  const sendFiles = (id: string, bytes: Bytes, now = LATER) =>
    uploadFiles({ id, now, ip: "203.0.113.9", bytes: async () => bytes }, tools);

  const sendNaming = (id: string, version: number, hash: string, now: number) =>
    sealedEnvelope({ id, version, owner: mario }).then((bytes) =>
      uploadDoc({ id, now, ip: "203.0.113.9", bytes: async () => bytes, files: hash }, tools),
    );

  const reading = (id: string, hash: string, now = LATER) => readFiles({ id, ip: "203.0.113.9", now, hash }, tools);

  const objects = async (id: string) =>
    (await testEnv.ENVELOPES.list({ prefix: `${id}/files.` })).objects.map((one) => one.key);

  const named = async (over: { size?: number } = {}) => {
    const id = await shared();
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario, files: [over.size ?? 16] });
    const hash = await filesHashOf(id, bytes);
    return { id, bytes, hash };
  };

  describe("near the ceiling", () => {
    const WAITED = NOW + 30 * DAY_MS;

    it("are taken when a version already kept names them, however new the key, or it would stay without them", async () => {
      const { id, bytes, hash } = await named();
      await sendNaming(id, 2, hash, LATER);
      await store.setStage("new_keys_off");
      expect(await sendFiles(id, bytes)).toEqual({ stored: true, hash });
    });

    it("are not taken when no version names them", async () => {
      const { id, bytes } = await named();
      await store.setStage("new_keys_off");
      expect(await sendFiles(id, bytes, WAITED)).toEqual({ refused: "behind" });
    });
  });

  it("takes them only after a version names them, and serves only those", async () => {
    const { id, bytes, hash } = await named();
    expect(await sendFiles(id, bytes)).toEqual({ refused: "behind" });
    expect(await objects(id)).toEqual([]);

    expect(await sendNaming(id, 2, hash, LATER)).toEqual({ stored: true, version: 2, filesWanted: true });
    expect(await reading(id, hash)).toEqual({ refused: "missing" });

    expect(await sendFiles(id, bytes)).toEqual({ stored: true, hash });
    const served = await reading(id, hash);
    expect(served).toMatchObject({ served: true });
    expect(new Uint8Array(await new Response((served as { body: ReadableStream }).body).arrayBuffer())).toEqual(bytes);
    expect(await reading(id, "A".repeat(43))).toEqual({ refused: "missing" });
  });

  it("takes them under older terms, since the version that names them answered for those", async () => {
    const id = await shared();
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario, files: [16], terms: "0" });
    const hash = await filesHashOf(id, bytes);
    await sendNaming(id, 2, hash, LATER);
    expect(await sendFiles(id, bytes)).toEqual({ stored: true, hash });
  });

  it("refuses a hash that cannot be one before it reads anything", async () => {
    const id = await shared();
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario });
    const said = await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => bytes, files: "no" }, tools);
    expect(said).toEqual({ refused: "bad_upload" });
  });

  it("takes many small files, since their weight is what counts", async () => {
    const id = await shared();
    const thirty = await sealedEnvelope({ id, version: 2, owner: mario, files: Array(30).fill(16) });
    const hash = await filesHashOf(id, thirty);
    await sendNaming(id, 2, hash, LATER);
    expect(await sendFiles(id, thirty)).toEqual({ stored: true, hash });
  });

  it("refuses more files, or more bytes, than a document may have", async () => {
    const id = await shared();
    const many = await sealedEnvelope({ id, version: 2, owner: mario, files: Array(LIMITS.filesAtMost + 1).fill(16) });
    expect(await sendFiles(id, many)).toEqual({ refused: "too_big" });
    const heavy = await sealedEnvelope({ id, version: 2, owner: mario, files: [LIMITS.filesBytesAtMost + 1] });
    expect(await sendFiles(id, heavy)).toEqual({ refused: "too_big" });
  });

  it("refuses a main envelope sent as files", async () => {
    const id = await shared();
    const main = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await sendFiles(id, main)).toEqual({ refused: "envelope", why: "damaged" });
  });

  it("takes them signed by whoever holds the permit", async () => {
    const { permit, pair } = await newToken();
    const id = await shared({ permit });
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair, files: [16] });
    const hash = await filesHashOf(id, bytes);
    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    const sent = await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => edited, files: hash }, tools);
    expect(sent).toEqual({ stored: true, version: 2, filesWanted: true });
    expect(await sendFiles(id, bytes)).toEqual({ stored: true, hash });
  });

  it("does not pay twice for the same bytes", async () => {
    const { id, bytes, hash } = await named();
    await sendNaming(id, 2, hash, LATER);
    await sendFiles(id, bytes);
    const quota = async () => [
      await testEnv.DB.prepare("SELECT SUM(bytes) AS bytes FROM net_day").first(),
      await testEnv.DB.prepare("SELECT SUM(n) AS n FROM net_hour").first(),
    ];
    const before = await quota();
    expect(await sendFiles(id, bytes)).toEqual({ stored: true, hash });
    expect(await quota()).toEqual(before);
  });

  it("keeps them while a version that stays names them, and lets them go with the last one", async () => {
    const { id, bytes, hash } = await named();
    await sendNaming(id, 2, hash, LATER);
    await sendFiles(id, bytes);
    const dayOfVersion = (version: number) => LATER + 30 * DAY_MS + (version - 3) * 8 * DAY_MS;
    const listed = async () => (JSON.parse((await row(id))?.versions ?? "[]") as Version[]).map((one) => one.n);

    for (const version of [3, 4, 5]) {
      expect(await sendNaming(id, version, hash, dayOfVersion(version))).toEqual({ stored: true, version });
    }
    expect(await listed()).not.toContain(2);
    expect(await objects(id)).toHaveLength(1);

    const without = await sealedEnvelope({ id, version: 6, owner: mario });
    await uploadDoc({ id, now: dayOfVersion(6), ip: "203.0.113.9", bytes: async () => without }, tools);
    expect(await listed()).toEqual([5, 6]);
    expect(await objects(id)).toHaveLength(1);

    const last = await sealedEnvelope({ id, version: 7, owner: mario });
    await uploadDoc({ id, now: dayOfVersion(7), ip: "203.0.113.9", bytes: async () => last }, tools);
    expect(await listed()).toEqual([6, 7]);
    expect(await objects(id)).toEqual([]);
  });

  it("tells the writer while the files a version names have not arrived, even if it only repeats them", async () => {
    const { id, bytes, hash } = await named();
    expect(await sendNaming(id, 2, hash, LATER)).toMatchObject({ filesWanted: true });
    expect(await sendNaming(id, 3, hash, LATER + 30 * DAY_MS)).toMatchObject({ filesWanted: true });
    await sendFiles(id, bytes, LATER + 30 * DAY_MS);
    expect(await sendNaming(id, 4, hash, LATER + 38 * DAY_MS)).toEqual({ stored: true, version: 4 });
  });

  it("asks again when the same version is sent again, so a writer that fell can go on", async () => {
    const { id, hash } = await named();
    const version = await sealedEnvelope({ id, version: 2, owner: mario });
    const send = () => uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => version, files: hash }, tools);
    expect(await send()).toMatchObject({ filesWanted: true });
    expect(await send()).toMatchObject({ filesWanted: true });
  });

  it("forgets them with the document", async () => {
    const { id, bytes, hash } = await named();
    await sendNaming(id, 2, hash, LATER);
    await sendFiles(id, bytes);
    await testEnv.DB.prepare("UPDATE docs SET dies_on = 0 WHERE id = ?").bind(id).run();
    await store.sweep(dayOf(LATER));
    expect(await objects(id)).toEqual([]);
  });
});

describe("a key Folio has not seen", () => {
  const sharedBy = async (who: Person, now = NOW) => {
    const first = await started(now);
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: who });
    return send(first.id, bytes, now, first);
  };
  const keys = async () =>
    (await testEnv.DB.prepare("SELECT root FROM keys").all<{ root: string }>()).results.map((one) => one.root);

  it("is kept the first time it shares, with the day it arrived", async () => {
    expect(await sharedBy(mario)).toEqual({ stored: true, version: 1 });
    const row = await testEnv.DB.prepare("SELECT first_day FROM keys WHERE root = ?")
      .bind(rootOf(mario))
      .first<{ first_day: number }>();
    expect(row?.first_day).toBe(dayOf(NOW));
  });

  it("takes five a day from one network, and the sixth waits for the next day and leaves no trace", async () => {
    for (let at = 0; at < 5; at += 1) expect(await sharedBy(await newPerson())).toEqual({ stored: true, version: 1 });
    const sixth = await newPerson();
    const until = (dayOf(NOW) + 1) * DAY_MS;
    expect(await sharedBy(sixth)).toEqual({ refused: "quota", until });
    expect(await keys()).not.toContain(rootOf(sixth));
    const docs = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM docs").first<{ n: number }>();
    expect(docs?.n).toBe(5);
  });

  it("keeps no key from a request that stores nothing, so none can age without a version", async () => {
    const fresh = await newPerson();
    const first = { ...(await started()), ttlDays: 99 };
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: fresh });
    expect(await send(first.id, bytes, NOW, first)).toEqual({ refused: "bad_upload" });
    expect(await keys()).not.toContain(rootOf(fresh));
  });

  it("keeps no key whose version did not fit in the day's bytes", async () => {
    const { permit, pair } = await newToken();
    const id = await shared({ permit });
    await testEnv.DB.prepare("UPDATE net_day SET bytes = ?").bind(LIMITS.netBytesADay).run();
    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    expect(await send(id, edited, NOW + 60_000)).toMatchObject({ refused: "quota" });
    expect(await keys()).not.toContain(rootOf(ana));
  });

  const keysSpent = async () =>
    (await testEnv.DB.prepare("SELECT COALESCE(SUM(keys), 0) AS n FROM net_day").first<{ n: number }>())?.n;

  it("spends none of the day's keys on a request refused after it was admitted, however often it retries", async () => {
    const fresh = await newPerson();
    const busy = { ...tools, limits: { ...LIMITS, uploadsAnHour: 0 } };
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: fresh });
    const retry = { id: first.id, now: NOW, ip: "203.0.113.9", bytes: async () => bytes, first };
    for (let at = 0; at < LIMITS.newKeysADay + 1; at += 1) {
      expect(await uploadDoc(retry, busy)).toMatchObject({ refused: "quota" });
    }
    expect(await keysSpent()).toBe(0);
    expect(await keys()).not.toContain(rootOf(fresh));
    expect(await send(first.id, bytes, NOW, first)).toEqual({ stored: true, version: 1 });
    expect(await keysSpent()).toBe(1);
  });

  it("gives back the owner's slot when the signer's does not fit", async () => {
    for (let at = 0; at < LIMITS.newKeysADay - 1; at += 1) await sharedBy(await newPerson());
    const { permit, pair } = await newToken();
    const first = await started();
    const bytes = await sealedEnvelope({
      id: first.id,
      version: 1,
      owner: await newPerson(),
      signer: await newPerson(),
      permit,
      token: pair,
    });
    expect(await send(first.id, bytes, NOW, first)).toMatchObject({ refused: "quota" });
    expect(await keysSpent()).toBe(LIMITS.newKeysADay - 1);
  });

  it("gives the slot back when the store fails", async () => {
    const fresh = await newPerson();
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: fresh });
    const put = vi.spyOn(testEnv.ENVELOPES, "put").mockRejectedValueOnce(new Error("no bucket today"));
    await expect(send(first.id, bytes, NOW, first)).rejects.toThrow();
    put.mockRestore();
    expect(await keysSpent()).toBe(0);
  });

  it("does not spend the day's keys on one it knows, however many times it shares", async () => {
    await sharedBy(mario);
    await sharedBy(mario);
    const row = await testEnv.DB.prepare("SELECT keys FROM net_day").first<{ keys: number }>();
    expect(row?.keys).toBe(1);
  });

  it("lets a key it knows go on past the day's five", async () => {
    await sharedBy(mario);
    for (let at = 0; at < 4; at += 1) await sharedBy(await newPerson());
    expect(await sharedBy(await newPerson())).toMatchObject({ refused: "quota" });
    expect(await sharedBy(mario)).toEqual({ stored: true, version: 1 });
  });

  it("takes five more the next day", async () => {
    for (let at = 0; at < 5; at += 1) await sharedBy(await newPerson());
    expect(await sharedBy(await newPerson(), NOW + DAY_MS)).toEqual({ stored: true, version: 1 });
  });

  it("counts whoever edits too, and not until their version is taken", async () => {
    const { permit, pair } = await newToken();
    const id = await shared({ permit });
    const stranger = await newPerson();
    const refused = await sealedEnvelope({ id, version: 2, owner: stranger });
    expect(await send(id, refused, LATER)).toEqual({ refused: "not_yours" });
    expect(await keys()).not.toContain(rootOf(stranger));

    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    expect(await send(id, edited, LATER)).toEqual({ stored: true, version: 2 });
    expect(await keys()).toContain(rootOf(ana));
  });

  it("counts both when a first version is not signed by its owner, so a known signer opens no way around", async () => {
    const { permit, pair } = await newToken();
    const fresh = await newPerson();
    await sharedBy(ana);
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: fresh, signer: ana, permit, token: pair });
    expect(await send(first.id, bytes, NOW, first)).toEqual({ stored: true, version: 1 });
    expect(await keys()).toContain(rootOf(fresh));
  });

  it("stays after its documents are forgotten", async () => {
    const id = await shared();
    await testEnv.DB.prepare("UPDATE docs SET dies_on = 0 WHERE id = ?").bind(id).run();
    await store.sweep(dayOf(LATER));
    expect(await row(id)).toBeNull();
    expect(await keys()).toContain(rootOf(mario));
  });
});

describe("an appeal that says someone else uploaded it", () => {
  const DAYS = (days: number) => NOW + days * DAY_MS;
  const today = (now: number) => dayOf(now);

  const sendAt = (id: string, bytes: Bytes, now: number) =>
    uploadDoc({ id, now, ip: "203.0.113.9", bytes: async () => bytes }, tools);

  const appeal = (id: string, now: number) =>
    administer({ id, ip: "203.0.113.9", now, token: "the admin token", action: "appeal" }, tools);

  const status = async (id: string, now: number) => {
    const answer = await administer({ id, ip: "203.0.113.9", now, token: "the admin token", action: "status" }, tools);
    return (answer as { status: { blockedAt: number | null; mayCorrect: boolean; appealedAt: number | null } }).status;
  };

  const reported = async (id: string, version: number, nets: string[], now: number, category = "phishing") => {
    for (const [at, net] of nets.entries()) {
      await store.report({ doc: id, net, asn: at + 1, category, version }, today(now), Math.floor(now / 3_600_000));
    }
  };

  const THREE = ["n1", "n2", "n3"];

  const editedByAna = async () => {
    const { permit, pair } = await newToken();
    const id = await shared({ permit });
    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    expect(await sendAt(id, edited, LATER)).toEqual({ stored: true, version: 2 });
    return { id, permit, pair };
  };

  const appealRow = (id: string) =>
    testEnv.DB.prepare(
      "SELECT permit, counts_from, appealed_at, appealed_hour, blocked_at, dies_on, ttl_days FROM docs WHERE id = ?",
    )
      .bind(id)
      .first<{
        permit: string | null;
        counts_from: number;
        appealed_at: number | null;
        appealed_hour: number | null;
        blocked_at: number | null;
        dies_on: number;
        ttl_days: number;
      }>();

  it("is accepted with nothing opened, and takes the edit link away, with the block staying", async () => {
    const { id } = await editedByAna();
    await reported(id, 2, THREE, LATER);
    expect(await appeal(id, LATER)).toEqual({ done: true, claim: "accepted" });

    const row = await appealRow(id);
    expect(row?.permit).toBeNull();
    expect(row?.counts_from).toBe(3);
    expect(row?.blocked_at).not.toBeNull();
    expect(row?.appealed_hour).toBeNull();
    expect((await status(id, LATER)).mayCorrect).toBe(true);
    expect(await appeal(id, LATER)).toEqual({ refused: "appealed" });
  });

  it("lets only a version of its owner lift the block, and gives back its days", async () => {
    const { id, permit, pair } = await editedByAna();
    await reported(id, 2, THREE, LATER);
    await appeal(id, LATER);

    const fromAna = await sealedEnvelope({ id, version: 3, owner: mario, signer: ana, permit, token: pair });
    expect(await sendAt(id, fromAna, DAYS(5))).toEqual({ refused: "not_yours" });

    const fromOwner = await sealedEnvelope({ id, version: 3, owner: mario });
    expect(await sendAt(id, fromOwner, DAYS(5))).toEqual({ stored: true, version: 3 });
    const row = await appealRow(id);
    expect(row?.blocked_at).toBeNull();
    expect(row?.appealed_at).toBeNull();
    expect(row?.dies_on).toBe(today(DAYS(5)) + (row?.ttl_days ?? 0));
    expect((await status(id, DAYS(5))).mayCorrect).toBe(false);
  });

  it("keeps what was reported, and those networks and their reports on record", async () => {
    const { id } = await editedByAna();
    await reported(id, 2, THREE, LATER);
    await appeal(id, LATER);
    const left = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE doc = ? AND cleared = 0")
      .bind(id)
      .first<{ n: number }>();
    expect(left?.n).toBe(3);
    const named = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM false_reporters").first<{ n: number }>();
    expect(named?.n).toBe(0);
  });

  it("counts only reports of the versions after it toward a new block", async () => {
    const { id } = await editedByAna();
    await reported(id, 2, THREE, LATER);
    await appeal(id, LATER);
    await sendAt(id, await sealedEnvelope({ id, version: 3, owner: mario }), DAYS(5));

    await reported(id, 2, ["old1", "old2", "old3"], DAYS(6));
    expect((await status(id, DAYS(6))).blockedAt).toBeNull();
    await reported(id, 3, ["new1", "new2"], DAYS(6));
    expect((await status(id, DAYS(6))).blockedAt).toBeNull();
    await reported(id, 3, ["new3"], DAYS(6));
    expect((await status(id, DAYS(6))).blockedAt).not.toBeNull();
    expect(await appeal(id, DAYS(6))).toEqual({ done: true, claim: "review" });
  });

  it("goes to the operator when its owner signed a version reported", async () => {
    const { id, permit } = await editedByAna();
    await reported(id, 1, ["n1"], LATER);
    await reported(id, 2, ["n2", "n3"], LATER);
    expect(await appeal(id, LATER)).toEqual({ done: true, claim: "review" });
    const row = await appealRow(id);
    expect(row?.permit).toBe(permit);
    expect(row?.counts_from).toBe(0);
    expect(row?.appealed_hour).not.toBeNull();
  });

  it("goes to the operator when a report of child abuse stands, even without its link", async () => {
    const { id } = await editedByAna();
    await reported(id, 2, THREE, LATER);
    await reported(id, 2, ["n4"], LATER, "csam");
    expect(await appeal(id, LATER)).toEqual({ done: true, claim: "review" });
  });

  it("takes a report of a version it no longer lists as no proof", async () => {
    const { id } = await editedByAna();
    await reported(id, 2, ["n1", "n2"], LATER);
    await reported(id, 99, ["n3"], LATER);
    await testEnv.DB.prepare("UPDATE reports SET version = 99 WHERE doc = ? AND net LIKE '%'").bind(id).run();
    expect((await status(id, LATER)).blockedAt).not.toBeNull();
    expect(await appeal(id, LATER)).toEqual({ done: true, claim: "review" });
  });

  it("goes to the operator when no report counts, as with a block set by hand", async () => {
    const { id } = await editedByAna();
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ? WHERE id = ?").bind(today(LATER), id).run();
    expect(await appeal(id, LATER)).toEqual({ done: true, claim: "review" });
  });

  it("lets a version of its owner lift a block that came while paused, and keeps the pause", async () => {
    const { id } = await editedByAna();
    await store.pause(id, today(LATER));
    await reported(id, 2, THREE, LATER);
    await appeal(id, LATER);
    const version = await sealedEnvelope({ id, version: 3, owner: mario });
    expect(await sendAt(id, version, DAYS(5))).toEqual({ stored: true, version: 3 });
    const row = await testEnv.DB.prepare("SELECT paused_at, blocked_at, dies_on FROM docs WHERE id = ?")
      .bind(id)
      .first<{ paused_at: number; blocked_at: number | null; dies_on: number }>();
    expect(row?.blocked_at).toBeNull();
    expect(row?.paused_at).toBe(today(LATER));
    expect(row?.dies_on).toBe(today(LATER) + LIMITS.pausedDays);
  });

  it("does not let a version from someone else lift it, even if it read the document before the block", async () => {
    const { id } = await editedByAna();
    const before = await store.held(id);
    await reported(id, 2, THREE, LATER);
    await appeal(id, LATER);
    const answer = await store.upload(
      {
        id,
        n: 3,
        hash: "late",
        body: "sealed",
        net: "n",
        at: DAYS(5),
        signer: rootOf(ana),
        machine: machineOf(ana),
        contract: "1.5.0",
        byOwner: false,
        permit: null,
        ownerMark: "late.mark",
      },
      today(DAYS(5)),
      before ?? undefined,
    );
    expect(answer).toBe("blocked");
    expect((await appealRow(id))?.blocked_at).not.toBeNull();
  });

  it("still refuses its owner's version on a block not cleared this way", async () => {
    const id = await shared();
    await reported(id, 1, THREE, LATER);
    expect(await appeal(id, LATER)).toEqual({ done: true, claim: "review" });
    const version = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await sendAt(id, version, DAYS(5))).toEqual({ refused: "blocked" });
  });
});

describe("what is refused writes nothing", () => {
  const counted = () => testEnv.DB.prepare("SELECT COUNT(*) AS n FROM net_hour").first<{ n: number }>();

  it("a first version that is not the first, which takes no place among their shares", async () => {
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 3, owner: mario });
    expect(await send(first.id, bytes, NOW, first)).toEqual({ refused: "behind" });
    expect(await row(first.id)).toBeNull();
  });

  it("one that is behind, paused or blocked, or spends the network's uploads", async () => {
    const id = await shared();
    await testEnv.DB.prepare("DELETE FROM net_hour").run();
    expect(await send(id, await sealedEnvelope({ id, version: 3, owner: mario }), LATER)).toEqual({
      refused: "behind",
    });
    await store.pause(id, dayOf(NOW));
    const next = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await send(id, next, LATER)).toEqual({ refused: "paused" });
    expect((await counted())?.n).toBe(0);
  });

  it("reads no body for a document that is not there, or a first one with no proof", async () => {
    const bytes = vi.fn(async () => new Uint8Array(1));
    await uploadDoc({ id: "AbCdEfGh", now: NOW, ip: "203.0.113.9", bytes }, tools);
    const hard = { ...tools, limits: { ...LIMITS, proofBits: 24 } };
    const first = await started();
    await uploadDoc({ id: first.id, now: NOW, ip: "203.0.113.9", bytes, first }, hard);
    await uploadDoc({ id: first.id, now: NOW, ip: "203.0.113.9", bytes, first: { ...first, start: "x" } }, tools);
    expect(bytes).not.toHaveBeenCalled();
  });

  it("reads no body for what the brake or the stage stop", async () => {
    const bytes = vi.fn(async () => new Uint8Array(1));
    const braked = { ...tools, limiter: { allows: async () => false } };
    await uploadDoc({ id: "AbCdEfGh", now: NOW, ip: "203.0.113.9", bytes }, braked);
    await store.setStage("no_uploads");
    await uploadDoc({ id: "AbCdEfGh", now: NOW, ip: "203.0.113.9", bytes }, tools);
    expect(bytes).not.toHaveBeenCalled();
  });

  it("refuses what says it is past the size, or does not fit", async () => {
    const id = await shared();
    const answer = await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => null }, tools);
    expect(answer).toEqual({ refused: "too_big" });
  });
});

describe("what stops a version", () => {
  it("one that is not the next says it is behind, and nothing else", async () => {
    const id = await shared();
    expect(await send(id, await sealedEnvelope({ id, version: 3, owner: mario }), LATER)).toEqual({
      refused: "behind",
    });
  });

  it("a paused or blocked document", async () => {
    const id = await shared();
    await store.pause(id, dayOf(NOW));
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      refused: "paused",
    });
    await testEnv.DB.prepare("UPDATE docs SET paused_at = NULL, blocked_at = 1 WHERE id = ?").bind(id).run();
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      refused: "blocked",
    });
  });

  describe("what a key holds", () => {
    const roomOf = (bytes: number) => ({ ...tools, limits: { ...LIMITS, keyBytesAtMost: bytes } });
    const sendTo = (to: UploadTools, id: string, bytes: Bytes, now = NOW, first?: FirstUpload, files?: string) =>
      uploadDoc(
        {
          id,
          now,
          ip: "203.0.113.9",
          bytes: async () => bytes,
          ...(first ? { first } : {}),
          ...(files ? { files } : {}),
        },
        to,
      );
    const filesTo = (to: UploadTools, id: string, bytes: Bytes, now = NOW) =>
      uploadFiles({ id, now, ip: "203.0.113.9", bytes: async () => bytes }, to);
    const twoOf = async (owner: Person) => {
      const one = await started();
      const two = await started();
      return {
        one,
        two,
        first: await sealedEnvelope({ id: one.id, version: 1, owner }),
        second: await sealedEnvelope({ id: two.id, version: 1, owner }),
      };
    };

    it("takes up to its room, and a first version past it leaves nothing", async () => {
      const fresh = await newPerson();
      const { one, two, first, second } = await twoOf(fresh);
      const room = roomOf(first.length + second.length - 1);
      expect(await sendTo(room, one.id, first, NOW, one)).toEqual({ stored: true, version: 1 });
      expect(await sendTo(room, two.id, second, NOW, two)).toEqual({ refused: "room_full" });
      expect(await row(two.id)).toBeNull();
      expect(await sendTo(roomOf(first.length + second.length), two.id, second, NOW, two)).toEqual({
        stored: true,
        version: 1,
      });
    });

    it("counts only the latest version, so editing a document never fills it", async () => {
      const fresh = await newPerson();
      const one = await started();
      const versions = await Promise.all(
        [1, 2, 3].map((version) => sealedEnvelope({ id: one.id, version, owner: fresh })),
      );
      const room = roomOf(Math.max(...versions.map((one) => one.length)));
      expect(await sendTo(room, one.id, versions[0] as Bytes, NOW, one)).toEqual({ stored: true, version: 1 });
      expect(await sendTo(room, one.id, versions[1] as Bytes, LATER)).toEqual({ stored: true, version: 2 });
      expect(await sendTo(room, one.id, versions[2] as Bytes, LATER + DAY_MS)).toEqual({ stored: true, version: 3 });
    });

    it("counts attachments by what they weigh, keeps them while the next version names them, and lets go when not", async () => {
      const fresh = await newPerson();
      const { one, two, first, second } = await twoOf(fresh);
      const files = await sealedEnvelope({ id: one.id, version: 1, owner: fresh, files: [16] });
      const hash = await filesHashOf(one.id, files);
      const holding = first.length + files.length;
      expect(await sendTo(roomOf(holding), one.id, first, NOW, one, hash)).toMatchObject({ stored: true });
      expect(await filesTo(roomOf(holding - 1), one.id, files)).toEqual({ refused: "room_full" });
      expect(await filesTo(roomOf(holding), one.id, files)).toEqual({ stored: true, hash });

      const another = async (now: number) => {
        const start = await started(now);
        const bytes = await sealedEnvelope({ id: start.id, version: 1, owner: fresh });
        return sendTo(roomOf(holding + bytes.length - 1), start.id, bytes, now, start);
      };
      expect(await sendTo(roomOf(holding + second.length - 1), two.id, second, NOW, two)).toEqual({
        refused: "room_full",
      });
      const again = await sealedEnvelope({ id: one.id, version: 2, owner: fresh });
      expect(await sendTo(roomOf(holding), one.id, again, LATER, undefined, hash)).toMatchObject({ stored: true });
      expect(await another(LATER)).toEqual({ refused: "room_full" });

      const plain = await sealedEnvelope({ id: one.id, version: 3, owner: fresh });
      expect(await sendTo(roomOf(holding), one.id, plain, LATER + DAY_MS)).toEqual({ stored: true, version: 3 });
      expect(await another(LATER + DAY_MS)).toEqual({ stored: true, version: 1 });
    });

    it("frees what stopped being shared", async () => {
      const fresh = await newPerson();
      const { one, two, first, second } = await twoOf(fresh);
      const room = roomOf(first.length + second.length - 1);
      await sendTo(room, one.id, first, NOW, one);
      await store.stop(one.id, dayOf(NOW));
      expect(await sendTo(room, two.id, second, NOW, two)).toEqual({ stored: true, version: 1 });
    });

    it("does not count a blocked document, which its owner cannot stop sharing", async () => {
      const fresh = await newPerson();
      const { one, two, first, second } = await twoOf(fresh);
      const room = roomOf(first.length + second.length - 1);
      await sendTo(room, one.id, first, NOW, one);
      await testEnv.DB.prepare("UPDATE docs SET blocked_at = ? WHERE id = ?").bind(dayOf(NOW), one.id).run();
      expect(await sendTo(room, two.id, second, NOW, two)).toEqual({ stored: true, version: 1 });
    });

    it("holds an old key to it too, while there is no reputation", async () => {
      const fresh = await newPerson();
      const { one, two, first, second } = await twoOf(fresh);
      const room = roomOf(first.length + second.length - 1);
      await sendTo(room, one.id, first, NOW, one);
      await testEnv.DB.prepare("UPDATE keys SET first_day = first_day - ?").bind(LIMITS.daysAKeyIsNew).run();
      expect(await sendTo(room, two.id, second, NOW, two)).toEqual({ refused: "room_full" });
    });

    it("charges an editor's version to the owner's room", async () => {
      const { pair, permit } = await newToken();
      const id = await shared({ permit });
      const other = await started();
      const kept = await sealedEnvelope({ id: other.id, version: 1, owner: mario });
      await send(other.id, kept, NOW, other);
      const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
      expect(await sendTo(roomOf(kept.length + edited.length - 1), id, edited, LATER)).toEqual({
        refused: "room_full",
      });
      expect(await sendTo(roomOf(kept.length + edited.length), id, edited, LATER)).toEqual({
        stored: true,
        version: 2,
      });
    });

    it("lets its owner's correction through, as the terms promise", async () => {
      const fresh = await newPerson();
      const one = await started();
      await send(one.id, await sealedEnvelope({ id: one.id, version: 1, owner: fresh }), NOW, one);
      await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?, counts_from = 2 WHERE id = ?")
        .bind(dayOf(NOW), one.id)
        .run();
      const fixed = await sealedEnvelope({ id: one.id, version: 2, owner: fresh });
      expect(await sendTo(roomOf(1), one.id, fixed, LATER)).toEqual({ stored: true, version: 2 });
    });
  });

  describe("a key the operator blocked", () => {
    const blocked = () => new CloudModeration(testEnv.DB);
    const rootOf = (person: Person): string => toBase64Url(person.rootBytes);

    it("uploads no new document, and keeps nothing of it", async () => {
      const fresh = await newPerson();
      const before = await started();
      await send(before.id, await sealedEnvelope({ id: before.id, version: 1, owner: fresh }), NOW, before);
      await blocked().blockKey(rootOf(fresh), "abuse", NOW);
      const first = await started();
      const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: fresh });
      expect(await send(first.id, bytes, NOW, first)).toEqual({ refused: "key_blocked" });
      expect(await row(first.id)).toBeNull();
    });

    it("uploads no new version, and what it shared can still be read", async () => {
      const fresh = await newPerson();
      const first = await started();
      await send(first.id, await sealedEnvelope({ id: first.id, version: 1, owner: fresh }), NOW, first);
      await blocked().blockKey(rootOf(fresh), "abuse", NOW);
      const next = await sealedEnvelope({ id: first.id, version: 2, owner: fresh });
      expect(await send(first.id, next, LATER)).toEqual({ refused: "key_blocked" });
      expect(await readDoc({ id: first.id, ip: "203.0.113.9", now: LATER }, tools)).toMatchObject({ served: true });
    });

    it("uploads again once lifted", async () => {
      const fresh = await newPerson();
      const first = await started();
      await send(first.id, await sealedEnvelope({ id: first.id, version: 1, owner: fresh }), NOW, first);
      await blocked().blockKey(rootOf(fresh), "abuse", NOW);
      await blocked().unblockKey(rootOf(fresh), NOW);
      const next = await sealedEnvelope({ id: first.id, version: 2, owner: fresh });
      expect(await send(first.id, next, LATER)).toEqual({ stored: true, version: 2 });
    });

    it("takes no version of its documents from an editor either", async () => {
      const { pair, permit } = await newToken();
      const id = await shared({ permit });
      await blocked().blockKey(rootOf(mario), "abuse", NOW);
      const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
      expect(await send(id, edited, LATER)).toEqual({ refused: "key_blocked" });
    });
  });

  describe("the terms in force", () => {
    const UNDER = { ...tools, termsVersion: "9" };
    const HOUR = Math.floor(NOW / 3_600_000);
    const HOUR_LATER = Math.floor(LATER / 3_600_000);
    const keyRow = (root: string) =>
      testEnv.DB.prepare("SELECT terms_version, terms_hour FROM keys WHERE root = ?")
        .bind(root)
        .first<{ terms_version: string | null; terms_hour: number | null }>();
    const rootOf = (person: Person): string => toBase64Url(person.rootBytes);
    const up = (id: string, bytes: Bytes, now: number, first?: FirstUpload, under: UploadTools = UNDER) =>
      uploadDoc({ id, now, ip: "203.0.113.9", bytes: async () => bytes, ...(first ? { first } : {}) }, under);
    const sharing = async (who: Person, terms: string) => {
      const first = await started();
      const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: who, terms });
      return { id: first.id, bytes, answer: await up(first.id, bytes, NOW, first) };
    };
    const nextVersion = async (id: string, who: Person, terms: string) =>
      up(id, await sealedEnvelope({ id, version: 2, owner: who, terms }), LATER);

    it.each([
      ["says nothing of them", ""],
      ["accepted one older than the last", "7"],
      ["is more than one ahead", "11"],
      ["names a version that will never exist", "9999999999999999"],
    ])("refuses a new document that %s, names the version, and keeps nothing", async (_what, terms) => {
      const fresh = await newPerson();
      const { id, answer } = await sharing(fresh, terms);
      expect(answer).toEqual({ refused: "terms", version: "9" });
      expect(await row(id)).toBeNull();
      expect(await keyRow(rootOf(fresh))).toBeNull();
    });

    it("takes the version in force, the next while a deploy catches up, and the last while caches do", async () => {
      expect((await sharing(await newPerson(), "9")).answer).toEqual({ stored: true, version: 1 });
      expect((await sharing(await newPerson(), "10")).answer).toEqual({ stored: true, version: 1 });
      expect((await sharing(await newPerson(), "8")).answer).toEqual({ stored: true, version: 1 });
    });

    it("keeps the version beside a new key, to the hour, so it names no upload", async () => {
      const fresh = await newPerson();
      await sharing(fresh, "9");
      expect(await keyRow(rootOf(fresh))).toEqual({ terms_version: "9", terms_hour: HOUR });
    });

    it("has one way to write a version, since the contract refuses leading zeros", async () => {
      const fresh = await newPerson();
      const { answer } = await sharing(fresh, "009");
      expect(answer).toMatchObject({ refused: "envelope" });
      expect(await keyRow(rootOf(fresh))).toBeNull();
    });

    it("writes the new version and its hour when it grows", async () => {
      const fresh = await newPerson();
      const { id } = await sharing(fresh, "9");
      expect(await nextVersion(id, fresh, "10")).toEqual({ stored: true, version: 2 });
      expect(await keyRow(rootOf(fresh))).toEqual({ terms_version: "10", terms_hour: HOUR_LATER });
    });

    it("does not go back when another machine still sends the older one", async () => {
      const fresh = await newPerson();
      const { id } = await sharing(fresh, "10");
      expect(await nextVersion(id, fresh, "9")).toEqual({ stored: true, version: 2 });
      expect(await keyRow(rootOf(fresh))).toEqual({ terms_version: "10", terms_hour: HOUR });
    });

    it("does not go back even if two uploads cross, which the store holds to by itself", async () => {
      const fresh = await newPerson();
      await sharing(fresh, "10");
      await store.keepKeys([], 1, { root: rootOf(fresh), version: "9", hour: HOUR_LATER });
      expect(await keyRow(rootOf(fresh))).toEqual({ terms_version: "10", terms_hour: HOUR });
    });

    it("reads only the keys' age and terms, and writes nothing about the key, while the version does not change", async () => {
      const said: string[] = [];
      const watched = new Proxy(testEnv.DB, {
        get(database, name) {
          if (name === "prepare") {
            return (statement: string) => {
              said.push(statement);
              return database.prepare(statement);
            };
          }
          const value = Reflect.get(database, name);
          return typeof value === "function" ? value.bind(database) : value;
        },
      });
      const fresh = await newPerson();
      const { id } = await sharing(fresh, "10");
      const counted = { ...UNDER, store: new Cloud({ ...testEnv, DB: watched }, LIMITS) };
      await up(id, await sealedEnvelope({ id, version: 2, owner: fresh, terms: "9" }), LATER, undefined, counted);
      const aboutKeys = said.filter((one) => /\b(FROM|INTO|UPDATE) keys\b/.test(one));
      expect(aboutKeys).toHaveLength(2);
      expect(aboutKeys[0]).toContain("k.first_day <= ?2");
      expect(aboutKeys[1]).toBe("SELECT terms_version, blocked_at FROM keys WHERE root = ?");
    });

    it("writes the record on a retry, when the first try lost it", async () => {
      const fresh = await newPerson();
      const { id, bytes } = await sharing(fresh, "9");
      await testEnv.DB.prepare("DELETE FROM keys WHERE root = ?").bind(rootOf(fresh)).run();
      expect(await up(id, bytes, LATER)).toEqual({ stored: true, version: 1 });
      expect(await keyRow(rootOf(fresh))).toEqual({ terms_version: "9", terms_hour: HOUR_LATER });
    });

    it("answers a retry of what is kept even after the terms moved on", async () => {
      const fresh = await newPerson();
      const { id, bytes } = await sharing(fresh, "9");
      const moved = { ...UNDER, termsVersion: "50" };
      expect(await up(id, bytes, LATER, undefined, moved)).toEqual({ stored: true, version: 1 });
      expect((await keyRow(rootOf(fresh)))?.terms_version).toBe("9");
    });

    it("refuses the next version of what is shared when the terms moved on twice", async () => {
      const fresh = await newPerson();
      const { id } = await sharing(fresh, "9");
      expect(await nextVersion(id, fresh, "7")).toEqual({ refused: "terms", version: "9" });
    });

    it("keeps reading what was shared under older terms", async () => {
      const id = await shared();
      const moved = { ...tools, termsVersion: "1000" };
      expect(await readDoc({ id, ip: "203.0.113.9", now: LATER }, moved)).toMatchObject({ served: true });
    });
  });

  describe("while the service has not opened", () => {
    const closed = { ...tools, sharingOpen: false };

    it("refuses a new document, and keeps nothing of it", async () => {
      const first = await started();
      const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
      const sent = uploadDoc({ id: first.id, now: NOW, ip: "203.0.113.9", bytes: async () => bytes, first }, closed);
      expect(await sent).toEqual({ refused: "uploads_off" });
      expect(await row(first.id)).toBeNull();
    });

    it("asks no proof of work for a share it would refuse anyway", async () => {
      const first = { ...(await started()), proof: "" };
      const sent = uploadDoc({ id: first.id, now: NOW, ip: "203.0.113.9", bytes: async () => null, first }, closed);
      expect(await sent).toEqual({ refused: "uploads_off" });
    });

    it("takes a new version of what is already shared", async () => {
      const id = await shared();
      const bytes = await sealedEnvelope({ id, version: 2, owner: mario });
      const sent = uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => bytes }, closed);
      expect(await sent).toEqual({ stored: true, version: 2 });
    });
  });

  describe("past what new keys may store in a day", () => {
    const newKeysBytes = () =>
      testEnv.DB.prepare("SELECT bytes FROM net_day WHERE net = '~new-keys'").first<{ bytes: number }>();
    const limited = (bytes: number) => {
      const few = { ...LIMITS, newKeysBytesADay: bytes };
      return { ...tools, store: new Cloud(testEnv, few), limits: few };
    };
    const firstFrom = async (over: Parameters<typeof uploadDoc>[1], now = NOW) => {
      const first = await started(now);
      const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
      const answer = await uploadDoc({ id: first.id, now, ip: "203.0.113.9", bytes: async () => bytes, first }, over);
      return { answer, id: first.id, size: bytes.length };
    };

    it("refuses as off, gives the network's bytes back, and takes nothing more", async () => {
      const { size } = await firstFrom(tools);
      expect((await newKeysBytes())?.bytes).toBe(size);
      await testEnv.DB.prepare("DELETE FROM docs").run();
      const tight = limited(size);
      const { answer, id } = await firstFrom(tight);
      expect(answer).toEqual({ refused: "uploads_off" });
      expect((await newKeysBytes())?.bytes).toBe(size);
      const held = await testEnv.DB.prepare("SELECT bytes FROM net_day WHERE net <> '~new-keys'").first<{
        bytes: number;
      }>();
      expect(held?.bytes).toBe(size);
      expect((await testEnv.ENVELOPES.list({ prefix: id })).objects).toEqual([]);
    });

    it("fits up to the last byte, and starts again the next day", async () => {
      const { size } = await firstFrom(limited(1_000_000_000));
      await testEnv.DB.prepare("DELETE FROM docs").run();
      expect((await firstFrom(limited(2 * size + 1000))).answer).toMatchObject({ stored: true });
      await testEnv.DB.prepare("DELETE FROM docs").run();
      expect((await firstFrom(limited(size))).answer).toEqual({ refused: "uploads_off" });
      await testEnv.DB.prepare("DELETE FROM docs").run();
      expect((await firstFrom(limited(size + 1000), NOW + DAY_MS)).answer).toMatchObject({ stored: true });
    });

    it("does not count a key of 30 days, nor an owner's own correction", async () => {
      const id = await shared();
      const tight = limited(1);
      const old = await sealedEnvelope({ id, version: 2, owner: mario });
      const sendWith = (bytes: Bytes, now: number) =>
        uploadDoc({ id, now, ip: "203.0.113.9", bytes: async () => bytes }, tight);
      expect(await sendWith(old, LATER)).toEqual({ refused: "uploads_off" });
      await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?, counts_from = latest + 1 WHERE id = ?")
        .bind(dayOf(NOW), id)
        .run();
      expect(await sendWith(old, LATER)).toEqual({ stored: true, version: 2 });
      const before = (await newKeysBytes())?.bytes;
      const next = await sealedEnvelope({ id, version: 3, owner: mario });
      expect(await sendWith(next, NOW + 30 * DAY_MS)).toEqual({ stored: true, version: 3 });
      expect((await newKeysBytes())?.bytes).toBe(before);
    });

    it("does not count the files of a version already kept, so it never stays without them", async () => {
      const first = await started();
      const main = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
      expect(await send(first.id, main, NOW, first)).toEqual({ stored: true, version: 1 });
      const files = await sealedEnvelope({ id: first.id, version: 2, owner: mario, files: [16] });
      const hash = await filesHashOf(first.id, files);
      await testEnv.DB.prepare("UPDATE docs SET versions = json_set(versions, '$[#-1].files', ?) WHERE id = ?")
        .bind(hash, first.id)
        .run();
      const before = (await newKeysBytes())?.bytes;
      const answer = await uploadFiles(
        { id: first.id, now: NOW, ip: "203.0.113.9", bytes: async () => files },
        limited(1),
      );
      expect(answer).toEqual({ stored: true, hash });
      expect((await newKeysBytes())?.bytes).toBe(before);
    });

    it("leaves no share behind when a first version is refused, so it holds nothing the next day", async () => {
      const refused = await firstFrom(limited(1));
      expect(refused.answer).toEqual({ refused: "uploads_off" });
      expect(await row(refused.id)).toBeNull();
      expect((await firstFrom(limited(1))).answer).toEqual({ refused: "uploads_off" });
      expect((await firstFrom(limited(1))).answer).toEqual({ refused: "uploads_off" });
      const docs = await testEnv.DB.prepare("SELECT docs FROM net_day WHERE net <> '~new-keys'").first<{
        docs: number;
      }>();
      expect(docs?.docs).toBe(0);
      expect((await firstFrom(tools, NOW + DAY_MS)).answer).toEqual({ stored: true, version: 1 });
    });

    it("refuses a network past its own share of the limit, and gives its bytes back", async () => {
      const { size } = await firstFrom(tools);
      await testEnv.DB.prepare("DELETE FROM docs").run();
      const few = { ...LIMITS, newKeysNetBytesADay: 2 * size - 1 };
      const tight = { ...tools, store: new Cloud(testEnv, few), limits: few };
      expect((await firstFrom(tight)).answer).toEqual({ refused: "uploads_off" });
      const net = await testEnv.DB.prepare("SELECT bytes FROM net_day WHERE net <> '~new-keys'").first<{
        bytes: number;
      }>();
      expect(net?.bytes).toBe(size);
      const enough = { ...LIMITS, newKeysNetBytesADay: 2 * size + 1000 };
      expect((await firstFrom({ ...tools, store: new Cloud(testEnv, enough), limits: enough })).answer).toMatchObject({
        stored: true,
      });
    });
  });

  it("near the ceiling, from a key of 29 days, but not from one of 30", async () => {
    const id = await shared();
    await store.setStage("new_keys_off");
    const version2 = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await send(id, version2, NOW + 29 * DAY_MS)).toEqual({ refused: "uploads_off" });
    expect(await send(id, version2, NOW + 30 * DAY_MS)).toEqual({ stored: true, version: 2 });
  });

  it("near the ceiling, but never an owner's own correction of a block", async () => {
    const id = await shared();
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?, counts_from = latest + 1 WHERE id = ?")
      .bind(dayOf(NOW), id)
      .run();
    await store.setStage("new_keys_off");
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      stored: true,
      version: 2,
    });
  });

  it("near the ceiling, a correction someone else signs, however it was blocked", async () => {
    const { pair, permit } = await newToken();
    const id = await shared({ permit });
    await testEnv.DB.prepare("UPDATE docs SET blocked_at = ?, counts_from = latest + 1 WHERE id = ?")
      .bind(dayOf(NOW), id)
      .run();
    await store.setStage("new_keys_off");
    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    expect(await send(id, edited, LATER)).toEqual({ refused: "uploads_off" });
  });

  it("a later version past the hour, while a first one spends only one", async () => {
    const oneAnHour = { ...tools, limits: { ...LIMITS, uploadsAnHour: 1 } };
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    const stored = await uploadDoc(
      { id: first.id, now: NOW, ip: "203.0.113.9", bytes: async () => bytes, first },
      oneAnHour,
    );
    expect(stored).toEqual({ stored: true, version: 1 });
    const next = await sealedEnvelope({ id: first.id, version: 2, owner: mario });
    const answer = await uploadDoc(
      { id: first.id, now: NOW + 2 * 60_000, ip: "203.0.113.9", bytes: async () => next },
      oneAnHour,
    );
    expect(answer).toMatchObject({ refused: "quota" });
  });

  it("past the languages a document may have", async () => {
    const few = { ...LIMITS, languagesAtMost: 3 };
    const tight = { ...tools, store: new Cloud(testEnv, few), limits: few };
    const id = await shared();
    const language = async () => {
      const first = { ...(await started()), anchor: id };
      const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
      return uploadDoc({ id: first.id, now: NOW, ip: "203.0.113.9", bytes: async () => bytes, first }, tight);
    };
    expect(await language()).toEqual({ stored: true, version: 1 });
    expect(await language()).toEqual({ stored: true, version: 1 });
    expect(await language()).toEqual({ refused: "languages_full" });
  });

  it("near the ceiling, from a new owner, whatever old key signs for it", async () => {
    await shared();
    const waited = LATER + LIMITS.daysAKeyIsNew * DAY_MS;
    await store.setStage("new_keys_off");
    const { pair, permit } = await newToken();
    const first = await started(waited);
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: ana, signer: mario, permit, token: pair });
    expect(await send(first.id, bytes, waited, first)).toEqual({ refused: "uploads_off" });
    expect(await row(first.id)).toBeNull();
  });

  it("near the ceiling, from a new editor of an old owner", async () => {
    const { pair, permit } = await newToken();
    const id = await shared({ permit });
    await store.setStage("new_keys_off");
    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    const waited = LATER + LIMITS.daysAKeyIsNew * DAY_MS;
    expect(await send(id, edited, waited)).toEqual({ refused: "uploads_off" });
  });

  it("a refused first version counts against the hour, and writes nothing after it", async () => {
    const oneAnHour = { ...tools, limits: { ...LIMITS, uploadsAnHour: 1 } };
    const sendOnce = async (first: FirstUpload & { id: string }) => {
      const bytes = async () => sealedEnvelope({ id: first.id, version: 1, owner: mario });
      return uploadDoc({ id: first.id, now: NOW, ip: "203.0.113.9", bytes, first }, oneAnHour);
    };
    expect(await sendOnce({ ...(await started()), anchor: "AbCdEfGh" })).toEqual({ refused: "bad_upload" });
    const valid = await started();
    expect(await sendOnce(valid)).toMatchObject({ refused: "quota" });
    expect(await row(valid.id)).toBeNull();
  });

  it.each(["no_uploads", "blocked"] as Stage[])("the spending stage %s", async (stage) => {
    const id = await shared();
    await store.setStage(stage);
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      refused: "uploads_off",
    });
  });

  it("past its tops, by what its manifest says", async () => {
    const id = await shared();
    const version = 2;
    const tooManyPictures = Array.from({ length: LIMITS.picturesAtMost + 1 }, () => 4);
    for (const over of [
      { pictures: tooManyPictures },
      { pictures: [LIMITS.pictureBytesAtMost + 1] },
      { firstBytes: LIMITS.firstBytesAtMost + 1 },
    ]) {
      expect(await send(id, await sealedEnvelope({ id, version, owner: mario, ...over }), LATER)).toEqual({
        refused: "too_big",
      });
    }
    const small = { ...tools, limits: { ...LIMITS, envelopeBytesAtMost: 10 } };
    const bytes = await sealedEnvelope({ id, version, owner: mario });
    expect(await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => bytes }, small)).toEqual({
      refused: "too_big",
    });
  });

  it("a contract under the floor, once there is one", async () => {
    const id = await shared();
    const floored = { ...tools, limits: { ...LIMITS, oldestContractTaken: "2.0.0" } };
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => bytes }, floored)).toEqual({
      refused: "outdated",
    });
  });

  it("a brake that says no", async () => {
    const braked = { ...tools, limiter: { allows: async () => false } };
    const bytes = await sealedEnvelope({ id: "AbCdEfGh", version: 1, owner: mario });
    const answer = await uploadDoc({ id: "AbCdEfGh", now: NOW, ip: "203.0.113.9", bytes: async () => bytes }, braked);
    expect(answer).toMatchObject({ refused: "slow" });
  });

  it("waiting after the last press, and writes nothing while it does", async () => {
    const id = await shared();
    const before = await row(id);
    const next = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await send(id, next, NOW + 1000)).toEqual({ refused: "slow", until: NOW + 60_000 });
    expect(await row(id)).toEqual(before);
    expect(await send(id, next, NOW + 60_000)).toEqual({ stored: true, version: 2 });
  });
});

const versionsAt = (signer: string, ...ats: number[]): Version[] =>
  ats.map((at, index) => ({ n: index + 1, hash: `h${index}`, bytes: 1, at, signer, machine: "m", contract: "1.2.0" }));
const MINUTE = 60_000;

describe("a machine its root took back", () => {
  const AT = "2026-11-01T10:00:00Z";
  const LATER_AT = "2026-11-02T10:00:00Z";
  const take = (said: unknown) => takeRevocations({ said, ip: "203.0.113.9", now: NOW }, tools);
  const otherMachines = (person: Person, howMany: number) =>
    Promise.all(
      Array.from({ length: howMany }, () =>
        revocationBy({ ...person, machineBytes: crypto.getRandomValues(new Uint8Array(32)) }, AT),
      ),
    );
  const keptAt = async (person: Person) => {
    const kept = await testEnv.DB.prepare("SELECT at FROM revocations WHERE root = ? AND machine = ?")
      .bind(rootOf(person), machineOf(person))
      .first<{ at: number }>();
    return kept ? new Date(kept.at * 1000).toISOString().replace(".000", "") : null;
  };

  it("no longer sends a version", async () => {
    const id = await shared();
    expect(await take([await revocationBy(mario, AT)])).toEqual({ done: true });
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      refused: "revoked",
    });
  });

  it("may send until the moment it says, when that has not come", async () => {
    const id = await shared();
    await take([await revocationBy(mario, "2027-01-01T00:00:00Z")]);
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      stored: true,
      version: 2,
    });
  });

  it("stops only that person's machine", async () => {
    const { pair, permit } = await newToken();
    const id = await shared({ permit });
    const signed = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    expect(await send(id, signed, LATER)).toEqual({ stored: true, version: 2 });
    expect(await take([await revocationBy(ana, AT)])).toEqual({ done: true });
    const stopped = await sealedEnvelope({ id, version: 3, owner: mario, signer: ana, permit, token: pair });
    expect(await send(id, stopped, LATER)).toEqual({ refused: "revoked" });
    expect(await send(id, await sealedEnvelope({ id, version: 3, owner: mario, permit }), LATER)).toEqual({
      stored: true,
      version: 3,
    });
  });

  it("finds its machine among all the others its root took back", async () => {
    const id = await shared();
    await store.revoke(await otherMachines(mario, 20));
    await store.revoke([await revocationBy(mario, AT)]);
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      refused: "revoked",
    });
  });

  it("takes no place when it shares something new", async () => {
    await shared();
    await take([await revocationBy(mario, AT)]);
    const first = await started(LATER);
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    expect(await send(first.id, bytes, LATER, first)).toEqual({ refused: "revoked" });
    expect(await row(first.id)).toBeNull();
  });

  it("is told to a reader for the machine that signed and the owner's, and no other", async () => {
    const { pair, permit } = await newToken();
    const id = await shared({ permit });
    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    expect(await send(id, edited, LATER)).toEqual({ stored: true, version: 2 });
    const others = [...(await otherMachines(mario, 20)), ...(await otherMachines(ana, 20))];
    await store.revoke(others);
    const asked = [await revocationBy(mario, AT), await revocationBy(ana, AT)];
    await store.revoke(asked);
    const read = await readDoc({ id, ip: "203.0.113.9", now: LATER }, tools);
    if (!("served" in read)) throw new Error(read.refused);
    await read.body.cancel();
    expect(read.revocations.map((one) => one.machine).sort()).toEqual(asked.map((one) => one.machine).sort());
    expect(read.revocations.find((one) => one.root === rootOf(ana))).toEqual(asked[1]);
  });

  it("is not kept for a root that signed nothing here", async () => {
    await shared();
    expect(await take([await revocationBy(ana, AT)])).toEqual({ refused: "bad_revocation" });
    expect(await take([await revocationBy(mario, AT), await revocationBy(ana, AT)])).toEqual({
      refused: "bad_revocation",
    });
    expect(await keptAt(ana)).toBeNull();
    expect(await keptAt(mario)).toBeNull();
  });

  it("counts each one against the quota, not each call", async () => {
    await shared();
    const quick = { ...tools, limits: { ...LIMITS, revocationsAnHour: 3 } };
    const ask = async (howMany: number) =>
      takeRevocations({ said: await otherMachines(mario, howMany), ip: "203.0.113.9", now: NOW }, quick);
    expect(await ask(4)).toMatchObject({ refused: "quota" });
    expect(await ask(2)).toEqual({ done: true });
    expect(await ask(2)).toMatchObject({ refused: "quota" });
    expect(await ask(1)).toEqual({ done: true });
  });

  it("keeps the earliest moment, and a later note cannot move it", async () => {
    await shared();
    await take([await revocationBy(mario, AT)]);
    await take([await revocationBy(mario, LATER_AT)]);
    expect(await keptAt(mario)).toBe(AT);
    const earlier = "2026-10-20T10:00:00Z";
    await take([await revocationBy(mario, earlier)]);
    expect(await keptAt(mario)).toBe(earlier);
  });

  it("is said only by its own root, in what the contract allows", async () => {
    await shared();
    const good = await revocationBy(mario, AT);
    for (const said of [
      [],
      "not a list",
      Array.from({ length: LIMITS.revocationsAtOnce + 1 }, () => good),
      [{ ...good, signed: (await revocationBy(ana, AT)).signed }],
      [{ ...good, at: "yesterday" }],
      [{ ...good, root: rootOf(ana) }],
    ]) {
      expect(await take(said)).toEqual({ refused: "bad_revocation" });
    }
    expect(await keptAt(mario)).toBeNull();
  });

  it("stops at its quota and at the brake", async () => {
    await shared();
    const good = await revocationBy(mario, AT);
    const quick = { ...tools, limits: { ...LIMITS, revocationsAnHour: 1 } };
    const ask = (over = quick) => takeRevocations({ said: [good], ip: "203.0.113.9", now: NOW }, over);
    expect(await ask()).toEqual({ done: true });
    expect(await ask()).toMatchObject({ refused: "quota" });
    expect(await ask({ ...quick, limiter: { allows: async () => false } })).toMatchObject({ refused: "slow" });
  });

  it("stops at the machines a root may take back, says so, and keeps what fit", async () => {
    await shared();
    const few = { ...LIMITS, revokedMachinesAtMost: 2 };
    const tight = { ...tools, store: new Cloud(testEnv, few), limits: few };
    const ask = async (howMany: number) =>
      takeRevocations({ said: await otherMachines(mario, howMany), ip: "203.0.113.9", now: NOW }, tight);
    expect(await ask(1)).toEqual({ done: true });
    expect(await ask(2)).toEqual({ refused: "machines_full" });
    const { n } = (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM revocations").first<{ n: number }>()) ?? {};
    expect(n).toBe(2);
  });
});

describe("the waits of the button", () => {
  it("are the ones decided, in a row", () => {
    const presses = [0, 1, 2, 3, 5, 9, 17].map((one) => one * MINUTE);
    const expected = [1, 1, 1, 2, 4, 8, 15];
    presses.forEach((_, at) => {
      const made = versionsAt("a", ...presses.slice(0, at + 1));
      const last = presses[at] as number;
      expect(uploadAllowedAt(made, "a", last, LEVEL_ONE)).toBe(last + (expected[at] as number) * MINUTE);
    });
  });

  it("stay at the longest", () => {
    const presses = [0, 1, 2, 3, 5, 9, 17, 32, 47].map((one) => one * MINUTE);
    const last = presses.at(-1) as number;
    expect(uploadAllowedAt(versionsAt("a", ...presses), "a", last, { ...LEVEL_ONE, uploadsOfARootAnHour: 100 })).toBe(
      last + 15 * MINUTE,
    );
  });

  it("start over after half an hour with no press", () => {
    const made = versionsAt("a", 0, MINUTE, 2 * MINUTE);
    expect(uploadAllowedAt(made, "a", 40 * MINUTE, LEVEL_ONE)).toBe(40 * MINUTE);
    const after = versionsAt("a", 0, MINUTE, 40 * MINUTE);
    expect(uploadAllowedAt(after, "a", 40 * MINUTE, LEVEL_ONE)).toBe(41 * MINUTE);
  });

  it("are each person's, so a team does not wait on each other", () => {
    const made = versionsAt("a", 0, MINUTE, 2 * MINUTE);
    expect(uploadAllowedAt(made, "b", 2 * MINUTE, LEVEL_ONE)).toBe(2 * MINUTE);
  });

  it("hold ten an hour even after half an hour with no press", () => {
    const ten = Array.from({ length: 10 }, (_, at) => at * 2 * MINUTE);
    expect(uploadAllowedAt(versionsAt("a", ...ten), "a", 49 * MINUTE, LEVEL_ONE)).toBe(60 * MINUTE);
  });

  it("hold ten an hour", () => {
    const ten = Array.from({ length: 10 }, (_, at) => at * 2 * MINUTE);
    const made = versionsAt("a", ...ten);
    const quick = { ...LEVEL_ONE, uploadWaitsMinutes: [0] };
    expect(uploadAllowedAt(made, "a", 19 * MINUTE, quick)).toBe(60 * MINUTE);
  });
});

describe("the versions it keeps", () => {
  const DAY = DAY_MS;

  it("keeps the last ones and what was replaced in the last days", () => {
    const made = versionsAt("a", 0, DAY, 2 * DAY, 20 * DAY, 21 * DAY, 22 * DAY);
    expect(keptVersions(made, 22 * DAY, LEVEL_ONE).map((one) => one.n)).toEqual([3, 4, 5, 6]);
  });

  it("keeps everything replaced in its last days, however many", () => {
    const made = versionsAt("a", 0, 1, 2, 3, 4, 5, 6);
    expect(keptVersions(made, 7, LEVEL_ONE)).toHaveLength(7);
  });

  it("counts from when a version was replaced, and not from when it arrived", () => {
    const made = versionsAt("a", 0, 30 * DAY, 31 * DAY);
    expect(keptVersions(made, 32 * DAY, LEVEL_ONE).map((one) => one.n)).toEqual([1, 2, 3]);
    expect(keptVersions(made, 35 * DAY, LEVEL_ONE).map((one) => one.n)).toEqual([3]);
  });

  it("refuses past the list's size rather than letting evidence go", async () => {
    const id = await shared();
    const many = versionsAt(rootOf(mario), ...Array.from({ length: LIMITS.versionsListedAtMost }, (_, at) => NOW + at));
    await testEnv.DB.prepare("UPDATE docs SET latest = ?, versions = ? WHERE id = ?")
      .bind(many.length, JSON.stringify(many), id)
      .run();
    const bytes = await sealedEnvelope({ id, version: many.length + 1, owner: mario });
    expect(await send(id, bytes, LATER)).toEqual({
      refused: "quota",
      until: NOW + 1 + LIMITS.replacedKeptDays * DAY_MS,
    });
  });

  it("says when a full list frees, and nothing while it has room", () => {
    const room = versionsAt("a", 0, 1, 2);
    expect(listFreesAt(room, 3, LEVEL_ONE)).toBeNull();
    const full = versionsAt("a", ...Array.from({ length: LEVEL_ONE.versionsListedAtMost }, (_, at) => at * 1000));
    expect(listFreesAt(full, 300_000, LEVEL_ONE)).toBe(1000 + LEVEL_ONE.replacedKeptDays * DAY);
  });
});

describe("asking which version there is", () => {
  const counted = (id: string) => latestVersion({ id, now: NOW, ip: "203.0.113.9" }, tools);

  it("says the version and its hash, and writes nothing", async () => {
    const id = await shared();
    const before = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master").first();
    const held = JSON.parse((await row(id))?.versions ?? "[]") as Version[];
    expect(await counted(id)).toEqual({ version: 1, hash: held[0]?.hash });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master").first()).toEqual(before);
  });

  it("refuses what a read refuses", async () => {
    expect(await counted("nothing0")).toEqual({ refused: "missing" });
    const id = await shared();
    await store.pause(id, dayOf(NOW));
    expect(await counted(id)).toEqual({ refused: "paused" });
  });

  it("is held back by its own brake, by network and document", async () => {
    const seen: string[] = [];
    const answer = await latestVersion(
      { id: "AbCdEfGh", now: NOW, ip: "203.0.113.9" },
      {
        ...tools,
        syncLimiter: {
          allows: async (key) => {
            seen.push(key);
            return false;
          },
        },
      },
    );
    expect(answer).toMatchObject({ refused: "slow" });
    expect(seen[0]).toMatch(/\|AbCdEfGh$/);
  });
});
