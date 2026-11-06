import type { Revocation } from "@tisty/contracts";
import { DAY_MS, LEVEL_ONE, type Limits, levelOfReport } from "../core/limits";
import { momentOf } from "../core/moment";
import { toBase64Url } from "../core/start";
import type {
  Admitted,
  Created,
  Held,
  KeptFiles,
  NewDoc,
  News,
  Owned,
  Reading,
  Report,
  Reported,
  Shown,
  Stage,
  Store,
  Swept,
  Upload,
  Uploaded,
  Version,
} from "../core/store";
import { keptVersions } from "../core/versions";

// Two rows by their key at most: the machine that signed the last version and its owner's, the start of owner_mark.
const REVOCATIONS_OF_THE_LAST_VERSION = `(
  SELECT json_group_array(json_object('root', r.root, 'machine', r.machine, 'at', r.at, 'signed', r.signed))
  FROM revocations r
  WHERE (r.root = json_extract(d.versions, '$[#-1].signer') AND r.machine = json_extract(d.versions, '$[#-1].machine'))
    OR (r.root = d.owner AND r.machine = substr(d.owner_mark, 1, instr(d.owner_mark, '.') - 1))
)`;

export interface Bindings {
  DB: D1Database;
  ENVELOPES: R2Bucket;
}

interface DocRow {
  owner: string;
  admin_hash: string;
  permit: string | null;
  owner_mark: string;
  anchor: string | null;
  latest: number;
  versions: string;
  blocked_at: number | null;
  paused_at: number | null;
}

// A document being forgotten: nothing can move it on from here, and the sweep finishes it even after failing halfway.
const CLAIMED = -1;

// Beside the envelopes, so D1 and its backups never hold both the digests and their key (decision 128).
const KEY_OBJECTS = "~";
const DAY_KEY_OBJECT = `${KEY_OBJECTS}day-key`;
const EVIDENCE_KEY_OBJECT = `${KEY_OBJECTS}evidence-key`;
const KEY_BYTES = 32;

// What R2 takes in one delete.
const KEYS_AT_ONCE = 1000;

// A report that weighs: not cleared by an appeal, and not from who reported falsely before (decision 41).
const COUNTED_REPORT = "r.cleared = 0 AND r.net NOT IN (SELECT net FROM false_reporters)";
const REPORT_AS_EVIDENCE = `${COUNTED_REPORT} AND r.level <> 'light'`;
// Without the link nobody could review a grave one, so it stays on record and blocks nothing (decision 153).
const REPORT_THAT_BLOCKS = `${COUNTED_REPORT} AND (r.level = 'medium' OR (r.level = 'grave' AND r.sealed_link IS NOT NULL))`;
const LIGHT_REPORT = `${COUNTED_REPORT} AND r.level = 'light'`;

const WEIGHT_OF = (level: string): string => `CASE ${level} WHEN 'grave' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END`;
const REPORT_RISES = `${WEIGHT_OF("excluded.level")} > ${WEIGHT_OF("reports.level")}`;
const REPORT_REPLACES = `(reports.cleared = 1 OR ${REPORT_RISES})`;

// What keeps a document past its days, not served and not deleted (decision 42). Reports leave once their days pass.
const HELD_AS_EVIDENCE = (doc: string, today: string): string =>
  `(COALESCE(${doc}.legal_until, 0) >= ${today} OR EXISTS (SELECT 1 FROM reports r WHERE r.doc = ${doc}.id AND ${REPORT_AS_EVIDENCE}))`;

const HOURS_IN_A_DAY = 24;

const encoder = new TextEncoder();

const seenTable = (day: number): string => {
  if (!Number.isSafeInteger(day) || day < 0) throw new Error(`not a day: ${day}`);
  return `seen_${day}`;
};

const objectKey = (id: string, version: Pick<Version, "n" | "hash">): string => `${id}/${version.n}.${version.hash}`;
const filesKey = (id: string, hash: string): string => `${id}/files.${hash}`;
const filesKeysOf = (id: string, versions: Version[]): string[] => [
  ...new Set(versions.flatMap((one) => (one.files ? [filesKey(id, one.files)] : []))),
];

const sizeOf = (body: Upload["body"]): number =>
  typeof body === "string" ? encoder.encode(body).byteLength : body.byteLength;

export class Cloud implements Store {
  readonly #db: D1Database;
  readonly #envelopes: R2Bucket;
  readonly #limits: Limits;

  constructor(bindings: Bindings, limits: Limits = LEVEL_ONE) {
    this.#db = bindings.DB;
    this.#envelopes = bindings.ENVELOPES;
    this.#limits = limits;
  }

