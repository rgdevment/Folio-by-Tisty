import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { load } from "js-yaml";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import written from "../docs/openapi.yaml?raw";
import { CloudModeration } from "../src/cloudflare/moderation";
import { Cloud } from "../src/cloudflare/store";
import { type Bytes, words } from "../src/core/bytes";
import { dayOf, LEVEL_ONE, REPORT_CATEGORIES } from "../src/core/limits";
import { SEALED_CONTACT_AT_MOST } from "../src/core/sealed-link";
import { hourOf, macOf, proofHolds, toBase64Url, tokenHash } from "../src/core/start";
import { STATUS } from "../src/private/api";
import worker from "../src/private/index";
import {
  filesHashOf,
  machineOf,
  newPerson,
  type Person,
  revocationBy,
  rootOf,
  SIGNED_BY_THE_OWNER,
  sealedEnvelope,
} from "./sealed";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const store = new Cloud(testEnv);
const TODAY = dayOf(Date.now());
const ID = "AbCdEfGh";
const ANCHOR = "AAAAAAAA";
const TOKEN = "the admin token";

// biome-ignore lint/suspicious/noExplicitAny: the shape of an OpenAPI file is what this test looks through.
type Written = any;
const spec = load(written) as Written;

const resolved = (node: Written): Written => {
  if (!node?.$ref) return node;
  return (node.$ref as string)
    .slice(2)
    .split("/")
    .reduce((at, key) => at[key], spec);
};

const refusalsIn = (schema: Written): string[] => {
  const plain = resolved(schema);
  if (plain.oneOf) return plain.oneOf.flatMap(refusalsIn);
  const refused = plain.properties?.refused;
  if (!refused) return [];
  return refused.const ? [refused.const] : refused.enum;
};

const documented = (method: string, path: string, status: number): Written =>
  resolved(spec.paths[path]?.[method.toLowerCase()]?.responses?.[status]);

// The body against its schema: what it requires is there, nothing else is, and fixed values are those values.
const fits = (body: Written, schema: Written): boolean => {
  const plain = resolved(schema);
  if (plain.oneOf) return plain.oneOf.some((one: Written) => fits(body, one));
  const known = plain.properties ?? {};
  return (
    (plain.required ?? []).every((key: string) => key in body) &&
    Object.keys(body).every((key) => key in known && (!("const" in known[key]) || known[key].const === body[key]))
  );
};

interface Scenario {
  method: string;
  path: string;
  status: number;
  refused?: string;
  admin?: string;
  caseToken?: string;
  body?: string;
  braked?: boolean;
  broken?: boolean;
  ready?: () => Promise<unknown>;
  solves?: boolean;
  times?: number;
  upload?: () => Promise<Bytes>;
  first?: boolean;
  anchor?: string;
  said?: object;
}

