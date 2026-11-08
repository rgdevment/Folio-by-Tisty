import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import type { Bytes } from "../src/core/bytes";
import { DAY_MS, LEVEL_ONE, type Limits } from "../src/core/limits";
import { saltFor, solveProof, startNow, toBase64Url } from "../src/core/start";
import { type FirstUpload, type UploadTools, uploadDoc, uploadFiles } from "../src/core/upload";
import { filesHashOf, newPerson, newToken, type Person, sealedEnvelope, TERMS_ACCEPTED } from "./sealed";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const SECRET = "a secret of the server";
const NOW = Date.UTC(2026, 10, 20, 12);
const LATER = NOW + 2 * DAY_MS;
const LIMITS: Limits = { ...LEVEL_ONE, proofBits: 2, sharesAtMost: 10 };
const IP = "203.0.113.9";

const toolsWith = (over: Partial<Limits> = {}): UploadTools => {
  const limits = { ...LIMITS, ...over };
  return {
    store: new Cloud(testEnv, limits),
    limits,
    secret: SECRET,
    sharingOpen: true,
    makerRoot: null,
    termsVersion: TERMS_ACCEPTED,
    limiter: { allows: async () => true },
    dayKey: async () => "a key for the day",
  };
};

const started = async (now = NOW): Promise<FirstUpload & { id: string }> => {
  const { id, mac } = await startNow(SECRET, now);
  const proof = await solveProof(await saltFor(SECRET, id, Math.floor(now / 3_600_000)), LIMITS.proofBits);
  return { id, start: mac, proof, adminToken: "the admin token", ttlDays: 3 };
};

const send = (to: UploadTools, id: string, bytes: Bytes, now = NOW, first?: FirstUpload, files?: string, ip = IP) =>
  uploadDoc({ id, now, ip, bytes: async () => bytes, ...(first ? { first } : {}), ...(files ? { files } : {}) }, to);

const sendFiles = (to: UploadTools, id: string, bytes: Bytes, now = NOW, ip = IP) =>
  uploadFiles({ id, now, ip, bytes: async () => bytes }, to);

const rooms = () =>
  testEnv.DB.prepare(
    "SELECT COALESCE(SUM(json_extract(versions, '$[#-1].bytes') + files_bytes), 0) AS held, COUNT(*) AS docs FROM docs WHERE latest > 0",
  ).first<{ held: number; docs: number }>();

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
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
});