  async create(doc: NewDoc, today: number): Promise<Created> {
    if (!this.#limits.ttlChoices.includes(doc.ttlDays)) return "bad_ttl";
    const held = await this.#row(doc.id);
    if (held) return this.#retried(held, doc);
    if (!(await this.#takeQuota(doc.net, 1, 0, today))) return "quota";
    const inserted = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO docs (id, owner, anchor, permit, admin_hash, ttl_days, dies_on, active_day, owner_mark)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10
         WHERE (?3 IS NOT NULL AND EXISTS (
           SELECT 1 FROM docs a WHERE a.id = ?3 AND a.owner = ?2 AND a.anchor IS NULL AND a.latest >= 0
         )) OR (?3 IS NULL AND (
           SELECT COUNT(*) FROM docs d
           WHERE d.owner = ?2 AND d.anchor IS NULL AND d.latest >= 0 AND d.blocked_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.held = d.id)
             AND d.dies_on >= ?8
         ) < ?9)`,
      )
      .bind(
        doc.id,
        doc.owner,
        doc.anchor ?? null,
        doc.permit ?? null,
        doc.adminHash,
        doc.ttlDays,
        today + doc.ttlDays,
        today,
        this.#limits.sharesAtMost,
        doc.ownerMark ?? "",
      )
      .run();
    if (inserted.meta.changes > 0) return "created";
    await this.#giveQuotaBack(doc.net, 1, 0, today);
    const raced = await this.#row(doc.id);
    if (raced) return this.#retried(raced, doc);
    return doc.anchor !== undefined ? "no_anchor" : "shares_full";
  }

  // A lost answer comes back as the same document, and only that is not somebody else's id.
  #retried(held: DocRow, doc: NewDoc): Created {
    const sameDocument =
      held.admin_hash === doc.adminHash && held.owner === doc.owner && held.permit === (doc.permit ?? null);
    return sameDocument && held.latest !== CLAIMED ? "same" : "taken";
  }

  async upload(upload: Upload, today: number, known?: Held): Promise<Uploaded> {
    const held = known ?? (await this.held(upload.id));
    if (!held) return "missing";
    if (held.blocked) return "blocked";
    if (held.paused) return "paused";
    const { versions } = held;
    if (held.latest === upload.n && versions.at(-1)?.hash === upload.hash) return "same";
    if (upload.n !== held.latest + 1) return "behind";

    const bytes = sizeOf(upload.body);
    const version: Version = {
      n: upload.n,
      hash: upload.hash,
      bytes,
      at: upload.at,
      signer: upload.signer,
      machine: upload.machine,
      contract: upload.contract,
      ...(upload.files === undefined ? {} : { files: upload.files }),
    };
    const all = [...versions, version];
    const trimmed = keptVersions(all, upload.at, this.#limits);
    const kept = trimmed.length < all.length ? await this.#withEvidence(upload.id, today, all, trimmed) : trimmed;
    if (kept.length > this.#limits.versionsListedAtMost) return "list_full";

    if (!(await this.#takeQuota(upload.net, 0, bytes, today))) return "quota";
    const key = objectKey(upload.id, version);
    try {
      await this.#envelopes.put(key, upload.body);
    } catch (error) {
      await this.#giveQuotaBack(upload.net, 0, bytes, today);
      throw error;
    }

    const alive = `dies_on = CASE WHEN paused_at IS NULL THEN MAX(dies_on, ?1 + ttl_days) ELSE dies_on END,
                   active_day = MAX(active_day, ?1)`;
    const [moved] = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE docs SET latest = ?2, versions = ?3, bytes = ?4,
             owner_mark = CASE WHEN ?7 THEN ?8 ELSE owner_mark END, fix_by = NULL, ${alive}
           WHERE id = ?5 AND latest = ?6 AND blocked_at IS NULL AND paused_at IS NULL AND permit IS ?9`,
        )
        .bind(
          today,
          upload.n,
          JSON.stringify(kept),
          kept.reduce((sum, one) => sum + one.bytes, 0),
          upload.id,
          upload.n - 1,
          upload.byOwner ? 1 : 0,
          upload.ownerMark,
          upload.permit,
        ),
      // A new version of a language is activity of the whole group (decisions 50 and 69 bis).
      ...(held.anchor
        ? [
            this.#db
              .prepare(
                `UPDATE docs SET ${alive}
                 WHERE id = ?2 AND latest >= 0 AND EXISTS (SELECT 1 FROM docs l WHERE l.id = ?3 AND l.latest = ?4)`,
              )
              .bind(today, held.anchor, upload.id, upload.n),
          ]
        : []),
      // Correcting leaves light reports at zero, on record, and grave ones keep counting (decision 151).
      this.#db
        .prepare(
          `UPDATE reports SET cleared = 1 WHERE doc = ?1 AND level = 'light' AND cleared = 0
           AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND latest = ?2)`,
        )
        .bind(upload.id, upload.n),
      ...(upload.byOwner
        ? []
        : [
            this.#db
              .prepare(
                `INSERT OR IGNORE INTO editors (doc, root)
                 SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND latest = ?3)`,
              )
              .bind(upload.id, upload.signer, upload.n),
          ]),
    ]);
    if ((moved?.meta.changes ?? 0) === 0) {
      await this.#giveQuotaBack(upload.net, 0, bytes, today);
      return this.#lostTheRace(upload, key);
    }