const send = async (
  { method, path, admin, caseToken, body, braked, broken, upload, first, anchor }: Scenario,
  proof?: string,
  ip?: string,
) => {
  const context = createExecutionContext();
  const headers = new Headers({ "CF-Connecting-IP": ip ?? "198.51.100.77" });
  if (first) {
    headers.set("Folio-Start", await macOf("09".repeat(32), `start|${ID}|${hourOf(Date.now())}`));
    headers.set("Folio-Ttl-Days", "3");
  }
  if (anchor) headers.set("Folio-Anchor", anchor);
  if (admin) headers.set("Folio-Admin", admin);
  if (caseToken) headers.set("Folio-Case", caseToken);
  if (proof) headers.set("Folio-Proof", proof);
  const limit = async () => {
    if (broken) throw new Error("broken on purpose");
    return { success: !braked };
  };
  const url = `https://tisty.cl/api/v1${path.replace("{id}", ID).replace("{hash}", NAMED_FILES)}`;
  const response = await worker.fetch(
    new Request(url, {
      method,
      headers,
      ...(upload ? { body: await upload() } : body === undefined ? {} : { body }),
    }) as Request<unknown, IncomingRequestCfProperties>,
    { ...testEnv, FOLIO_SECRET: "09".repeat(32), READS: { limit }, SYNCS: { limit }, REPORTS: { limit } } as never,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
};

const NAMED_FILES = "F".repeat(43);

const share = async () => {
  await store.create({ id: ID, owner: "o1", adminHash: await tokenHash(TOKEN), ttlDays: 3, net: "n" }, TODAY);
  await store.upload({ ...SIGNED_BY_THE_OWNER, id: ID, n: 1, hash: "h1", body: "sealed", net: "n", at: 1234 }, TODAY);
};

const block = async () => {
  await share();
  await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(TODAY).run();
};

const pause = async () => {
  await share();
  await store.pause(ID, TODAY);
};

const pastTheFreeReaders = async () => {
  await share();
  await testEnv.DB.prepare(
    `CREATE TABLE seen_${TODAY} (owner TEXT, reader TEXT, doc TEXT, hour INTEGER, PRIMARY KEY (owner, reader, doc)) WITHOUT ROWID`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO seen_${TODAY} WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     SELECT 'o1', 'r' || i, '${ID}', 9 FROM n`,
  )
    .bind(LEVEL_ONE.newReadersFree)
    .run();
};

let owner: Person;
let stranger: Person;

const envelope =
  (version: number, who = (): Person => owner) =>
  () =>
    sealedEnvelope({ id: ID, version, owner: who() });
const shareSigned = async () => {
  const bytes = await sealedEnvelope({ id: ID, version: 1, owner });
  const asOwner = {
    ...SIGNED_BY_THE_OWNER,
    id: ID,
    n: 1,
    hash: "h1",
    body: bytes,
    net: "n",
    at: Date.now() - 86_400_000,
    signer: rootOf(owner),
    machine: machineOf(owner),
  };
  await store.create({ id: ID, owner: rootOf(owner), adminHash: await tokenHash(TOKEN), ttlDays: 3, net: "n" }, TODAY);
  await store.upload(asOwner, TODAY);
};
const LISTED_FULL = LEVEL_ONE.versionsListedAtMost;
const listFull = async () => {
  await shareSigned();
  const listed = Array.from({ length: LISTED_FULL }, (_, at) => ({
    n: at + 1,
    hash: `h${at + 1}`,
    bytes: 1,
    at: Date.now() - 86_400_000,
    signer: "someone else",
    machine: "another machine",
    contract: "1.2.0",
  }));
  await testEnv.DB.prepare(`UPDATE docs SET latest = ?, versions = ? WHERE id = '${ID}'`)
    .bind(LISTED_FULL, JSON.stringify(listed))
    .run();
};
const keepsAsManyAsTheyMay = async () => {
  LEVEL_ONE.sharesAtMost = 2;
  for (const id of ["AAAAAAAA", "BBBBBBBB"]) {
    await store.create({ id, owner: rootOf(owner), adminHash: "a", ttlDays: 3, net: "n" }, TODAY);
  }
};
const keepsAsManyLanguagesAsTheyMay = async () => {
  const doc = { owner: rootOf(owner), adminHash: "a", ttlDays: 3, net: "n" };
  await store.create({ ...doc, id: ANCHOR }, TODAY);
  for (let n = 1; n < LEVEL_ONE.languagesAtMost; n += 1) {
    await store.create({ ...doc, id: `language${n}`, anchor: ANCHOR }, TODAY);
  }
};
const noUploads = async () => {
  await store.setStage("no_uploads");
};
const namingFiles = async (hash: string) => {
  await testEnv.DB.prepare(`UPDATE docs SET versions = json_set(versions, '$[#-1].files', ?) WHERE id = '${ID}'`)
    .bind(hash)
    .run();
};
const shareWithFiles = async () => {
  await share();
  await namingFiles(NAMED_FILES);
  await testEnv.ENVELOPES.put(`${ID}/files.${NAMED_FILES}`, "sealed files");
};
const filesPause = async () => {
  await shareWithFiles();
  await store.pause(ID, TODAY);
};
const filesBlock = async () => {
  await shareWithFiles();
  await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(TODAY).run();
};
let sentFiles: Bytes;
const filesEnvelope = async () => sentFiles;
const shareNamingSentFiles = async (who = (): Person => owner) => {
  sentFiles = await sealedEnvelope({ id: ID, version: 1, owner: who(), files: [16] });
  await shareSigned();
  await namingFiles(await filesHashOf(ID, sentFiles));
};
const CASE_TOKEN = "T".repeat(43);
const caseOpens = async () => {
  await testEnv.DB.prepare(
    "INSERT OR REPLACE INTO cases (token_hash, doc, version, until, sealed_records) VALUES (?, ?, 1, ?, ?)",
  )
    .bind(await tokenHash(CASE_TOKEN), ID, TODAY + 1, "case1.abc")
    .run();
};
const blockedCase = async () => {
  await block();
  await caseOpens();
};
const blockedCaseWithFiles = async () => {
  await shareWithFiles();
  await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(TODAY).run();
  await caseOpens();
};
const caseRoute = (path: string, ready: () => Promise<void>): Scenario[] => [
  { method: "GET", path, status: 200, caseToken: CASE_TOKEN, ready },
  { method: "GET", path, status: 404, refused: "missing", caseToken: "U".repeat(43), ready },
  { method: "GET", path, status: 429, refused: "slow", caseToken: CASE_TOKEN, braked: true },
  { method: "GET", path, status: 500, refused: "failed", caseToken: CASE_TOKEN, broken: true },
];

const PERMIT = JSON.stringify({ permit: "A".repeat(43) });
const UPLOAD_PATH = "/docs/{id}";
const LATEST_PATH = "/docs/{id}/latest";
const FILES_PATH = "/docs/{id}/files";
const NAMED_FILES_PATH = "/docs/{id}/files/{hash}";
const PERMIT_PATH = "/docs/{id}/permit";

const REPORT = JSON.stringify({ category: "phishing", detail: "imita a un banco" });
const REPORT_PATH = "/docs/{id}/report";
const APPEAL_PATH = "/docs/{id}/appeal";

const adminRoute = (method: string, path: string, blockable = true): Scenario[] => [
  { method, path, status: 200, admin: TOKEN, ready: share },
  ...(blockable ? [{ method, path, status: 403, refused: "blocked", admin: TOKEN, ready: block }] : []),
  { method, path, status: 404, refused: "missing", admin: "wrong", ready: share },
  { method, path, status: 429, refused: "slow", admin: TOKEN, braked: true },
  { method, path, status: 500, refused: "failed", admin: TOKEN, broken: true },
];

const REVOCATIONS_PATH = "/revocations";
const aRevocation = async () => words(JSON.stringify([await revocationBy(owner, "2026-11-01T10:00:00Z")]));
const FILES: Scenario[] = [
  { method: "GET", path: NAMED_FILES_PATH, status: 200, ready: shareWithFiles },
  { method: "GET", path: NAMED_FILES_PATH, status: 403, refused: "blocked", ready: filesBlock },
  { method: "GET", path: NAMED_FILES_PATH, status: 403, refused: "paused", ready: filesPause },
  { method: "GET", path: NAMED_FILES_PATH, status: 404, refused: "missing", ready: share },
  {
    method: "GET",
    path: NAMED_FILES_PATH,
    status: 426,
    refused: "outdated",
    ready: async () => {
      await shareWithFiles();
      LEVEL_ONE.oldestContractServed = "9.0.0";
    },
  },
  { method: "GET", path: NAMED_FILES_PATH, status: 429, refused: "slow", braked: true },
  { method: "GET", path: NAMED_FILES_PATH, status: 429, refused: "proof", ready: pastTheFreeReaders },
  { method: "GET", path: NAMED_FILES_PATH, status: 500, refused: "failed", broken: true },
  { method: "PUT", path: FILES_PATH, status: 200, upload: filesEnvelope, ready: shareNamingSentFiles },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 409,
    refused: "room_full",
    upload: filesEnvelope,
    ready: async () => {
      await shareNamingSentFiles();
      LEVEL_ONE.keyBytesAtMost = 0;
    },
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 403,
    refused: "blocked",
    upload: filesEnvelope,
    ready: async () => {
      await shareNamingSentFiles();
      await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(TODAY).run();
    },
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 403,
    refused: "paused",
    upload: filesEnvelope,
    ready: async () => {
      await shareNamingSentFiles();
      await store.pause(ID, TODAY);
    },
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 403,
    refused: "key_blocked",
    upload: filesEnvelope,
    ready: async () => {
      await shareNamingSentFiles();
      await store.keepKeys([toBase64Url(owner.rootBytes)], TODAY);
      await new CloudModeration(testEnv.DB).blockKey(toBase64Url(owner.rootBytes), "abuse", Date.now());
    },
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 403,
    refused: "not_yours",
    upload: filesEnvelope,
    ready: () => shareNamingSentFiles(() => stranger),
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 403,
    refused: "revoked",
    upload: filesEnvelope,
    ready: async () => {
      await shareNamingSentFiles();
      await store.revoke([await revocationBy(owner, "2026-11-01T10:00:00Z")]);
    },
  },
  { method: "PUT", path: FILES_PATH, status: 404, refused: "missing", upload: async () => new Uint8Array(8) },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 409,
    refused: "behind",
    upload: () => sealedEnvelope({ id: ID, version: 1, owner, files: [16] }),
    ready: shareSigned,
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 413,
    refused: "too_big",
    upload: async () => new Uint8Array(LEVEL_ONE.filesBytesAtMost + 40_000),
    ready: shareSigned,
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 422,
    refused: "envelope",
    upload: async () => new Uint8Array(8),
    ready: shareSigned,
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 426,
    refused: "outdated",
    upload: filesEnvelope,
    ready: async () => {
      await shareNamingSentFiles();
      LEVEL_ONE.oldestContractTaken = "9.0.0";
    },
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 429,
    refused: "slow",
    upload: async () => new Uint8Array(8),
    braked: true,
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 429,
    refused: "quota",
    upload: filesEnvelope,
    ready: async () => {
      await shareNamingSentFiles();
      LEVEL_ONE.uploadsAnHour = 0;
    },
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 500,
    refused: "failed",
    upload: async () => new Uint8Array(8),
    broken: true,
  },
  {
    method: "PUT",
    path: FILES_PATH,
    status: 503,
    refused: "uploads_off",
    upload: async () => new Uint8Array(8),
    ready: noUploads,
  },
];

const UPLOADING: Scenario[] = [
  { method: "POST", path: REVOCATIONS_PATH, status: 200, upload: aRevocation, ready: shareSigned },
  { method: "POST", path: REVOCATIONS_PATH, status: 400, refused: "bad_revocation", body: "[]" },
  { method: "POST", path: REVOCATIONS_PATH, status: 413, refused: "too_big", body: "x".repeat(9000) },
  { method: "POST", path: REVOCATIONS_PATH, status: 429, refused: "slow", upload: aRevocation, braked: true },
  {
    method: "POST",
    path: REVOCATIONS_PATH,
    status: 409,
    refused: "machines_full",
    upload: aRevocation,
    ready: async () => {
      await shareSigned();
      const others = Array.from({ length: LEVEL_ONE.revokedMachinesAtMost }, () =>
        revocationBy({ ...owner, machineBytes: crypto.getRandomValues(new Uint8Array(32)) }, "2026-11-01T10:00:00Z"),
      );
      await store.revoke(await Promise.all(others));
    },
  },
  {
    method: "POST",
    path: REVOCATIONS_PATH,
    status: 429,
    refused: "quota",
    upload: aRevocation,
    ready: async () => {
      await shareSigned();
      LEVEL_ONE.revocationsAnHour = 1;
      await send({ method: "POST", path: REVOCATIONS_PATH, status: 200, upload: aRevocation });
    },
  },
  { method: "POST", path: REVOCATIONS_PATH, status: 500, refused: "failed", upload: aRevocation, broken: true },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 403,
    refused: "revoked",
    upload: envelope(2),
    ready: async () => {
      await shareSigned();
      await store.revoke([await revocationBy(owner, "2026-11-01T10:00:00Z")]);
    },
  },
  { method: "PUT", path: UPLOAD_PATH, status: 200, upload: envelope(2), ready: shareSigned },
  { method: "PUT", path: UPLOAD_PATH, status: 400, refused: "bad_upload", upload: envelope(1), first: true, admin: "" },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 403,
    refused: "not_yours",
    upload: envelope(2, () => stranger),
    ready: shareSigned,
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 403,
    refused: "blocked",
    upload: envelope(2),
    ready: async () => {
      await shareSigned();
      await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(TODAY).run();
    },
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 403,
    refused: "paused",
    upload: envelope(2),
    ready: async () => {
      await shareSigned();
      await store.pause(ID, TODAY);
    },
  },
  { method: "PUT", path: UPLOAD_PATH, status: 404, refused: "missing", upload: envelope(1) },
  { method: "PUT", path: UPLOAD_PATH, status: 409, refused: "behind", upload: envelope(5), ready: shareSigned },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 413,
    refused: "too_big",
    upload: async () => new Uint8Array(LEVEL_ONE.envelopeBytesAtMost + 1),
    ready: shareSigned,
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 422,
    refused: "envelope",
    upload: async () => new Uint8Array(8),
    ready: shareSigned,
  },
  { method: "PUT", path: UPLOAD_PATH, status: 429, refused: "slow", upload: envelope(1), braked: true },
  { method: "PUT", path: UPLOAD_PATH, status: 429, refused: "proof", upload: envelope(1), first: true, admin: TOKEN },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 429,
    refused: "quota",
    upload: envelope(LISTED_FULL + 1),
    ready: listFull,
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 429,
    refused: "shares_today",
    upload: envelope(1),
    first: true,
    admin: TOKEN,
    solves: true,
    ready: async () => {
      LEVEL_ONE.newSharesADay = 0;
    },
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 409,
    refused: "shares_full",
    upload: envelope(1),
    first: true,
    admin: TOKEN,
    solves: true,
    ready: keepsAsManyAsTheyMay,
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 409,
    refused: "room_full",
    upload: envelope(1),
    first: true,
    admin: TOKEN,
    solves: true,
    ready: async () => {
      LEVEL_ONE.keyBytesAtMost = 0;
    },
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 403,
    refused: "key_blocked",
    upload: envelope(2),
    ready: async () => {
      await shareSigned();
      await store.keepKeys([toBase64Url(owner.rootBytes)], TODAY);
      await new CloudModeration(testEnv.DB).blockKey(toBase64Url(owner.rootBytes), "abuse", Date.now());
    },
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 409,
    refused: "languages_full",
    upload: envelope(1),
    first: true,
    anchor: ANCHOR,
    admin: TOKEN,
    solves: true,
    ready: keepsAsManyLanguagesAsTheyMay,
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 428,
    refused: "terms",
    upload: () => sealedEnvelope({ id: ID, version: 2, owner, terms: "0" }),
    ready: shareSigned,
  },
  {
    method: "PUT",
    path: UPLOAD_PATH,
    status: 426,
    refused: "outdated",
    upload: envelope(2),
    ready: async () => {
      await shareSigned();
      LEVEL_ONE.oldestContractTaken = "9.0.0";
    },
  },
  {
    method: "GET",
    path: "/docs/{id}",
    status: 426,
    refused: "outdated",
    ready: async () => {
      await share();
      LEVEL_ONE.oldestContractServed = "9.0.0";
    },
  },
  {
    method: "GET",
    path: LATEST_PATH,
    status: 426,
    refused: "outdated",
    ready: async () => {
      await share();
      LEVEL_ONE.oldestContractServed = "9.0.0";
    },
  },
  { method: "PUT", path: UPLOAD_PATH, status: 500, refused: "failed", upload: envelope(1), broken: true },
  { method: "PUT", path: UPLOAD_PATH, status: 503, refused: "uploads_off", upload: envelope(1), ready: noUploads },
  { method: "GET", path: LATEST_PATH, status: 200, ready: share },
  { method: "GET", path: LATEST_PATH, status: 403, refused: "paused", ready: pause },
  { method: "GET", path: LATEST_PATH, status: 403, refused: "blocked", ready: block },
  { method: "GET", path: LATEST_PATH, status: 404, refused: "missing" },
  { method: "GET", path: LATEST_PATH, status: 429, refused: "slow", braked: true },
  { method: "GET", path: LATEST_PATH, status: 500, refused: "failed", broken: true },
  { method: "PUT", path: PERMIT_PATH, status: 200, admin: TOKEN, body: PERMIT, ready: share },
  { method: "PUT", path: PERMIT_PATH, status: 400, refused: "bad_upload", admin: TOKEN, body: "{}", ready: share },
  { method: "PUT", path: PERMIT_PATH, status: 403, refused: "blocked", admin: TOKEN, body: PERMIT, ready: block },
  { method: "PUT", path: PERMIT_PATH, status: 404, refused: "missing", admin: "wrong", body: PERMIT, ready: share },
  { method: "PUT", path: PERMIT_PATH, status: 429, refused: "slow", admin: TOKEN, body: PERMIT, braked: true },
  { method: "PUT", path: PERMIT_PATH, status: 500, refused: "failed", admin: TOKEN, body: PERMIT, broken: true },
];

const SCENARIOS: Scenario[] = [
  ...caseRoute("/cases/{id}", blockedCase),
  ...caseRoute("/cases/{id}/records", blockedCase),
  ...caseRoute("/cases/{id}/files/{hash}", blockedCaseWithFiles),
  ...FILES,
  ...UPLOADING,
  { method: "POST", path: "/start", status: 200 },
  { method: "POST", path: "/start", status: 429, refused: "slow", braked: true },
  { method: "POST", path: "/start", status: 500, refused: "failed", broken: true },
  { method: "GET", path: "/docs/{id}", status: 200, ready: share },
  { method: "GET", path: "/docs/{id}", status: 403, refused: "blocked", ready: block },
  { method: "GET", path: "/docs/{id}", status: 403, refused: "paused", ready: pause },
  { method: "GET", path: "/docs/{id}", status: 404, refused: "missing" },
  { method: "GET", path: "/docs/{id}", status: 429, refused: "slow", braked: true },
  { method: "GET", path: "/docs/{id}", status: 429, refused: "proof", ready: pastTheFreeReaders },
  { method: "GET", path: "/docs/{id}", status: 500, refused: "failed", broken: true },
  ...adminRoute("DELETE", "/docs/{id}"),
  { method: "POST", path: REPORT_PATH, status: 202, body: REPORT, solves: true, ready: share },
  { method: "POST", path: REPORT_PATH, status: 400, refused: "bad_report", body: "{}" },
  { method: "POST", path: REPORT_PATH, status: 413, refused: "too_big", body: "x".repeat(20_000) },
  { method: "POST", path: REPORT_PATH, status: 429, refused: "proof", body: REPORT },
  { method: "POST", path: REPORT_PATH, status: 429, refused: "slow", body: REPORT, braked: true },
  {
    method: "POST",
    path: REPORT_PATH,
    status: 429,
    refused: "quota",
    body: REPORT,
    solves: true,
    times: LEVEL_ONE.reportsAnHour + 1,
    ready: share,
  },
  {
    method: "POST",
    path: REPORT_PATH,
    status: 500,
    refused: "failed",
    body: JSON.stringify({ category: "csam", detail: "imita a un banco", sealedLink: `sealed1.${"A".repeat(150)}` }),
    solves: true,
    ready: async () => {
      await share();
      vi.spyOn(Cloud.prototype, "report").mockRejectedValueOnce(new Error("no database"));
    },
  },
  ...adminRoute("GET", "/docs/{id}/admin", false),
  ...adminRoute("POST", "/docs/{id}/pause"),
  ...adminRoute("POST", "/docs/{id}/resume"),
  { method: "POST", path: APPEAL_PATH, status: 200, admin: TOKEN, ready: block },
  { method: "POST", path: APPEAL_PATH, status: 404, refused: "missing", admin: "wrong", ready: block },
  { method: "POST", path: APPEAL_PATH, status: 409, refused: "not_blocked", admin: TOKEN, ready: share },
  {
    method: "POST",
    path: APPEAL_PATH,
    status: 409,
    refused: "appealed",
    admin: TOKEN,
    ready: async () => {
      await block();
      await send({ method: "POST", path: APPEAL_PATH, status: 200, admin: TOKEN });
    },
  },
  { method: "POST", path: APPEAL_PATH, status: 429, refused: "slow", admin: TOKEN, braked: true },
  { method: "POST", path: APPEAL_PATH, status: 500, refused: "failed", admin: TOKEN, broken: true },
];

const operations = (): [string, string, Written][] =>
  Object.entries(spec.paths as Written).flatMap(([path, item]) =>
    Object.entries(item as Written)
      .filter(([method]) => method !== "parameters")
      .map(([method, operation]): [string, string, Written] => [method.toUpperCase(), path, operation]),
  );

const writtenAnswers = (): string[] =>
  operations().flatMap(([method, path, operation]) =>
    Object.keys(operation.responses).map((status) => `${method} ${path} ${status}`),
  );

const writtenRefusals = (): string[] =>
  operations().flatMap(([method, path, operation]) =>
    Object.entries(operation.responses as Written).flatMap(([status, response]) => {
      const schema = resolved(response).content?.["application/json"]?.schema;
      return schema ? refusalsIn(schema).map((refused) => `${method} ${path} ${status} ${refused}`) : [];
    }),
  );

const solve = async (salt: string, bits: number): Promise<string> => {
  for (let nonce = 0; ; nonce += 1) {
    if (await proofHolds(salt, String(nonce), bits)) return String(nonce);
  }
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  LEVEL_ONE.oldestContractTaken = null;
  LEVEL_ONE.oldestContractServed = null;
  LEVEL_ONE.revocationsAnHour = 30;
  LEVEL_ONE.newSharesADay = 10;
  LEVEL_ONE.sharesAtMost = 20;
  LEVEL_ONE.uploadsAnHour = 60;
  LEVEL_ONE.keyBytesAtMost = 25_000_000;
  for (const table of [
    "docs",
    "keys",
    "net_day",
    "net_hour",
    "reports",
    "holds",
    "service_stage",
    "revocations",
    "editors",
  ]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const tables = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'seen_[0-9]*'").all<{
    name: string;
  }>();
  for (const { name } of tables.results) await testEnv.DB.prepare(`DROP TABLE ${name}`).run();
  const held = await testEnv.ENVELOPES.list();
  if (held.objects.length > 0) await testEnv.ENVELOPES.delete(held.objects.map((one) => one.key));
});

describe("the brake of a report", () => {
  const reporting = async (reads: boolean, reporting: boolean, ip = "198.51.100.77") => {
    const limitOf = (success: boolean) => vi.fn(async (_: { key: string }) => ({ success }));
    const REPORTS = limitOf(reporting);
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://tisty.cl/api/v1/docs/${ID}/report`, {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
        body: REPORT,
      }) as Request<unknown, IncomingRequestCfProperties>,
      {
        ...testEnv,
        FOLIO_SECRET: "09".repeat(32),
        READS: { limit: limitOf(reads) },
        REPORTS: { limit: REPORTS },
      } as never,
      context,
    );
    await waitOnExecutionContext(context);
    return { said: (await response.json()) as { refused: string }, key: REPORTS.mock.calls[0]?.[0].key };
  };

  it("is its own, and neither binding stands in for the other", async () => {
    expect((await reporting(false, true)).said.refused).toBe("proof");
    expect((await reporting(true, false)).said.refused).toBe("slow");
  });

  it("is asked by the network's digest, never by its address", async () => {
    const { key } = await reporting(true, true);
    expect(key).not.toContain("198.51.100.77");
    expect((await reporting(true, true)).key).toBe(key);
    expect((await reporting(true, true, "198.51.100.78")).key).not.toBe(key);
  });
});