describe("versions that arrive at once against the room of a key", () => {
  it("lets in exactly what fits when first versions of five documents race, and leaves nothing of the rest", async () => {
    for (let round = 0; round < 4; round += 1) {
      await beforeEachClean();
      const owner = await newPerson();
      const starts = await Promise.all([1, 2, 3, 4, 5].map(() => started()));
      const envelopes = await Promise.all(starts.map((one) => sealedEnvelope({ id: one.id, version: 1, owner })));
      const size = envelopes[0]?.length ?? 0;
      const to = toolsWith({ keyBytesAtMost: 2 * size + 10 });
      const answers = await Promise.all(starts.map((one, at) => send(to, one.id, envelopes[at] as Bytes, NOW, one)));
      expect(answers.filter((one) => "stored" in one)).toHaveLength(2);
      expect(answers.filter((one) => "refused" in one && one.refused === "room_full")).toHaveLength(3);
      expect(await rooms()).toEqual({ held: 2 * size, docs: 2 });
      expect((await testEnv.ENVELOPES.list()).objects).toHaveLength(2);
      const net = await testEnv.DB.prepare("SELECT docs, bytes FROM net_day WHERE net <> '~new-keys'").first<{
        docs: number;
        bytes: number;
      }>();
      expect(net).toEqual({ docs: 2, bytes: 2 * size });
      const left = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM docs").first<{ n: number }>();
      expect(left?.n, "a refused first version left a document behind").toBe(2);
    }
  });

  it("lets in exactly what fits when the next versions of three documents race", async () => {
    const owner = await newPerson();
    const plain = toolsWith();
    const docs = await Promise.all(
      [1, 2, 3].map(async () => {
        const first = await started();
        await send(plain, first.id, await sealedEnvelope({ id: first.id, version: 1, owner }), NOW, first);
        return first.id;
      }),
    );
    const small = (await rooms())?.held ?? 0;
    const bigger = await Promise.all(docs.map((id) => sealedEnvelope({ id, version: 2, owner, firstBytes: 4000 })));
    const grown = bigger[0]?.length ?? 0;
    const to = toolsWith({ keyBytesAtMost: 2 * grown + small / 3 });
    const answers = await Promise.all(docs.map((id, at) => send(to, id, bigger[at] as Bytes, LATER)));
    expect(answers.filter((one) => "stored" in one)).toHaveLength(2);
    expect(answers.filter((one) => "refused" in one && one.refused === "room_full")).toHaveLength(1);
    expect((await rooms())?.held).toBeLessThanOrEqual(2 * grown + small / 3);
    const objects = (await testEnv.ENVELOPES.list()).objects.length;
    expect(objects, "three first versions kept for their replacement, two new ones, none of the refused").toBe(5);
  });

  it("holds an editor's version and the owner's other documents to the same room", async () => {
    const owner = await newPerson();
    const editor = await newPerson();
    const { pair, permit } = await newToken();
    const plain = toolsWith();
    const one = await started();
    await send(plain, one.id, await sealedEnvelope({ id: one.id, version: 1, owner, permit }), NOW, one);
    const edited = await sealedEnvelope({
      id: one.id,
      version: 2,
      owner,
      signer: editor,
      permit,
      token: pair,
      firstBytes: 4000,
    });
    const two = await started();
    const fresh = await sealedEnvelope({ id: two.id, version: 1, owner, firstBytes: 4000 });
    const room = edited.length + fresh.length - 1;
    const to = toolsWith({ keyBytesAtMost: room });
    const answers = await Promise.all([send(to, one.id, edited, LATER), send(to, two.id, fresh, LATER, two)]);
    expect(answers.filter((one) => "stored" in one)).toHaveLength(1);
    expect((await rooms())?.held).toBeLessThanOrEqual(room);
  });

  it("does not let a refused race leave the network's counts higher than what was kept", async () => {
    const owner = await newPerson();
    const starts = await Promise.all([1, 2, 3].map(() => started()));
    const envelopes = await Promise.all(starts.map((one) => sealedEnvelope({ id: one.id, version: 1, owner })));
    const size = envelopes[0]?.length ?? 0;
    const to = toolsWith({ keyBytesAtMost: size + 5 });
    await Promise.all(starts.map((one, at) => send(to, one.id, envelopes[at] as Bytes, NOW, one)));
    const net = await testEnv.DB.prepare(
      "SELECT docs, bytes, uploads, keys FROM net_day WHERE net <> '~new-keys'",
    ).first();
    expect(net).toMatchObject({ docs: 1, bytes: size, uploads: 1 });
    const keys = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM keys").first<{ n: number }>();
    expect(keys?.n).toBe(1);
  });

  it("refuses the same bytes sent twice at once only once, not as a full room", async () => {
    const owner = await newPerson();
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner });
    const to = toolsWith({ keyBytesAtMost: bytes.length });
    const answers = await Promise.all([send(to, first.id, bytes, NOW, first), send(to, first.id, bytes, NOW, first)]);
    expect(answers.every((one) => "stored" in one)).toBe(true);
    expect((await rooms())?.docs).toBe(1);
    expect((await testEnv.ENVELOPES.list()).objects).toHaveLength(1);
  });

  it("does not charge a language kept alive by its anchor twice, nor the document being replaced", async () => {
    const owner = await newPerson();
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner });
    const next = await sealedEnvelope({ id: first.id, version: 2, owner });
    const to = toolsWith({ keyBytesAtMost: Math.max(bytes.length, next.length) });
    expect(await send(to, first.id, bytes, NOW, first)).toMatchObject({ stored: true });
    expect(await send(to, first.id, next, LATER)).toMatchObject({ stored: true });
  });
});

const beforeEachClean = async () => {
  const tables = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
    name: string;
  }>();
  for (const { name } of tables.results) {
    if (!name.startsWith("_") && !name.startsWith("sqlite") && !name.startsWith("d1_") && !name.startsWith("seen_"))
      await testEnv.DB.prepare(`DELETE FROM ${name}`).run();
  }
  const listed = await testEnv.ENVELOPES.list();
  if (listed.objects.length > 0) await testEnv.ENVELOPES.delete(listed.objects.map((one) => one.key));
};