    const dropped = versions.filter((one) => !kept.includes(one));
    if (dropped.length > 0) {
      const stillNamed = new Set(filesKeysOf(upload.id, kept));
      const filesGone = filesKeysOf(upload.id, dropped).filter((key) => !stillNamed.has(key));
      await this.#envelopes.delete([...dropped.map((one) => objectKey(upload.id, one)), ...filesGone]);
    }
    return "stored";
  }

  async held(id: string): Promise<Held | null> {
    const row = await this.#row(id);
    if (!row || row.latest === CLAIMED) return null;
    return {
      owner: row.owner,
      permit: row.permit,
      ownerMark: row.owner_mark,
      anchor: row.anchor,
      latest: row.latest,
      versions: JSON.parse(row.versions) as Version[],
      blocked: row.blocked_at !== null,
      paused: row.paused_at !== null,
    };
  }

  async setPermit(id: string, permit: string | null): Promise<void> {
    await this.#db.prepare("UPDATE docs SET permit = ?2 WHERE id = ?1").bind(id, permit).run();
  }

  // The earliest one found counts, so a later note cannot move a theft forward (contract, revocation).
  async revoke(revocations: Revocation[]): Promise<void> {
    await this.#db.batch(
      revocations.map(({ root, machine, at, signed }) =>
        this.#db
          .prepare(
            `INSERT INTO revocations (root, machine, at, signed) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (root, machine) DO UPDATE SET at = excluded.at, signed = excluded.signed
             WHERE excluded.at < revocations.at`,
          )
          .bind(root, machine, Date.parse(at) / 1000, signed),
      ),
    );
  }

  async isRevoked(root: string, machine: string, now: number): Promise<boolean> {
    const found = await this.#db
      .prepare("SELECT 1 AS revoked FROM revocations WHERE root = ?1 AND machine = ?2 AND at <= ?3")
      .bind(root, machine, Math.floor(now / 1000))
      .first<{ revoked: number }>();
    return found !== null;
  }

  async haveSigned(roots: string[]): Promise<boolean> {
    const asked = [...new Set(roots)];
    const found = await this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM json_each(?1) j
         WHERE EXISTS (SELECT 1 FROM docs d WHERE d.owner = j.value AND d.latest > 0)
           OR EXISTS (SELECT 1 FROM editors e WHERE e.root = j.value)`,
      )
      .bind(JSON.stringify(asked))
      .first<{ n: number }>();
    return found?.n === asked.length;
  }

  async #lostTheRace(upload: Upload, key: string): Promise<Uploaded> {
    const now = await this.#row(upload.id);
    const versions = now ? (JSON.parse(now.versions) as Version[]) : [];
    // Two sends of the same bytes share one object, so the one that lost must not delete what the other kept.
    if (versions.some((one) => one.n === upload.n && one.hash === upload.hash)) return "same";
    await this.#envelopes.delete(key);
    if (!now || now.latest === CLAIMED) return "missing";
    return now.blocked_at === null ? "behind" : "blocked";
  }

  // An order keeps them all, and a report keeps the version it was about (decision 152).
  async #withEvidence(id: string, today: number, all: Version[], trimmed: Version[]): Promise<Version[]> {
    const row = await this.#db
      .prepare(
        `SELECT COALESCE(d.legal_until, 0) >= ?2 AS ordered,
           (SELECT json_group_array(r.version) FROM reports r WHERE r.doc = d.id AND ${REPORT_AS_EVIDENCE}) AS reported
         FROM docs d WHERE d.id = ?1`,
      )
      .bind(id, today)
      .first<{ ordered: number; reported: string }>();
    if (row?.ordered === 1) return all;
    const reported = JSON.parse(row?.reported ?? "[]") as number[];
    return all.filter((one) => trimmed.includes(one) || reported.includes(one.n));
  }

  #row(id: string): Promise<DocRow | null> {
    return this.#db
      .prepare(
        "SELECT owner, admin_hash, permit, owner_mark, anchor, latest, versions, blocked_at, paused_at FROM docs WHERE id = ?",
      )
      .bind(id)
      .first<DocRow>();
  }

  async #takeQuota(net: string, docs: number, bytes: number, today: number): Promise<boolean> {
    if (docs > this.#limits.netDocsADay || bytes > this.#limits.netBytesADay) return false;
    const taken = await this.#db
      .prepare(
        `INSERT INTO net_day (day, net, docs, bytes) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (day, net) DO UPDATE SET docs = docs + excluded.docs, bytes = bytes + excluded.bytes
         WHERE docs + excluded.docs <= ?5 AND bytes + excluded.bytes <= ?6`,
      )
      .bind(today, net, docs, bytes, this.#limits.netDocsADay, this.#limits.netBytesADay)
      .run();
    return taken.meta.changes > 0;
  }

  async #giveQuotaBack(net: string, docs: number, bytes: number, today: number): Promise<void> {
    await this.#db
      .prepare("UPDATE net_day SET docs = docs - ?, bytes = bytes - ? WHERE day = ? AND net = ?")
      .bind(docs, bytes, today, net)
      .run();
  }

  async admit(reading: Reading, today: number): Promise<Admitted> {
    try {
      return await this.#admit(reading, today);
    } catch (error) {
      // The day's table is made by the sweep or by the first note: without it, nobody has read yet today.
      if (String(error).includes("no such table")) return "new";
      throw error;
    }
  }

  async #admit({ owner, reader, doc, proved }: Reading, today: number): Promise<Admitted> {
    const table = seenTable(today);
    const found = await this.#db
      .prepare(
        `SELECT (SELECT 1 FROM ${table} WHERE owner = ?1 AND reader = ?2 AND doc = ?3) AS here,
                (SELECT 1 FROM ${table} WHERE owner = ?1 AND reader = ?2 LIMIT 1) AS known`,
      )
      .bind(owner, reader, doc)
      .first<{ here: number | null; known: number | null }>();
    if (found?.here) return "here";
    if (found?.known) return "new";
    const counted = await this.#db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT reader FROM ${table} WHERE owner = ? LIMIT ?)`)
      .bind(owner, this.#limits.newReadersFree)
      .first<{ n: number }>();
    if ((counted?.n ?? 0) < this.#limits.newReadersFree) return "new";
    // The proof comes first, so without one nobody gets in free past the ceiling or makes it count thousands of rows.
    if (!proved) return "over";
    const rows = await this.#db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE owner = ? LIMIT ?)`)
      .bind(owner, this.#limits.rowsPerOwnerADay)
      .first<{ n: number }>();
    // Past the ceiling it answers without noting, so a farm of readers stops adding to the bill.
    return (rows?.n ?? 0) >= this.#limits.rowsPerOwnerADay ? "full" : "new";
  }

  async note(reading: Reading, today: number): Promise<void> {
    try {
      await this.#note(reading, today);
    } catch (error) {
      if (!String(error).includes("no such table")) throw error;
      await this.#db.prepare(this.#createSeen(today)).run();
      await this.#note(reading, today);
    }
  }

  async #note({ owner, reader, doc, hour }: Reading, today: number): Promise<void> {
    await this.#db
      .prepare(`INSERT OR IGNORE INTO ${seenTable(today)} (owner, reader, doc, hour) VALUES (?, ?, ?, ?)`)
      .bind(owner, reader, doc, hour)
      .run();
  }

  async shown(id: string, today: number): Promise<Shown | null> {
    const row = await this.#db
      .prepare(
        `SELECT d.owner, d.latest, json_extract(d.versions, '$[#-1]') AS last_version, d.dies_on, d.paused_at, d.blocked_at, d.fix_by,
           ${REVOCATIONS_OF_THE_LAST_VERSION} AS revocations,
           CASE WHEN d.paused_at IS NOT NULL AND d.dies_on < ?2 THEN 0
             ELSE EXISTS (SELECT 1 FROM holds h WHERE h.held = d.id) OR CASE WHEN a.id IS NULL THEN d.dies_on >= ?2
               ELSE a.latest <> ${CLAIMED} AND a.blocked_at IS NULL AND a.paused_at IS NULL
                 AND (a.dies_on >= ?2 OR EXISTS (SELECT 1 FROM holds h WHERE h.held = a.id)) END END AS alive
         FROM docs d LEFT JOIN docs a ON a.id = d.anchor WHERE d.id = ?1`,
      )
      .bind(id, today)
      .first<{
        owner: string;
        latest: number;
        last_version: string | null;
        dies_on: number;
        paused_at: number | null;
        blocked_at: number | null;
        fix_by: number | null;
        revocations: string;
        alive: number;
      }>();
    if (!row) return null;
    return {
      owner: row.owner,
      version: row.latest > 0 && row.last_version ? (JSON.parse(row.last_version) as Version) : null,
      diesOn: row.dies_on,
      alive: row.alive === 1,
      pausedAt: row.paused_at,
      blockedAt: row.blocked_at,
      fixBy: row.fix_by,
      revocations: (JSON.parse(row.revocations) as (Omit<Revocation, "at"> & { at: number })[]).map((one) => ({
        ...one,
        at: momentOf(one.at * 1000),
      })),
    };
  }

  async envelope(id: string, version: Version): Promise<ReadableStream | null> {
    return (await this.#envelopes.get(objectKey(id, version)))?.body ?? null;
  }

  async hasFiles(id: string, hash: string): Promise<boolean> {
    return (await this.#envelopes.head(filesKey(id, hash))) !== null;
  }

  async keepFiles({ id, hash, body, net }: KeptFiles, today: number): Promise<"stored" | "quota"> {
    if (!(await this.#takeQuota(net, 0, body.length, today))) return "quota";
    try {
      await this.#envelopes.put(filesKey(id, hash), body);
    } catch (error) {
      await this.#giveQuotaBack(net, 0, body.length, today);
      throw error;
    }
    return "stored";
  }

  async filesOf(id: string, hash: string): Promise<ReadableStream | null> {
    return (await this.#envelopes.get(filesKey(id, hash)))?.body ?? null;
  }

  // The first to ask each day replaces it, and only one can win, so yesterday's key is gone for good.
  dayKey(today: number): Promise<string> {
    return this.#keyOf(DAY_KEY_OBJECT, today);
  }

  // Replaced each evidence period: after it, who reported falsely counts again sooner (decision 41).
  evidenceKey(today: number): Promise<string> {
    return this.#keyOf(EVIDENCE_KEY_OBJECT, Math.floor(today / this.#limits.evidenceDays));
  }

  async #keyOf(object: string, period: number): Promise<string> {
    for (;;) {
      const held = await this.#envelopes.get(object);
      const said = held ? (JSON.parse(await held.text()) as { period: number; key: string }) : null;
      if (said && said.period >= period) return said.key;
      const key = toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
      const put = await this.#envelopes.put(object, JSON.stringify({ period, key }), {
        onlyIf: held ? { etagMatches: held.etag } : { etagDoesNotMatch: "*" },
      });
      if (put) return key;
    }
  }

  async takeHourly(net: string, action: string, hour: number, atMost: number, taking = 1): Promise<boolean> {
    const taken = await this.#db
      .prepare(
        `INSERT INTO net_hour (net, action, hour, n) SELECT ?1, ?2, ?3, ?5 WHERE ?5 <= ?4
         ON CONFLICT (net, action) DO UPDATE
           SET n = CASE WHEN hour = excluded.hour THEN n + ?5 ELSE ?5 END, hour = excluded.hour
           WHERE hour <> excluded.hour OR n + ?5 <= ?4`,
      )
      .bind(net, action, hour, atMost, taking)
      .run();
    return taken.meta.changes > 0;
  }

  #createSeen(day: number): string {
    return `CREATE TABLE IF NOT EXISTS ${seenTable(day)} (
      owner TEXT NOT NULL, reader TEXT NOT NULL, doc TEXT NOT NULL, hour INTEGER NOT NULL,
      PRIMARY KEY (owner, reader, doc)
    ) WITHOUT ROWID`;
  }

  async report(report: Report, today: number, hour: number): Promise<Reported> {
    const level = levelOfReport(report.category);
    if (!level) return { blocked: false };
    const [, moved] = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO reports (doc, net, at, category, detail, sealed_link, asn, at_hour, level, version)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
             CASE WHEN EXISTS (SELECT 1 FROM json_each(d.versions) v WHERE json_extract(v.value, '$.n') = ?10)
               THEN ?10 ELSE d.latest END
           FROM docs d WHERE d.id = ?1
           ON CONFLICT (doc, net) DO UPDATE
             SET at = excluded.at, at_hour = excluded.at_hour, asn = excluded.asn,
                 category = CASE WHEN ${REPORT_REPLACES} THEN excluded.category ELSE reports.category END,
                 level = CASE WHEN ${REPORT_REPLACES} THEN excluded.level ELSE reports.level END,
                 version = CASE WHEN ${REPORT_REPLACES} THEN excluded.version ELSE reports.version END,
                 detail = CASE WHEN reports.cleared = 1 THEN excluded.detail
                   ELSE COALESCE(excluded.detail, reports.detail) END,
                 sealed_link = CASE WHEN reports.cleared = 1 THEN excluded.sealed_link
                   ELSE COALESCE(reports.sealed_link, excluded.sealed_link) END,
                 cleared = 0
             WHERE ${REPORT_REPLACES} OR (reports.sealed_link IS NULL AND excluded.sealed_link IS NOT NULL)`,
        )
        .bind(
          report.doc,
          report.net,
          today,
          report.category,
          report.detail ?? null,
          report.sealedLink ?? null,
          report.asn,
          hour,
          level,
          report.version ?? null,
        ),
      level === "light" ? this.#warnAuthor(report.doc, today) : this.#blockWhenItCounts(report.doc, today, hour),
    ]);
    return { blocked: level !== "light" && (moved?.meta.changes ?? 0) > 0 };
  }

  #warnAuthor(doc: string, today: number): D1PreparedStatement {
    return this.#db
      .prepare(
        `UPDATE docs SET fix_by = ?1 + ?2
         WHERE id = ?3 AND fix_by IS NULL AND blocked_at IS NULL
           AND (SELECT COUNT(*) FROM reports r WHERE r.doc = ?3 AND ${LIGHT_REPORT}) >= ?4
           AND (SELECT COUNT(DISTINCT r.asn) FROM reports r WHERE r.doc = ?3 AND ${LIGHT_REPORT}) >= ?5`,
      )
      .bind(
        today,
        this.#limits.lightFixDays,
        doc,
        this.#limits.lightReportsToWarn,
        this.#limits.reportOperatorsToBlock,
      );
  }

  #blockWhenItCounts(doc: string, today: number, hour: number): D1PreparedStatement {
    return this.#db
      .prepare(
        `UPDATE docs SET blocked_at = ?1, blocked_hour = ?6, dies_on = ?1 + ?2
         WHERE id = ?3 AND blocked_at IS NULL
           AND (SELECT COUNT(*) FROM reports r WHERE r.doc = ?3 AND ${REPORT_THAT_BLOCKS}) >= ?4
           AND (SELECT COUNT(DISTINCT r.asn) FROM reports r WHERE r.doc = ?3 AND ${REPORT_THAT_BLOCKS}) >= ?5`,
      )
      .bind(
        today,
        this.#limits.evidenceDays,
        doc,
        this.#limits.reportsToBlock,
        this.#limits.reportOperatorsToBlock,
        hour,
      );
  }

  // Past its days and not blocked, it looks gone, or the admin link would give away an order that keeps it (decision 42).
  async owned(id: string, today: number): Promise<Owned | null> {
    const row = await this.#db
      .prepare(
        `SELECT d.admin_hash, d.latest, d.dies_on, d.paused_at, d.blocked_at, d.appealed_at, d.fix_by, d.read_total, d.days
         FROM docs d LEFT JOIN docs a ON a.id = d.anchor
         WHERE d.id = ?1 AND d.latest <> ${CLAIMED} AND (d.blocked_at IS NOT NULL OR d.dies_on >= ?2
           OR (d.paused_at IS NULL AND a.latest <> ${CLAIMED} AND a.dies_on >= ?2))`,
      )
      .bind(id, today)
      .first<{
        admin_hash: string;
        latest: number;
        dies_on: number;
        paused_at: number | null;
        blocked_at: number | null;
        appealed_at: number | null;
        fix_by: number | null;
        read_total: number;
        days: string;
      }>();
    if (!row) return null;
    return {
      adminHash: row.admin_hash,
      status: {
        latest: row.latest,
        diesOn: row.dies_on,
        pausedAt: row.paused_at,
        blockedAt: row.blocked_at,
        appealedAt: row.appealed_at,
        fixBy: row.fix_by,
        readTotal: row.read_total,
        days: JSON.parse(row.days),
      },
    };
  }

  async appeal(id: string, today: number, hour: number): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE docs SET appealed_at = ?2, appealed_hour = ?3
         WHERE id = ?1 AND blocked_at IS NOT NULL AND appealed_at IS NULL`,
      )
      .bind(id, today, hour)
      .run();
  }

  async appealAccepted(id: string, today: number): Promise<void> {
    await this.#db.batch([
      // Who reported it stops counting for a while, and the reports stay as a record.
      this.#db
        .prepare(
          `INSERT INTO false_reporters (net, at)
           SELECT net, ?2 FROM reports
           WHERE doc = ?1 AND cleared = 0 AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND blocked_at IS NOT NULL)
           ON CONFLICT (net) DO UPDATE SET at = excluded.at`,
        )
        .bind(id, today),
      this.#db
        .prepare(
          "UPDATE reports SET cleared = 1 WHERE doc = ?1 AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND blocked_at IS NOT NULL)",
        )
        .bind(id),
      this.#db
        .prepare(
          `UPDATE docs SET blocked_at = NULL, appealed_at = NULL, blocked_hour = NULL, appealed_hour = NULL, fix_by = NULL,
             dies_on = CASE WHEN paused_at IS NULL THEN ?1 + ttl_days ELSE paused_at + ?2 END
           WHERE id = ?3 AND blocked_at IS NOT NULL`,
        )
        .bind(today, this.#limits.pausedDays, id),
    ]);
  }

  async pause(id: string, today: number): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE docs SET paused_at = ?1, dies_on = ?1 + ?2 WHERE id = ?3 AND blocked_at IS NULL AND paused_at IS NULL",
      )
      .bind(today, this.#limits.pausedDays, id)
      .run();
  }

  async resume(id: string, today: number): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE docs SET paused_at = NULL, dies_on = ?1 + ttl_days WHERE id = ?2 AND blocked_at IS NULL AND paused_at IS NOT NULL",
      )
      .bind(today, id)
      .run();
  }

  // Only past its days: the sweep decides what goes, so a report that arrives before it still keeps it (decision 42).
  async stop(id: string, today: number): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE docs SET paused_at = COALESCE(paused_at, ?2), dies_on = ?2 - 1
         WHERE id = ?1 AND latest >= 0 AND blocked_at IS NULL`,
      )
      .bind(id, today)
      .run();
  }

  // Adds up first: what expired is only known once every past day has counted (decision 128).
  async sweep(today: number): Promise<Swept> {
    await this.#db.batch([this.#db.prepare(this.#createSeen(today)), this.#db.prepare(this.#createSeen(today + 1))]);
    const { summed, failed: failedDays } = await this.#sumPastDays(today);
    let forgotten = 0;
    let failed = failedDays;
    // A block stops the reads that keep documents alive, so an attack must not be able to erase them (decision 118).
    if (failedDays === 0 && (await this.stage()) !== "blocked") {
      try {
        forgotten = await this.#forget(await this.#expired(today), today);
      } catch (error) {
        failed += 1;
        console.error("what expired could not be forgotten", String(error));
      }
    }
    try {
      await this.#db.batch([
        this.#db.prepare("DELETE FROM net_day WHERE day < ?").bind(today),
        this.#db.prepare("DELETE FROM net_hour WHERE hour < ?").bind(today * HOURS_IN_A_DAY),
        this.#db.prepare("DELETE FROM false_reporters WHERE at < ?").bind(today - this.#limits.evidenceDays),
        this.#db
          .prepare(
            `DELETE FROM reports WHERE at < ?1
             AND doc NOT IN (SELECT id FROM docs WHERE legal_until >= ?2)`,
          )
          .bind(today - this.#limits.evidenceDays, today),
      ]);
    } catch (error) {
      failed += 1;
      console.error("the old rows could not be cleaned", String(error));
    }
    return { summed, forgotten, failed };
  }

  async #sumPastDays(today: number): Promise<{ summed: number; failed: number }> {
    const tables = await this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'seen_[0-9]*'")
      .all<{ name: string }>();
    const days = tables.results
      .map((one) => Number(one.name.slice("seen_".length)))
      .filter((day) => day < today)
      .sort((a, b) => a - b);
    let summed = 0;
    let failed = 0;
    for (const day of days) {
      const table = seenTable(day);
      try {
        // In one batch, so a day is either counted and gone or still there to count: never lost, never counted twice.
        await this.#db.batch([
          this.#addToDocs(table, day),
          this.#addToService(table, day),
          this.#db.prepare(`DROP TABLE ${table}`),
        ]);
        summed += 1;
      } catch (error) {
        failed += 1;
        console.error("a day could not be added up", day, String(error));
      }
    }
    return { summed, failed };
  }

  // The day goes in the row this already writes, so its history costs no rows and dies with the document (decision 136).
  #addToDocs(table: string, day: number): D1PreparedStatement {
    // A reader who arrives as the day is added opens the table again: only their count is added, not their hour.
    return this.#db
      .prepare(
        `UPDATE docs SET read_total = read_total + t.readers, active_day = MAX(active_day, ?1),
           dies_on = CASE WHEN paused_at IS NULL AND blocked_at IS NULL
             THEN MAX(dies_on, ?1 + ttl_days) ELSE dies_on END,
           days = (
             SELECT json_group_object(key, json(value)) FROM json_each(
               CASE WHEN json_type(days, ?4) IS NULL THEN json_set(days, ?4, json(t.entry))
                 ELSE json_set(days, ?4 || '.n', json_extract(days, ?4 || '.n') + t.readers) END
             ) WHERE CAST(key AS INTEGER) > ?1 - ?2
           )
         FROM (
           SELECT doc, SUM(n) AS readers,
             CASE WHEN SUM(n) >= ?3 THEN json_object('n', SUM(n), 'h', json_group_object(hour, n))
               ELSE json_object('n', SUM(n)) END AS entry
           FROM (SELECT doc, hour, COUNT(*) AS n FROM ${table} GROUP BY doc, hour) GROUP BY doc
         ) t
         WHERE docs.id = t.doc`,
      )
      .bind(day, this.#limits.historyDays, this.#limits.hoursFromReaders, `$."${day}"`);
  }

  #addToService(table: string, day: number): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT INTO service_day (day, readers, docs, hours)
         SELECT ?1, readers, docs, hours FROM (
           SELECT SUM(n) AS readers, (SELECT COUNT(DISTINCT doc) FROM ${table}) AS docs,
             json_group_object(hour, n) AS hours
           FROM (SELECT hour, COUNT(*) AS n FROM ${table} GROUP BY hour)
         ) WHERE readers IS NOT NULL
         ON CONFLICT (day) DO UPDATE SET readers = readers + excluded.readers, docs = docs + excluded.docs`,
      )
      .bind(day);
  }

  async #expired(today: number): Promise<string[]> {
    const expired = await this.#db
      .prepare(
        `SELECT d.id FROM docs d
         WHERE d.latest = ${CLAIMED} OR (
           d.dies_on < ?1
           AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.held = d.id)
           AND NOT ${HELD_AS_EVIDENCE("d", "?1")}
           AND (d.anchor IS NULL OR d.blocked_at IS NOT NULL OR d.paused_at IS NOT NULL
             OR NOT EXISTS (SELECT 1 FROM docs a WHERE a.id = d.anchor))
           AND NOT EXISTS (
             SELECT 1 FROM docs l WHERE l.owner = d.owner AND l.anchor = d.id
               AND ((l.blocked_at IS NOT NULL AND l.dies_on >= ?1)
                 OR EXISTS (SELECT 1 FROM holds h WHERE h.held = l.id)
                 OR ${HELD_AS_EVIDENCE("l", "?1")})
           )
         )
         ORDER BY d.latest = ${CLAIMED} DESC, d.dies_on LIMIT ?2`,
      )
      .bind(today, this.#limits.sweptAtOnce)
      .all<{ id: string }>();
    return expired.results.map((one) => one.id);
  }

  // In bulk for D1's 1,000 queries per invocation; claiming before R2 lets a later upload or hold save the document.
  async #forget(expired: string[], today: number): Promise<number> {
    if (expired.length === 0) return 0;
    const listed = JSON.stringify(expired);
    await this.#db
      .prepare(
        `UPDATE docs SET latest = ${CLAIMED}
         WHERE id IN (SELECT value FROM json_each(?1)) AND (latest = ${CLAIMED} OR (
           dies_on < ?2 AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.held = docs.id)
           AND NOT ${HELD_AS_EVIDENCE("docs", "?2")}
         ))`,
      )
      .bind(listed, today)
      .run();
    await this.#db
      .prepare(
        `UPDATE docs SET latest = ${CLAIMED}
         WHERE latest <> ${CLAIMED} AND (owner, anchor) IN (
           SELECT a.owner, a.id FROM docs a WHERE a.latest = ${CLAIMED} AND a.id IN (SELECT value FROM json_each(?1))
         )`,
      )
      .bind(listed)
      .run();
    const claimed = await this.#db
      .prepare(`SELECT id, versions FROM docs WHERE latest = ${CLAIMED} LIMIT ?`)
      .bind(this.#limits.sweptAtOnce)
      .all<{ id: string; versions: string }>();
    if (claimed.results.length === 0) return 0;

    const keys = claimed.results.flatMap(({ id, versions }) => {
      const listed = JSON.parse(versions) as Version[];
      return [...listed.map((one) => objectKey(id, one)), ...filesKeysOf(id, listed)];
    });
    for (let from = 0; from < keys.length; from += KEYS_AT_ONCE) {
      await this.#envelopes.delete(keys.slice(from, from + KEYS_AT_ONCE));
    }
    const ids = JSON.stringify(claimed.results.map((one) => one.id));
    const [, deleted] = await this.#db.batch([
      this.#db
        .prepare(
          `DELETE FROM holds WHERE holder IN (SELECT value FROM json_each(?1))
             OR held IN (SELECT value FROM json_each(?1))`,
        )
        .bind(ids),
      this.#db.prepare("DELETE FROM docs WHERE id IN (SELECT value FROM json_each(?))").bind(ids),
      this.#db.prepare("DELETE FROM editors WHERE doc IN (SELECT value FROM json_each(?))").bind(ids),
    ]);
    return deleted?.meta.changes ?? 0;
  }

  async stage(): Promise<Stage> {
    const row = await this.#db.prepare("SELECT stage FROM service_stage WHERE id = 1").first<{ stage: Stage }>();
    return row?.stage ?? "open";
  }

  async digested(): Promise<{ hour: number; alerted: Stage }> {
    const row = await this.#db
      .prepare("SELECT digested_hour, alerted FROM service_stage WHERE id = 1")
      .first<{ digested_hour: number; alerted: Stage }>();
    return { hour: row?.digested_hour ?? 0, alerted: row?.alerted ?? "open" };
  }

  async news(after: number, before: number, atMost: number): Promise<News> {
    const [reports, blocked, appealed] = await this.#db.batch([
      this.#db
        .prepare(
          `SELECT doc, category, COUNT(*) AS nets FROM reports
           WHERE at_hour > ?1 AND at_hour < ?2 AND cleared = 0 AND level <> 'light'
           GROUP BY doc, category ORDER BY category = 'csam' DESC, nets DESC, doc LIMIT ?3`,
        )
        .bind(after, before, atMost),
      this.#db
        .prepare("SELECT id FROM docs WHERE blocked_hour > ?1 AND blocked_hour < ?2 ORDER BY id LIMIT ?3")
        .bind(after, before, atMost),
      this.#db
        .prepare("SELECT id FROM docs WHERE appealed_hour > ?1 AND appealed_hour < ?2 ORDER BY id LIMIT ?3")
        .bind(after, before, atMost),
    ]);
    const ids = (rows: typeof blocked): string[] => ((rows?.results ?? []) as { id: string }[]).map(({ id }) => id);
    return {
      reports: (reports?.results ?? []) as News["reports"],
      blocked: ids(blocked),
      appealed: ids(appealed),
    };
  }

  async setDigested(hour: number, stage: Stage): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO service_stage (id, stage, alerted, digested_hour) VALUES (1, ?1, ?1, ?2)
         ON CONFLICT (id) DO UPDATE SET alerted = excluded.alerted, digested_hour = excluded.digested_hour`,
      )
      .bind(stage, hour)
      .run();
  }

  async setStage(stage: Stage): Promise<void> {
    await this.#db
      .prepare("INSERT INTO service_stage (id, stage) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET stage = ?1")
      .bind(stage)
      .run();
  }

  // Only what was about to die, so a block that comes back every day writes few rows.
  async liftCut(today: number): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE docs SET dies_on = ?1 + ttl_days
         WHERE dies_on <= ?1 AND latest >= 0 AND paused_at IS NULL AND blocked_at IS NULL
           AND NOT ${HELD_AS_EVIDENCE("docs", "?1")}`,
      )
      .bind(today)
      .run();
  }

  // After D1 goes back in time, what came later stays in R2 with no row, paying for storage where nothing lists it.
  async forgetOrphans(now: number): Promise<number> {
    let forgotten = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#envelopes.list({ cursor });
      const idOf = (key: string): string => key.split("/", 1)[0] ?? key;
      const ids = [...new Set(page.objects.map((one) => idOf(one.key)))];
      const held = await this.#db
        .prepare("SELECT id FROM docs WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(ids))
        .all<{ id: string }>();
      const known = new Set(held.results.map((one) => one.id));
      const old = now - DAY_MS;
      const orphans = page.objects.filter(
        (one) => !one.key.startsWith(KEY_OBJECTS) && !known.has(idOf(one.key)) && one.uploaded.getTime() < old,
      );
      if (orphans.length > 0) await this.#envelopes.delete(orphans.map((one) => one.key));
      forgotten += orphans.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return forgotten;
  }
}