describe("the written API", () => {
  beforeAll(async () => {
    owner = await newPerson();
    stranger = await newPerson();
  });

  it("has a scenario here for every answer it promises, and the other way around", () => {
    const tried = SCENARIOS.map(({ method, path, status }) => `${method} ${path} ${status}`);
    expect(new Set(tried)).toEqual(new Set(writtenAnswers()));
  });

  it("has a scenario here for every refusal each route promises, and the other way around", () => {
    const tried = SCENARIOS.filter((one) => one.refused).map(
      ({ method, path, status, refused }) => `${method} ${path} ${status} ${refused}`,
    );
    expect(new Set(tried)).toEqual(new Set(writtenRefusals()));
  });

  it.each(SCENARIOS)("$method $path answers $status $refused as written", async (scenario) => {
    const { method, path, status, refused, ready, solves, times = 1 } = scenario;
    await ready?.();
    let response = await send(scenario);
    if (solves) {
      const { salt, bits } = (await response.json()) as { salt: string; bits: number };
      const proof = await solve(salt, bits);
      for (let n = 0; n < times; n += 1) response = await send(scenario, proof);
    }
    expect(response.status).toBe(status);

    const promised = documented(method, path, status);
    expect(promised).toBeTruthy();
    expect(Object.keys(promised.content)).toContain(response.headers.get("Content-Type"));
    for (const [name, header] of Object.entries(promised.headers ?? {}) as [string, Written][]) {
      if (resolved(header).required) expect(response.headers.has(name)).toBe(true);
    }
    if (response.headers.has("Retry-After")) expect(promised.headers).toHaveProperty("Retry-After");

    const schema = promised.content["application/json"]?.schema;
    if (!schema) return;
    const body = (await response.json()) as Written;
    expect(fits(body, schema)).toBe(true);
    expect(body.refused).toBe(refused);
  });

  it("names every refusal the Worker has, and no other", () => {
    const named = Object.values(spec.components.schemas as Written).flatMap((schema) => refusalsIn(schema));
    expect(new Set(named)).toEqual(new Set(Object.keys(STATUS)));
  });

  it("gives the numbers the rules give", () => {
    const report = spec.components.schemas.Report.properties;
    expect(report.category.enum).toEqual(REPORT_CATEGORIES);
    expect(report.detail.maxLength).toBe(LEVEL_ONE.reportDetailAtMost);
    expect(report.sealedLink.maxLength).toBe(LEVEL_ONE.sealedLinkAtMost);
    expect(report.sealedContact.maxLength).toBe(SEALED_CONTACT_AT_MOST);
  });

  it("tells a reader what was taken back, in its header", async () => {
    await shareSigned();
    const said = await revocationBy(owner, "2026-11-01T10:00:00Z");
    await store.revoke([said]);
    const response = await send({ method: "GET", path: "/docs/{id}", status: 200 });
    await response.body?.cancel();
    expect(JSON.parse(response.headers.get("Folio-Revocations") ?? "null")).toEqual([said]);
  });

  it("says on latest when the next version is taken, while the wait runs", async () => {
    await store.create({ id: ID, owner: "o1", adminHash: await tokenHash(TOKEN), ttlDays: 3, net: "n" }, TODAY);
    const at = Date.now();
    await store.upload({ ...SIGNED_BY_THE_OWNER, id: ID, n: 1, hash: "h1", body: "sealed", net: "n", at }, TODAY);
    const latest = await send({ method: "GET", path: LATEST_PATH, status: 200 });
    expect(await latest.json()).toEqual({ version: 1, hash: "h1", nextAt: at + 5 * 60_000 });
  });

  it("serves through the last day to correct, stops after it, and a new version lifts it", async () => {
    await shareSigned();
    const fixBy = (day: number) => testEnv.DB.prepare(`UPDATE docs SET fix_by = ? WHERE id = '${ID}'`).bind(day).run();
    await fixBy(TODAY);
    const lastDay = await send({ method: "GET", path: "/docs/{id}", status: 200 });
    await lastDay.body?.cancel();
    expect(lastDay.status).toBe(200);
    await fixBy(TODAY - 1);
    const read = await send({ method: "GET", path: "/docs/{id}", status: 403 });
    expect(await read.json()).toEqual({ refused: "blocked" });
    const latest = await send({ method: "GET", path: LATEST_PATH, status: 200 });
    const said = (await latest.json()) as object;
    expect(said).toMatchObject({ version: 1 });
    expect(said).not.toHaveProperty("fixBy");
    const again = await send({ method: "PUT", path: UPLOAD_PATH, status: 200, upload: envelope(2) });
    expect(await again.json()).toEqual({ stored: true, version: 2 });
    const open = await send({ method: "GET", path: "/docs/{id}", status: 200 });
    await open.body?.cancel();
    expect(open.status).toBe(200);
  });

  it("says the fields the status really has", async () => {
    await share();
    const response = await send({ method: "GET", path: "/docs/{id}/admin", status: 200, admin: TOKEN });
    const { status } = (await response.json()) as { status: object };
    const promised = spec.components.schemas.Status.properties.status;
    expect(Object.keys(status).sort()).toEqual([...promised.required].sort());
  });
});

describe("the version that answers", () => {
  const asked = async (tag?: string) => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://tisty.cl/api/v1/docs/${ID}`, {
        headers: { "CF-Connecting-IP": "198.51.100.78" },
      }) as Request<unknown, IncomingRequestCfProperties>,
      { ...testEnv, ...(tag ? { FOLIO_TAG: tag } : {}) } as never,
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  };

  it("says its tag, so a deploy knows the new one answers", async () => {
    expect((await asked("v1.2.3")).headers.get("Folio-Worker")).toBe("v1.2.3");
  });

  it("says nothing when it has none", async () => {
    expect((await asked()).headers.has("Folio-Worker")).toBe(false);
  });
});
