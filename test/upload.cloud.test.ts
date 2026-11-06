import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Cloud } from "../src/cloudflare/store";
import type { Bytes } from "../src/core/bytes";
import { DAY_MS, dayOf, LEVEL_ONE, type Limits } from "../src/core/limits";
import { latestVersion, readDoc, readFiles } from "../src/core/read";
import { takeRevocations } from "../src/core/revocations";
import { saltFor, solveProof, startNow, toBase64Url, tokenHash } from "../src/core/start";
import type { Stage, Version } from "../src/core/store";
import { type FirstUpload, uploadDoc, uploadFiles } from "../src/core/upload";
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
  for (const table of ["docs", "net_day", "net_hour", "service_stage", "revocations", "editors"]) {
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

  it("refuses a hash that cannot be one before it reads anything", async () => {
    const id = await shared();
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario });
    const said = await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => bytes, files: "no" }, tools);
    expect(said).toEqual({ refused: "bad_upload" });
  });

  it("refuses more files, or more bytes, than a document may have", async () => {
    const id = await shared();
    const three = await sealedEnvelope({ id, version: 2, owner: mario, files: [16, 16, 16] });
    expect(await sendFiles(id, three)).toEqual({ refused: "too_big" });
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

    for (const version of [6, 7]) {
      const next = await sealedEnvelope({ id, version, owner: mario });
      await uploadDoc({ id, now: dayOfVersion(version), ip: "203.0.113.9", bytes: async () => next }, tools);
      expect(await objects(id)).toHaveLength(1);
    }

    const last = await sealedEnvelope({ id, version: 8, owner: mario });
    await uploadDoc({ id, now: dayOfVersion(8), ip: "203.0.113.9", bytes: async () => last }, tools);
    expect(await listed()).toEqual([6, 7, 8]);
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

  it("keeps everything replaced in the last seven days, however many", () => {
    const made = versionsAt("a", 0, 1, 2, 3, 4, 5, 6);
    expect(keptVersions(made, 7, LEVEL_ONE)).toHaveLength(7);
  });

  it("counts from when a version was replaced, and not from when it arrived", () => {
    const made = versionsAt("a", 0, 30 * DAY, 31 * DAY, 32 * DAY, 33 * DAY);
    const kept = keptVersions(made, 33 * DAY, LEVEL_ONE).map((one) => one.n);
    expect(kept).toEqual([1, 2, 3, 4, 5]);
    expect(keptVersions(made, 38 * DAY, LEVEL_ONE).map((one) => one.n)).toEqual([3, 4, 5]);
  });

  it("refuses past the list's size rather than letting evidence go", async () => {
    const id = await shared();
    const many = versionsAt(rootOf(mario), ...Array.from({ length: LIMITS.versionsListedAtMost }, (_, at) => NOW + at));
    await testEnv.DB.prepare("UPDATE docs SET latest = ?, versions = ? WHERE id = ?")
      .bind(many.length, JSON.stringify(many), id)
      .run();
    const bytes = await sealedEnvelope({ id, version: many.length + 1, owner: mario });
    expect(await send(id, bytes, LATER)).toEqual({ refused: "quota", until: NOW + 1 + 7 * DAY_MS });
  });

  it("says when a full list frees, and nothing while it has room", () => {
    const room = versionsAt("a", 0, 1, 2);
    expect(listFreesAt(room, 3, LEVEL_ONE)).toBeNull();
    const full = versionsAt("a", ...Array.from({ length: LEVEL_ONE.versionsListedAtMost }, (_, at) => at * 1000));
    expect(listFreesAt(full, 300_000, LEVEL_ONE)).toBe(1000 + 7 * DAY);
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