describe("what only this key's documents hold", () => {
  it("lets a key in whose neighbour holds as much as its room, since rooms are not shared", async () => {
    const first = await newPerson();
    const second = await newPerson();
    const one = await started();
    const bytesOne = await sealedEnvelope({ id: one.id, version: 1, owner: first });
    const two = await started();
    const bytesTwo = await sealedEnvelope({ id: two.id, version: 1, owner: second });
    const to = toolsWith({ keyBytesAtMost: bytesOne.length });
    expect(await send(to, one.id, bytesOne, NOW, one)).toEqual({ stored: true, version: 1 });
    expect(await send(to, two.id, bytesTwo, NOW, two)).toEqual({ stored: true, version: 1 });
  });

  it("leaves no share and no count behind when the first version fails midway", async () => {
    const owner = await newPerson();
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner });
    const failing = new Proxy(testEnv.ENVELOPES, {
      get: (target, name) =>
        name === "put"
          ? async () => {
              throw new Error("R2 fails");
            }
          : Reflect.get(target, name).bind(target),
    });
    const to: UploadTools = {
      ...toolsWith(),
      store: new Cloud({ DB: testEnv.DB, ENVELOPES: failing }, LIMITS),
    };
    await expect(send(to, first.id, bytes, NOW, first)).rejects.toThrow("R2 fails");
    const left = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM docs").first<{ n: number }>();
    expect(left?.n, "a share was left holding a place of its key").toBe(0);
    const net = await testEnv.DB.prepare("SELECT docs FROM net_day WHERE net <> '~new-keys'").first<{ docs: number }>();
    expect(net?.docs ?? 0).toBe(0);
  });
});

describe("attachments of a key near its room", () => {
  const withFiles = async (owner: Person, size: number, to: UploadTools) => {
    const first = await started();
    await send(to, first.id, await sealedEnvelope({ id: first.id, version: 1, owner }), NOW, first);
    const files = await sealedEnvelope({ id: first.id, version: 2, owner, files: [size] });
    const hash = await filesHashOf(first.id, files);
    const main = await sealedEnvelope({ id: first.id, version: 2, owner });
    await send(to, first.id, main, LATER, undefined, hash);
    return { id: first.id, files, main };
  };

  it("lets in only what fits when two documents bring their attachments at once", async () => {
    const owner = await newPerson();
    const roomy = toolsWith();
    const a = await withFiles(owner, 4000, roomy);
    const b = await withFiles(owner, 4000, roomy);
    const room = a.main.length + b.main.length + a.files.length;
    const to = toolsWith({ keyBytesAtMost: room });
    const answers = await Promise.all([sendFiles(to, a.id, a.files, LATER), sendFiles(to, b.id, b.files, LATER)]);
    expect(answers.filter((one) => "stored" in one)).toHaveLength(1);
    expect(answers.filter((one) => "refused" in one && one.refused === "room_full")).toHaveLength(1);
    expect((await rooms())?.held, "two attachments together overfilled the key").toBeLessThanOrEqual(room);
  });

  it("does not ask storage again for files the last version kept, and still counts them", async () => {
    const owner = await newPerson();
    const to = toolsWith();
    const a = await withFiles(owner, 4000, to);
    expect(await sendFiles(to, a.id, a.files, LATER)).toMatchObject({ stored: true });
    const hash = await filesHashOf(a.id, a.files);
    const asked = vi.spyOn(to.store, "filesBytes");
    const next = await sealedEnvelope({ id: a.id, version: 3, owner });
    expect(await send(to, a.id, next, LATER + DAY_MS, undefined, hash)).not.toHaveProperty("refused");
    expect(asked, "only the answer's own check").toHaveBeenCalledTimes(1);
    expect((await rooms())?.held).toBe(next.length + a.files.length);
  });

  it("keeps the files a version found in storage and counted, though the room filled meanwhile", async () => {
    const owner = await newPerson();
    const to = toolsWith();
    const first = await started();
    await send(to, first.id, await sealedEnvelope({ id: first.id, version: 1, owner }), NOW, first);
    const files = await sealedEnvelope({ id: first.id, version: 2, owner, files: [4000] });
    const hash = await filesHashOf(first.id, files);
    await testEnv.ENVELOPES.put(`${first.id}/files.${hash}`, files);
    const main = await sealedEnvelope({ id: first.id, version: 2, owner });
    expect(await send(to, first.id, main, LATER, undefined, hash)).not.toHaveProperty("filesWanted");
    const kept = await new Cloud(testEnv, LIMITS).keepFiles(
      { id: first.id, hash, body: files, net: "a network", newKey: false, roomAtMost: 1 },
      Math.floor(LATER / DAY_MS),
    );
    expect(kept).toBe("stored");
    expect(
      await testEnv.ENVELOPES.head(`${first.id}/files.${hash}`),
      "the version's files were deleted",
    ).not.toBeNull();
  });

  it("refuses the second one when they come one after the other", async () => {
    const owner = await newPerson();
    const roomy = toolsWith();
    const a = await withFiles(owner, 4000, roomy);
    const b = await withFiles(owner, 4000, roomy);
    const to = toolsWith({ keyBytesAtMost: a.main.length + b.main.length + a.files.length });
    expect(await sendFiles(to, a.id, a.files, LATER)).toMatchObject({ stored: true });
    expect(await sendFiles(to, b.id, b.files, LATER)).toMatchObject({ refused: "room_full" });
  });

  describe("from a key the operator blocked", () => {
    const blocking = new CloudModeration(testEnv.DB);
    const rootOf = (person: Person): string => toBase64Url(person.rootBytes);

    it("takes nothing, from the owner or from an editor of its documents, and keeps nothing in R2", async () => {
      const owner = await newPerson();
      const editor = await newPerson();
      const { pair, permit } = await newToken();
      const to = toolsWith();
      const first = await started();
      await send(to, first.id, await sealedEnvelope({ id: first.id, version: 1, owner, permit }), NOW, first);
      const files = await sealedEnvelope({
        id: first.id,
        version: 2,
        owner,
        signer: editor,
        permit,
        token: pair,
        files: [64],
      });
      const hash = await filesHashOf(first.id, files);
      const main = await sealedEnvelope({ id: first.id, version: 2, owner, signer: editor, permit, token: pair });
      await send(to, first.id, main, LATER, undefined, hash);

      const spent = async () =>
        (await testEnv.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM net_day").first<{ n: number }>())?.n;
      const before = await spent();
      await blocking.blockKey(rootOf(owner), "abuse", NOW);
      expect(await sendFiles(to, first.id, files, LATER)).toEqual({ refused: "key_blocked" });
      await blocking.unblockKey(rootOf(owner), NOW);
      await blocking.blockKey(rootOf(editor), "abuse", NOW);
      expect(await sendFiles(to, first.id, files, LATER)).toEqual({ refused: "key_blocked" });
      expect((await testEnv.ENVELOPES.list({ prefix: `${first.id}/files.` })).objects).toEqual([]);
      expect(await spent(), "a refused attachment was charged to its network").toBe(before);
      await blocking.unblockKey(rootOf(editor), NOW);
      expect(await sendFiles(to, first.id, files, LATER)).toMatchObject({ stored: true });
    });

    it("answers that what is already kept is kept, since nothing is written", async () => {
      const owner = await newPerson();
      const to = toolsWith();
      const { id, files } = await withFiles(owner, 64, to);
      expect(await sendFiles(to, id, files, LATER)).toMatchObject({ stored: true });
      await blocking.blockKey(rootOf(owner), "abuse", NOW);
      expect(await sendFiles(to, id, files, LATER)).toMatchObject({ stored: true });
    });

    it("refuses before the hour is spent, so a blocked key cannot use up its network's uploads", async () => {
      const owner = await newPerson();
      const to = toolsWith({ uploadsAnHour: 1 });
      const { id, files } = await withFiles(owner, 64, toolsWith());
      await blocking.blockKey(rootOf(owner), "abuse", NOW);
      for (let at = 0; at < 3; at += 1)
        expect(await sendFiles(to, id, files, LATER)).toEqual({ refused: "key_blocked" });
    });

    it("does not stop a different key's attachments", async () => {
      const owner = await newPerson();
      const another = await newPerson();
      const to = toolsWith();
      const one = await withFiles(owner, 64, to);
      const two = await withFiles(another, 64, to);
      await blocking.blockKey(rootOf(owner), "abuse", NOW);
      expect(await sendFiles(to, one.id, one.files, LATER)).toEqual({ refused: "key_blocked" });
      expect(await sendFiles(to, two.id, two.files, LATER)).toMatchObject({ stored: true });
    });
  });

  describe("from a new key", () => {
    const newKeysBytes = () =>
      testEnv.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM net_day WHERE net = '~new-keys'").first<{
        bytes: number;
      }>();
    const netBytes = () =>
      testEnv.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM net_day WHERE net <> '~new-keys'").first<{
        bytes: number;
      }>();

    it("counts them once, however many times the same ones arrive at once", async () => {
      const owner = await newPerson();
      const { id, files } = await withFiles(owner, 64, toolsWith());
      const before = (await newKeysBytes())?.bytes ?? 0;
      const beforeNet = (await netBytes())?.bytes ?? 0;
      const to = toolsWith();
      await Promise.all([
        sendFiles(to, id, files, LATER),
        sendFiles(to, id, files, LATER),
        sendFiles(to, id, files, LATER),
      ]);
      expect((await newKeysBytes())?.bytes, "new keys' bytes charged more than once for one attachment").toBe(
        before + files.length,
      );
      expect((await netBytes())?.bytes, "the network's bytes charged more than once for one attachment").toBe(
        beforeNet + files.length,
      );
    });

    it("does not count them again for a key of more than 30 days, nor when sent a second time", async () => {
      const owner = await newPerson();
      const to = toolsWith();
      const { id, files } = await withFiles(owner, 64, to);
      await testEnv.DB.prepare("UPDATE keys SET first_day = first_day - ?")
        .bind(LIMITS.daysAKeyIsNew + 1)
        .run();
      const before = (await newKeysBytes())?.bytes ?? 0;
      expect(await sendFiles(to, id, files, LATER)).toMatchObject({ stored: true });
      expect((await newKeysBytes())?.bytes).toBe(before);
    });

    it("counts them for a key that is new, the first time, and leaves its network's own count as bytes", async () => {
      const owner = await newPerson();
      const to = toolsWith();
      const { id, files } = await withFiles(owner, 64, to);
      const before = (await newKeysBytes())?.bytes ?? 0;
      expect(await sendFiles(to, id, files, LATER)).toMatchObject({ stored: true });
      expect((await newKeysBytes())?.bytes).toBe(before + files.length);
    });

    it("counts an editor who is new as new too, though the owner is old", async () => {
      const owner = await newPerson();
      const editor = await newPerson();
      const { pair, permit } = await newToken();
      const to = toolsWith();
      const first = await started();
      await send(to, first.id, await sealedEnvelope({ id: first.id, version: 1, owner, permit }), NOW, first);
      await testEnv.DB.prepare("UPDATE keys SET first_day = first_day - ?")
        .bind(LIMITS.daysAKeyIsNew + 1)
        .run();
      const files = await sealedEnvelope({
        id: first.id,
        version: 2,
        owner,
        signer: editor,
        permit,
        token: pair,
        files: [64],
      });
      const main = await sealedEnvelope({ id: first.id, version: 2, owner, signer: editor, permit, token: pair });
      await send(to, first.id, main, LATER, undefined, await filesHashOf(first.id, files));
      const before = (await newKeysBytes())?.bytes ?? 0;
      expect(await sendFiles(to, first.id, files, LATER)).toMatchObject({ stored: true });
      expect((await newKeysBytes())?.bytes).toBe(before + files.length);
    });

    it("refuses its attachments past its network's share, as the terms say, and keeps nothing of them", async () => {
      const owner = await newPerson();
      const first = await started();
      const probe = await sealedEnvelope({ id: first.id, version: 1, owner });
      const files = await sealedEnvelope({ id: first.id, version: 2, owner, files: [4000] });
      const to = toolsWith({ newKeysNetBytesADay: probe.length + 600 });
      await send(to, first.id, probe, NOW, first);
      const main = await sealedEnvelope({ id: first.id, version: 2, owner });
      expect(await send(to, first.id, main, LATER, undefined, await filesHashOf(first.id, files))).toMatchObject({
        stored: true,
      });
      expect(await sendFiles(to, first.id, files, LATER)).toEqual({ refused: "uploads_off" });
    });
  });
});
