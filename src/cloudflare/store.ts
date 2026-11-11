import type { Revocation } from "@tisty/contracts";
import { caseNameOf } from "../core/case-records";
import { DAY_MS, LEVEL_ONE, type Limits, levelOfReport } from "../core/limits";
import { momentOf } from "../core/moment";
import { GRAVEST_FIRST } from "../core/queue";
import { toBase64Url } from "../core/start";
import type {
  AcceptedTerms,
  Admitted,
  Appealed,
  Created,
  Held,
  HeldReviewed,
  KeptFiles,
  KeyAdmitted,
  NewDoc,
  News,
  OpenedCase,
  Owned,
  Reading,
  Report,
  Reported,
  Shown,
  Spent,
  Stage,
  Store,
  Swept,
  Upload,
  Uploaded,
  Version,
} from "../core/store";
import { keptVersions } from "../core/versions";
import { acceptAppeal, CLAIMED, mayCorrect } from "./moderation";
import { HELD_BYTES, HOLDS_ROOM } from "./room";
import { addProvedTo, NEW_KEYS_NET, PROVED, PROVED_COLUMN, seenTable } from "./seen";

// Three rows by their key at most: the machine that signed the last version, its owner's, the start of owner_mark,
// and the one that signed the owner's word on the reviews, which a reader weighs alone (contract, review.current).
// Who edited it may have signed their entry on any machine; one of each root first, so many from one push no other out.
const revocationsOf = (version: string, editorsAtMost: string): string => `(
  SELECT json_group_array(json_object('root', root, 'machine', machine, 'at', at, 'signed', signed))
  FROM (
    SELECT r.root, r.machine, r.at, r.signed FROM revocations r
    WHERE (r.root = json_extract(${version}, '$.signer') AND r.machine = json_extract(${version}, '$.machine'))
      OR (r.root = d.owner AND r.machine = substr(d.owner_mark, 1, instr(d.owner_mark, '.') - 1))
      OR (r.root = d.owner AND r.machine = json_extract(d.reviewed, '$.machine'))
    UNION
    SELECT * FROM (
      SELECT r.root, r.machine, r.at, r.signed FROM editors e JOIN revocations r ON r.root = e.root
      WHERE e.doc = d.id AND e.root <> d.owner
      ORDER BY ROW_NUMBER() OVER (PARTITION BY r.root ORDER BY r.at DESC), r.root
      LIMIT ${editorsAtMost}
    )
  )
)`;

const revocationsIn = (said: string): Revocation[] =>
  (JSON.parse(said) as (Omit<Revocation, "at"> & { at: number })[]).map((one) => ({
    ...one,
    at: momentOf(one.at * 1000),
  }));

export interface Bindings {
  DB: D1Database;
  ENVELOPES: R2Bucket;
}

interface DocRow {
  owner: string;
  admin_hash: string;
  reviewed: string | null;
  reviewed_seq: number | null;
  permit: string | null;
  owner_mark: string;
  anchor: string | null;
  latest: number;
  versions: string;
  files_bytes: number;
  blocked_at: number | null;
  paused_at: number | null;
  counts_from: number;
  blocked_by_operator: number;
}

// Beside the envelopes, so D1 and its backups never hold both the digests and their key (decision 128).
const KEY_OBJECTS = "~";
const DAY_KEY_OBJECT = `${KEY_OBJECTS}day-key`;
const EVIDENCE_KEY_OBJECT = `${KEY_OBJECTS}evidence-key`;
const KEY_BYTES = 32;

// What R2 takes in one delete.
const KEYS_AT_ONCE = 1000;

// A report that weighs: not cleared by an appeal, and not from who reported falsely before (decision 41).
const COUNTED_REPORT = "r.cleared = 0 AND r.over_cap = 0 AND r.net NOT IN (SELECT net FROM false_reporters)";
// A network is often shared: finding one report false says nothing of what others on it reported before.
const REPORT_AS_EVIDENCE =
  "r.cleared = 0 AND (r.over_cap = 0 OR r.level = 'grave') AND r.level <> 'light' AND r.net NOT IN (SELECT f.net FROM false_reporters f WHERE CASE WHEN f.since_hour IS NULL THEN COALESCE(f.since, f.at) < r.at ELSE f.since_hour <= r.at_hour END)";
// The API now refuses a grave report without its link: this is for what was reported before it did (decision 153).
const REPORT_THAT_BLOCKS = `${COUNTED_REPORT} AND (r.level = 'medium' OR (r.level = 'grave' AND r.sealed_link IS NOT NULL))`;
const LIGHT_REPORT = `${COUNTED_REPORT} AND r.level = 'light'`;

const WEIGHT_OF = (level: string): string => `CASE ${level} WHEN 'grave' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END`;
const REPORT_RISES = `${WEIGHT_OF("excluded.level")} > ${WEIGHT_OF("reports.level")}`;
// Cleared stays cleared for what it was about, so the same networks cannot undo an accepted appeal; a newer version is news.
const AFTER_WHAT_WAS_ANSWERED =
  "excluded.version >= (SELECT d.counts_from FROM docs d WHERE d.id = excluded.doc) AND reports.version < (SELECT d.counts_from FROM docs d WHERE d.id = excluded.doc)";
// A network found false keeps what it said before, and saying more cannot raise it into evidence it never was.
const REPORT_REPLACES = `((reports.cleared = 1 OR NOT EXISTS (SELECT 1 FROM false_reporters f WHERE f.net = excluded.net))
  AND CASE WHEN reports.cleared = 1 THEN reports.level = 'light' OR excluded.version > reports.version ELSE ${REPORT_RISES} OR (${AFTER_WHAT_WAS_ANSWERED}) END)`;
// A document stopped today waits for the sweep, and what is reported until then still reaches it; one that expired does not.
const STOPPED_BEFORE = (doc: string, today: string): string =>
  `(${doc}.paused_at IS NOT NULL AND ${doc}.dies_on < ${today} - 1)`;
const OWN_DAYS_LEFT = (doc: string, today: string): string =>
  `(${doc}.dies_on >= ${today} OR (${doc}.paused_at IS NOT NULL AND ${doc}.dies_on >= ${today} - 1))`;
// A language its owner stopped ends with its own days, though its anchor lives on, as SERVED says.
const STILL_LIVES = (doc: string, today: string): string =>
  `(${OWN_DAYS_LEFT(doc, today)} OR EXISTS (SELECT 1 FROM holds h WHERE h.held = ${doc}.id)
    OR (NOT ${STOPPED_BEFORE(doc, today)}
      AND EXISTS (SELECT 1 FROM docs a WHERE a.id = ${doc}.anchor AND ${OWN_DAYS_LEFT("a", today)})))`;
const REPORT_MOVES = `(${REPORT_REPLACES} OR (reports.cleared = 0 AND reports.sealed_link IS NULL AND excluded.sealed_link IS NOT NULL))`;

// What keeps a document past its days, not served and not deleted (decision 42). Reports leave once their days pass.
const HELD_AS_EVIDENCE = (doc: string, today: string): string =>
  `(COALESCE(${doc}.legal_until, 0) >= ${today} OR EXISTS (SELECT 1 FROM reports r WHERE r.doc = ${doc}.id AND ${REPORT_AS_EVIDENCE}))`;

// A language lives by its anchor, so its own days only say it left when it never got a version, or was stopped.
const LANGUAGES_OF = (owner: string, anchor: string, today: string): string =>
  `SELECT COUNT(*) FROM docs l WHERE l.owner = ${owner} AND l.anchor = ${anchor}
     AND (l.latest > 0 OR (l.latest = 0 AND l.dies_on >= ${today}))
     AND l.blocked_at IS NULL AND (l.paused_at IS NULL OR l.dies_on >= ${today})`;

const NEW_KEYS_NOTICED_AT = 0.9;

const LIVES_ON = "CASE WHEN paused_at IS NULL THEN MAX(dies_on, ?1 + ttl_days) ELSE dies_on END";

// What can block now: an appeal that cleared its owner leaves earlier versions on record and out of the count.
const COUNTS_NOW = `${REPORT_THAT_BLOCKS} AND r.version >= docs.counts_from`;
const COUNTS_TODAY = `${COUNTS_NOW} AND (SELECT COUNT(DISTINCT y.doc) FROM reports y JOIN docs b ON b.id = y.doc
  WHERE y.net = r.net AND b.blocked_at = ?1 AND b.blocked_by_operator = 0) < ?7`;
// A version no longer listed, or a report with none, is not proof that someone else signed it.
const SIGNED_BY_OWNER = `COALESCE(
  (SELECT json_extract(j.value, '$.signer') FROM json_each(docs.versions) j WHERE json_extract(j.value, '$.n') = r.version),
  docs.owner
) = docs.owner`;

const HOURS_IN_A_DAY = 24;
const HOUR_MS = 3_600_000;
// Two queries each, so with the rest of the sweep it stays far under D1's 1,000 per invocation; the next hour goes on.
const TRIMMED_AT_ONCE = 100;

const encoder = new TextEncoder();

const DOC_DAYS_KEPT = 31;

const SHARES_OF_A_DAY = "share";
const sharesCounterOf = (owner: string): string => `root:${owner}`;

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
    // Per key and day, so stopping one to share another never turns two at once into as many as anyone likes.
    if (doc.anchor === undefined && !(await this.#takeShare(doc.owner, today))) {
      await this.#giveQuotaBack(doc.net, 1, 0, today);
      return "day_full";
    }
    const otherLanguages = this.#limits.languagesAtMost - 1;
    const inserted = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO docs (id, owner, anchor, permit, admin_hash, ttl_days, dies_on, active_day, owner_mark, first_day)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10, ?8
         WHERE (?3 IS NOT NULL AND EXISTS (
           SELECT 1 FROM docs a WHERE a.id = ?3 AND a.owner = ?2 AND a.anchor IS NULL AND a.latest >= 0
         ) AND (${LANGUAGES_OF("?2", "?3", "?8")}) < ?11) OR (?3 IS NULL AND (
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
        otherLanguages,
      )
      .run();
    if (inserted.meta.changes > 0) return "created";
    await this.#giveQuotaBack(doc.net, 1, 0, today);
    if (doc.anchor === undefined) await this.#giveShareBack(doc.owner, today);
    const raced = await this.#row(doc.id);
    if (raced) return this.#retried(raced, doc);
    if (doc.anchor === undefined) return "shares_full";
    const languages = await this.#db
      .prepare(`SELECT (${LANGUAGES_OF("?1", "?2", "?3")}) AS n`)
      .bind(doc.owner, doc.anchor, today)
      .first<{ n: number }>();
    return (languages?.n ?? 0) >= otherLanguages ? "languages_full" : "no_anchor";
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
    const correcting = held.correctable && upload.byOwner;
    if (held.blocked && !correcting) return "blocked";
    if (held.paused && !correcting) return "paused";
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

    const room = await this.#takeRoom(upload.net, bytes, today, upload.newKey);
    if (room !== "stored") return room;
    const key = objectKey(upload.id, version);
    try {
      await this.#envelopes.put(key, upload.body);
    } catch (error) {
      await this.#giveRoomBack(upload.net, bytes, today, upload.newKey);
      throw error;
    }

    const [moved] = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE docs SET latest = ?2, versions = ?3, bytes = ?4, files_bytes = ?11,
             owner_mark = CASE WHEN ?7 THEN ?8 ELSE owner_mark END, fix_by = NULL,
             reviewed = COALESCE(?14, reviewed), reviewed_at = CASE WHEN ?14 IS NULL THEN reviewed_at ELSE ?15 END,
             dies_on = CASE WHEN blocked_at IS NULL THEN ${LIVES_ON} WHEN paused_at IS NULL THEN ?1 + ttl_days ELSE paused_at + ?10 END,
             active_day = MAX(active_day, ?1),
             blocked_at = NULL, blocked_hour = NULL, appealed_hour = NULL
           WHERE id = ?5 AND latest = ?6 AND permit IS ?9
             AND (?14 IS NULL OR COALESCE(json_extract(reviewed, '$.seq'), 0) < ?16)
             AND ((blocked_at IS NULL AND paused_at IS NULL) OR (?7 AND blocked_at IS NOT NULL AND blocked_by_operator = 0 AND counts_from = ?2))
             AND (?12 IS NULL OR ?13 + (SELECT COALESCE(SUM(${HELD_BYTES}), 0) FROM docs d
               WHERE d.owner = docs.owner AND d.id <> docs.id AND ${HOLDS_ROOM("?1")}) <= ?12)`,
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
          this.#limits.pausedDays,
          upload.filesBytes ?? 0,
          upload.roomAtMost ?? null,
          bytes + (upload.filesBytes ?? 0),
          upload.reviewed?.said ?? null,
          upload.at,
          upload.reviewed?.seq ?? 0,
        ),
      // A new version of a language is activity of the whole group (decisions 50 and 69 bis).
      ...(held.anchor
        ? [
            this.#db
              .prepare(
                `UPDATE docs SET dies_on = ${LIVES_ON}, active_day = MAX(active_day, ?1)
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
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO net_doc (day, doc, net)
           SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM docs WHERE id = ?2 AND latest = ?4)`,
        )
        .bind(today, upload.id, upload.net, upload.n),
    ]);
    if ((moved?.meta.changes ?? 0) === 0) {
      await this.#giveRoomBack(upload.net, bytes, today, upload.newKey);
      return this.#lostTheRace(upload, key, today);
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
      adminHash: row.admin_hash,
      reviewed: row.reviewed === null ? null : { said: row.reviewed, seq: row.reviewed_seq ?? 0 },
      permit: row.permit,
      ownerMark: row.owner_mark,
      anchor: row.anchor,
      latest: row.latest,
      versions: JSON.parse(row.versions) as Version[],
      filesBytes: row.files_bytes,
      blocked: row.blocked_at !== null,
      paused: row.paused_at !== null,
      correctable: mayCorrect(row),
    };
  }

  async setPermit(id: string, permit: string | null): Promise<void> {
    await this.#db.prepare("UPDATE docs SET permit = ?2 WHERE id = ?1").bind(id, permit).run();
  }

  // The earliest one found counts, so a later note cannot move a theft forward (contract, revocation).
  async revoke(revocations: Revocation[]): Promise<boolean> {
    const taking = revocations.map(({ root, machine, at, signed }) =>
      this.#db
        .prepare(
          `INSERT INTO revocations (root, machine, at, signed)
           SELECT ?1, ?2, ?3, ?4
           WHERE EXISTS (SELECT 1 FROM revocations WHERE root = ?1 AND machine = ?2)
             OR (SELECT COUNT(*) FROM revocations WHERE root = ?1) < ?5
           ON CONFLICT (root, machine) DO UPDATE SET at = excluded.at, signed = excluded.signed
           WHERE excluded.at < revocations.at`,
        )
        .bind(root, machine, Date.parse(at) / 1000, signed, this.#limits.revokedMachinesAtMost),
    );
    const asked = JSON.stringify(revocations.map(({ root, machine }) => [root, machine]));
    const counting = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM json_each(?1) j WHERE EXISTS (
           SELECT 1 FROM revocations r
           WHERE r.root = json_extract(j.value, '$[0]') AND r.machine = json_extract(j.value, '$[1]')
         )`,
      )
      .bind(asked);
    const results = await this.#db.batch<{ n: number }>([...taking, counting]);
    return results.at(-1)?.results[0]?.n === revocations.length;
  }

  async isRevoked(root: string, machine: string, now: number): Promise<boolean> {
    const found = await this.#db
      .prepare("SELECT 1 AS revoked FROM revocations WHERE root = ?1 AND machine = ?2 AND at <= ?3")
      .bind(root, machine, Math.floor(now / 1000))
      .first<{ revoked: number }>();
    return found !== null;
  }

  async keepReviewed(id: string, latest: number, { said, seq }: HeldReviewed, at: number): Promise<boolean> {
    const kept = await this.#db
      .prepare(
        `UPDATE docs SET reviewed = ?3, reviewed_at = ?4
           WHERE id = ?1 AND latest = ?2 AND COALESCE(json_extract(reviewed, '$.seq'), 0) < ?5`,
      )
      .bind(id, latest, said, at, seq)
      .run();
    return kept.meta.changes > 0;
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

  async #lostTheRace(upload: Upload, key: string, today: number): Promise<Uploaded> {
    const now = await this.#row(upload.id);
    const versions = now ? (JSON.parse(now.versions) as Version[]) : [];
    // Two sends of the same bytes share one object, so the one that lost must not delete what the other kept.
    if (versions.some((one) => one.n === upload.n && one.hash === upload.hash)) return "same";
    await this.#envelopes.delete(key);
    if (!now || now.latest === CLAIMED) return "missing";
    if (now.blocked_at !== null) return "blocked";
    if (now.latest === upload.n - 1 && upload.roomAtMost !== undefined) {
      const held = await this.heldByOwner(now.owner, today, upload.id);
      if (held + sizeOf(upload.body) + (upload.filesBytes ?? 0) > upload.roomAtMost) return "room_full";
    }
    return "behind";
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
        "SELECT owner, admin_hash, reviewed, json_extract(reviewed, '$.seq') AS reviewed_seq, permit, owner_mark, anchor, latest, versions, files_bytes, blocked_at, paused_at, counts_from, blocked_by_operator FROM docs WHERE id = ?",
      )
      .bind(id)
      .first<DocRow>();
  }

  async #takeQuota(net: string, docs: number, bytes: number, today: number, uploads = 0): Promise<boolean> {
    if (docs > this.#limits.netDocsADay || bytes > this.#limits.netBytesADay) return false;
    const taken = await this.#db
      .prepare(
        `INSERT INTO net_day (day, net, docs, bytes, uploads) VALUES (?1, ?2, ?3, ?4, ?7)
         ON CONFLICT (day, net) DO UPDATE
           SET docs = docs + excluded.docs, bytes = bytes + excluded.bytes, uploads = uploads + excluded.uploads
         WHERE docs + excluded.docs <= ?5 AND bytes + excluded.bytes <= ?6`,
      )
      .bind(today, net, docs, bytes, this.#limits.netDocsADay, this.#limits.netBytesADay, uploads)
      .run();
    return taken.meta.changes > 0;
  }

  // The latest version and its attachments: older ones are kept for reports, which the owner does not choose.
  async heldByOwner(owner: string, today: number, except: string): Promise<number> {
    const held = await this.#db
      .prepare(
        `SELECT COALESCE(SUM(${HELD_BYTES}), 0) AS n FROM docs d WHERE d.owner = ?1 AND ${HOLDS_ROOM("?2")} AND d.id <> ?3`,
      )
      .bind(owner, today, except)
      .first<{ n: number }>();
    return held?.n ?? 0;
  }

  async newRootsOf(roots: string[], day: number): Promise<string[]> {
    const found = await this.#db
      .prepare(
        `SELECT j.value AS root FROM json_each(?1) j
         WHERE NOT EXISTS (SELECT 1 FROM keys k WHERE k.root = j.value AND k.first_day <= ?2)`,
      )
      .bind(JSON.stringify([...new Set(roots)]), day)
      .all<{ root: string }>();
    return found.results.map((one) => one.root);
  }

  async admitKey(root: string, net: string, today: number): Promise<KeyAdmitted> {
    const known = await this.#db
      .prepare("SELECT terms_version, blocked_at FROM keys WHERE root = ?")
      .bind(root)
      .first<{ terms_version: string | null; blocked_at: number | null }>();
    if (known) return { said: known.blocked_at === null ? "known" : "blocked", terms: known.terms_version };
    const taken = await this.#db
      .prepare(
        `INSERT INTO net_day (day, net, docs, bytes, keys) VALUES (?1, ?2, 0, 0, 1)
         ON CONFLICT (day, net) DO UPDATE SET keys = keys + 1 WHERE keys < ?3`,
      )
      .bind(today, net, this.#limits.newKeysADay)
      .run();
    return { said: taken.meta.changes === 0 ? "full" : "new", terms: null };
  }

  async anyBlocked(roots: string[]): Promise<boolean> {
    const found = await this.#db
      .prepare("SELECT 1 FROM keys WHERE root IN (SELECT value FROM json_each(?)) AND blocked_at IS NOT NULL LIMIT 1")
      .bind(JSON.stringify(roots))
      .first();
    return found !== null;
  }

  async keepKeys(roots: string[], today: number, accepted?: AcceptedTerms): Promise<void> {
    const others = roots.filter((root) => root !== accepted?.root);
    const statements = others.map((root) =>
      this.#db.prepare("INSERT OR IGNORE INTO keys (root, first_day) VALUES (?, ?)").bind(root, today),
    );
    if (accepted) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO keys (root, first_day, terms_version, terms_hour) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (root) DO UPDATE SET terms_version = ?3, terms_hour = ?4
             WHERE terms_version IS NULL OR CAST(terms_version AS INTEGER) < CAST(?3 AS INTEGER)`,
          )
          .bind(accepted.root, today, accepted.version, accepted.hour),
      );
    }
    if (statements.length > 0) await this.#db.batch(statements);
  }

  async giveKeysBack(count: number, net: string, today: number): Promise<void> {
    await this.#db
      .prepare("UPDATE net_day SET keys = keys - ? WHERE day = ? AND net = ?")
      .bind(count, today, net)
      .run();
  }

  // A first version refused leaves nothing behind, or each try would hold a share until its days pass.
  async forgetUnsent(id: string, net: string, today: number): Promise<void> {
    const forgotten = await this.#db
      .prepare("DELETE FROM docs WHERE id = ? AND latest = 0 RETURNING owner, anchor")
      .bind(id)
      .first<{ owner: string; anchor: string | null }>();
    if (!forgotten) return;
    await this.#giveQuotaBack(net, 1, 0, today);
    if (forgotten.anchor === null) await this.#giveShareBack(forgotten.owner, today);
  }

  async #takeRoom(net: string, bytes: number, today: number, newKey = false, uploads = 1): Promise<Uploaded> {
    if (!(await this.#takeQuota(net, 0, bytes, today, uploads))) return "quota";
    if (!newKey) return "stored";
    const taken = await this.#db
      .prepare(
        `INSERT INTO net_day (day, net, docs, bytes)
         SELECT ?1, ?2, 0, ?3 WHERE ?3 <= ?4 AND (SELECT bytes FROM net_day WHERE day = ?1 AND net = ?5) <= ?6
         ON CONFLICT (day, net) DO UPDATE SET bytes = bytes + excluded.bytes WHERE bytes + excluded.bytes <= ?4`,
      )
      .bind(today, NEW_KEYS_NET, bytes, this.#limits.newKeysBytesADay, net, this.#limits.newKeysNetBytesADay)
      .run();
    if (taken.meta.changes > 0) return "stored";
    await this.#giveQuotaBack(net, 0, bytes, today, uploads);
    return "new_keys_full";
  }

  async #giveRoomBack(net: string, bytes: number, today: number, newKey = false, uploads = 1): Promise<void> {
    await this.#giveQuotaBack(net, 0, bytes, today, uploads);
    if (newKey) await this.#giveQuotaBack(NEW_KEYS_NET, 0, bytes, today);
  }

  async #giveQuotaBack(net: string, docs: number, bytes: number, today: number, uploads = 0): Promise<void> {
    await this.#db
      .prepare("UPDATE net_day SET docs = docs - ?, bytes = bytes - ?, uploads = uploads - ? WHERE day = ? AND net = ?")
      .bind(docs, bytes, uploads, today, net)
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
      const said = String(error);
      if (said.includes("no such table")) await this.#db.prepare(this.#createSeen(today)).run();
      else if (said.includes(`no column named ${PROVED}`)) await this.#addProved(seenTable(today));
      else throw error;
      await this.#note(reading, today);
    }
  }

  async #note({ owner, reader, doc, hour, proved }: Reading, today: number): Promise<void> {
    await this.#db
      .prepare(`INSERT OR IGNORE INTO ${seenTable(today)} (owner, reader, doc, hour, proved) VALUES (?, ?, ?, ?, ?)`)
      .bind(owner, reader, doc, hour, proved ? 1 : 0)
      .run();
  }

  // A day's table made before readers carried their proof gets it the first time one arrives.
  async #addProved(table: string): Promise<void> {
    try {
      await this.#db.prepare(addProvedTo(table)).run();
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
  }

  // From any of its languages the same set, and of each only the versions a wait can look at.
  async lastVersionsWithLanguages(id: string, owner: string, count: number): Promise<Version[][]> {
    const { results } = await this.#db
      .prepare(
        `SELECT (SELECT json_group_array(json(v.value)) FROM json_each(d.versions) v
                 WHERE v.key >= json_array_length(d.versions) - ?3) AS last
         FROM docs d
         WHERE d.owner = ?2 AND d.latest > 0 AND d.paused_at IS NULL AND d.blocked_at IS NULL
           AND COALESCE((SELECT a.anchor FROM docs a WHERE a.id = ?1), ?1) IN (d.id, d.anchor)`,
      )
      .bind(id, owner, count)
      .all<{ last: string }>();
    return results.map((one) => (JSON.parse(one.last) as Version[]).sort((a, b) => a.n - b.n));
  }

  async shown(id: string, today: number): Promise<Shown | null> {
    const row = await this.#db
      .prepare(
        `SELECT d.owner, d.latest, json_extract(d.versions, '$[#-1]') AS last_version, d.dies_on, d.paused_at, d.blocked_at, d.fix_by,
           d.reviewed, json_extract(d.reviewed, '$.seq') AS reviewed_seq, d.reviewed_at,
           ${revocationsOf("json_extract(d.versions, '$[#-1]')", "?3")} AS revocations,
           CASE WHEN d.latest = ${CLAIMED} OR (d.paused_at IS NOT NULL AND d.dies_on < ?2) THEN 0
             ELSE EXISTS (SELECT 1 FROM holds h WHERE h.held = d.id) OR CASE WHEN a.id IS NULL THEN d.dies_on >= ?2
               ELSE a.latest <> ${CLAIMED} AND a.blocked_at IS NULL AND a.paused_at IS NULL
                 AND (a.dies_on >= ?2 OR EXISTS (SELECT 1 FROM holds h WHERE h.held = a.id)) END END AS alive
         FROM docs d LEFT JOIN docs a ON a.id = d.anchor WHERE d.id = ?1`,
      )
      .bind(id, today, this.#limits.editorRevocationsServed)
      .first<{
        owner: string;
        latest: number;
        last_version: string | null;
        dies_on: number;
        paused_at: number | null;
        blocked_at: number | null;
        fix_by: number | null;
        reviewed: string | null;
        reviewed_seq: number | null;
        reviewed_at: number | null;
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
      revocations: revocationsIn(row.revocations),
      reviewed:
        row.reviewed === null || row.reviewed_seq === null || row.reviewed_at === null
          ? null
          : { said: row.reviewed, seq: row.reviewed_seq, at: row.reviewed_at },
    };
  }

  async openedCase(id: string, hash: string, today: number, now: number): Promise<OpenedCase | null> {
    const [found] = await this.#db.batch<{
      version: string;
      dies_on: number;
      revocations: string;
      sealed_records: string | null;
    }>([
      this.#db
        .prepare(
          `SELECT v.value AS version, d.dies_on, c.sealed_records, ${revocationsOf("v.value", "?4")} AS revocations
           FROM cases c JOIN docs d ON d.id = c.doc
             JOIN json_each(d.versions) v ON json_extract(v.value, '$.n') = c.version
           WHERE c.token_hash = ?1 AND c.doc = ?2 AND c.until >= ?3`,
        )
        .bind(hash, id, today, this.#limits.editorRevocationsServed),
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO openings (doc, at, reason, kind)
           SELECT ?2, ?4, ?5, 'case' FROM cases WHERE token_hash = ?1 AND doc = ?2 AND until >= ?3`,
        )
        .bind(hash, id, today, now, `case ${caseNameOf(hash)}`),
    ]);
    const row = found?.results[0];
    if (!row) return null;
    return {
      version: JSON.parse(row.version) as Version,
      diesOn: row.dies_on,
      revocations: revocationsIn(row.revocations),
      sealedRecords: row.sealed_records,
    };
  }

  async envelope(id: string, version: Version): Promise<ReadableStream | null> {
    return (await this.#envelopes.get(objectKey(id, version)))?.body ?? null;
  }

  async filesBytes(id: string, hash: string): Promise<number | null> {
    return (await this.#envelopes.head(filesKey(id, hash)))?.size ?? null;
  }

  // Checked in the write, as versions are, so attachments sent at once cannot each see the room empty.
  async keepFiles(
    { id, hash, body, net, newKey, roomAtMost }: KeptFiles,
    today: number,
  ): Promise<"stored" | "quota" | "new_keys_full" | "room_full" | "behind"> {
    // Attachments are part of the version already counted as an upload.
    const room = await this.#takeRoom(net, body.length, today, newKey, 0);
    if (room !== "stored") return room === "new_keys_full" ? room : "quota";
    const key = filesKey(id, hash);
    try {
      await this.#envelopes.put(key, body);
    } catch (error) {
      await this.#giveRoomBack(net, body.length, today, newKey, 0);
      throw error;
    }
    // A version that found these files in storage already counted them in its own checked write, so they stay its own.
    const kept = await this.#db
      .prepare(
        `UPDATE docs SET files_bytes = ?1, versions = json_set(versions, '$[#-1].filesKept', 1)
         WHERE id = ?2 AND json_extract(versions, '$[#-1].files') = ?3 AND json_extract(versions, '$[#-1].filesKept') IS NULL
           AND (files_bytes = ?1 OR ?1 + COALESCE(json_extract(versions, '$[#-1].bytes'), 0) + (SELECT COALESCE(SUM(${HELD_BYTES}), 0)
             FROM docs d WHERE d.owner = docs.owner AND d.id <> docs.id AND ${HOLDS_ROOM("?4")}) <= ?5)`,
      )
      .bind(body.length, id, hash, today, roomAtMost)
      .run();
    if (kept.meta.changes > 0) return "stored";
    await this.#giveRoomBack(net, body.length, today, newKey, 0);
    const named = await this.#db
      .prepare(
        "SELECT json_extract(versions, '$[#-1].filesKept') AS kept FROM docs WHERE id = ? AND json_extract(versions, '$[#-1].files') = ?",
      )
      .bind(id, hash)
      .first<{ kept: number | null }>();
    // The same files sent at once: one write kept them for this version, the object is theirs too, charged once.
    if (named?.kept === 1) return "stored";
    await this.#envelopes.delete(key);
    return named ? "room_full" : "behind";
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

  async sharedToday(owner: string, today: number): Promise<number> {
    const counted = await this.#db
      .prepare("SELECT n FROM net_hour WHERE net = ?1 AND action = ?2 AND hour = ?3")
      .bind(sharesCounterOf(owner), SHARES_OF_A_DAY, today * HOURS_IN_A_DAY)
      .first<{ n: number }>();
    return counted?.n ?? 0;
  }

  #takeShare(owner: string, today: number): Promise<boolean> {
    return this.takeHourly(sharesCounterOf(owner), SHARES_OF_A_DAY, today * HOURS_IN_A_DAY, this.#limits.newSharesADay);
  }

  async #giveShareBack(owner: string, today: number): Promise<void> {
    await this.#db
      .prepare("UPDATE net_hour SET n = n - 1 WHERE net = ?1 AND action = ?2 AND hour = ?3 AND n > 0")
      .bind(sharesCounterOf(owner), SHARES_OF_A_DAY, today * HOURS_IN_A_DAY)
      .run();
  }

  #createSeen(day: number): string {
    return `CREATE TABLE IF NOT EXISTS ${seenTable(day)} (
      owner TEXT NOT NULL, reader TEXT NOT NULL, doc TEXT NOT NULL, hour INTEGER NOT NULL, ${PROVED_COLUMN},
      PRIMARY KEY (owner, reader, doc)
    ) WITHOUT ROWID`;
  }

  async report(report: Report, today: number, hour: number): Promise<Reported> {
    const level = levelOfReport(report.category);
    if (!level) return { blocked: false };
    const [, moved] = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO reports (doc, net, at, category, detail, sealed_link, asn, at_hour, level, version, sealed_contact, over_cap)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
             CASE WHEN EXISTS (SELECT 1 FROM json_each(d.versions) v WHERE json_extract(v.value, '$.n') = ?10)
               THEN ?10 ELSE d.latest END,
             ?11,
             ?9 <> 'light' AND
               (SELECT COUNT(*) FROM reports x
                WHERE x.net = ?2 AND x.doc <> ?1 AND x.level <> 'light' AND x.cleared = 0 AND x.over_cap = 0) >= ?12
           FROM docs d WHERE d.id = ?1 AND ${STILL_LIVES("d", "?3")}
           ON CONFLICT (doc, net) DO UPDATE
             SET at = CASE WHEN reports.cleared = 1 THEN excluded.at
                   WHEN EXISTS (SELECT 1 FROM false_reporters f WHERE f.net = excluded.net) THEN reports.at
                   WHEN ${REPORT_MOVES} THEN excluded.at ELSE reports.at END,
                 at_hour = CASE WHEN reports.cleared = 1 THEN excluded.at_hour
                   WHEN EXISTS (SELECT 1 FROM false_reporters f WHERE f.net = excluded.net) THEN reports.at_hour
                   WHEN ${REPORT_MOVES} THEN excluded.at_hour ELSE reports.at_hour END,
                 asn = CASE WHEN ${REPORT_MOVES} THEN excluded.asn ELSE reports.asn END,
                 category = CASE WHEN ${REPORT_REPLACES} THEN excluded.category ELSE reports.category END,
                 level = CASE WHEN ${REPORT_REPLACES} THEN excluded.level ELSE reports.level END,
                 version = CASE WHEN ${REPORT_REPLACES} THEN excluded.version ELSE reports.version END,
                 detail = CASE WHEN reports.cleared = 1 THEN excluded.detail
                   WHEN ${REPORT_MOVES} THEN COALESCE(excluded.detail, reports.detail) ELSE reports.detail END,
                 sealed_link = CASE WHEN reports.cleared = 1 THEN excluded.sealed_link
                   ELSE COALESCE(reports.sealed_link, excluded.sealed_link) END,
                 sealed_contact = CASE WHEN ${REPORT_REPLACES} THEN excluded.sealed_contact
                   ELSE COALESCE(reports.sealed_contact, excluded.sealed_contact) END,
                 cleared = 0
             WHERE ${REPORT_MOVES} OR (reports.cleared = 0 AND reports.sealed_contact IS NULL AND excluded.sealed_contact IS NOT NULL)`,
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
          report.sealedContact ?? null,
          this.#limits.docsANetCountsIn,
        ),
      level === "light" ? this.#warnAuthor(report.doc, today, hour) : this.#blockWhenItCounts(report.doc, today, hour),
    ]);
    return { blocked: level !== "light" && (moved?.meta.changes ?? 0) > 0 };
  }

  #warnAuthor(doc: string, today: number, hour: number): D1PreparedStatement {
    const inTheWindow = `${LIGHT_REPORT} AND r.at_hour > ?6`;
    return this.#db
      .prepare(
        `UPDATE docs SET fix_by = ?1 + ?2
         WHERE id = ?3 AND fix_by IS NULL AND blocked_at IS NULL
           AND (SELECT COUNT(*) FROM reports r WHERE r.doc = ?3 AND ${inTheWindow}) >= ?4
           AND (SELECT COUNT(DISTINCT r.asn) FROM reports r WHERE r.doc = ?3 AND ${inTheWindow}) >= ?5`,
      )
      .bind(
        today,
        this.#limits.lightFixDays,
        doc,
        this.#limits.lightReportsToWarn,
        this.#limits.lightOperatorsToWarn,
        hour - this.#limits.lightWarnHours,
      );
  }

  #blockWhenItCounts(doc: string, today: number, hour: number): D1PreparedStatement {
    return this.#db
      .prepare(
        `UPDATE docs SET blocked_at = ?1, blocked_hour = ?6, dies_on = ?1 + ?2
         WHERE id = ?3 AND blocked_at IS NULL
           AND (SELECT COUNT(*) FROM reports r WHERE r.doc = ?3 AND ${COUNTS_TODAY}) >= ?4
           AND (SELECT COUNT(DISTINCT r.asn) FROM reports r WHERE r.doc = ?3 AND ${COUNTS_TODAY}) >= ?5`,
      )
      .bind(
        today,
        this.#limits.evidenceDays,
        doc,
        this.#limits.reportsToBlock,
        this.#limits.reportOperatorsToBlock,
        hour,
        this.#limits.blocksANetHelpsADay,
      );
  }

  // Past its days and not blocked, it looks gone, or the admin link would give away an order that keeps it (decision 42).
  async owned(id: string, today: number): Promise<Owned | null> {
    const row = await this.#db
      .prepare(
        `SELECT d.admin_hash, d.latest, d.dies_on, d.paused_at, d.blocked_at, d.appealed_at, d.counts_from, d.blocked_by_operator, d.fix_by, d.read_total, d.days
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
        counts_from: number;
        blocked_by_operator: number;
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
        mayCorrect: mayCorrect(row),
        fixBy: row.fix_by,
        readTotal: row.read_total,
        days: JSON.parse(row.days),
      },
    };
  }

  // Nobody needs to read anything to see who signed, so only what that cannot settle goes to the operator (decision 146).
  async appeal(id: string, today: number, hour: number): Promise<Appealed> {
    const cleared = await this.#db
      .prepare(
        `UPDATE docs SET appealed_at = ?2, permit = NULL, counts_from = latest + 1
         WHERE id = ?1 AND blocked_at IS NOT NULL AND appealed_at IS NULL AND blocked_by_operator = 0 AND counts_from = 0
           AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.doc = docs.id AND r.category = 'csam' AND ${REPORT_AS_EVIDENCE})
           AND EXISTS (SELECT 1 FROM reports r WHERE r.doc = docs.id AND ${COUNTS_NOW})
           AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.doc = docs.id AND ${COUNTS_NOW} AND ${SIGNED_BY_OWNER})`,
      )
      .bind(id, today)
      .run();
    if (cleared.meta.changes > 0) return "accepted";
    await this.#db
      .prepare(
        `UPDATE docs SET appealed_at = ?2, appealed_hour = ?3
         WHERE id = ?1 AND blocked_at IS NOT NULL AND appealed_at IS NULL`,
      )
      .bind(id, today, hour)
      .run();
    return "review";
  }

  appealAccepted(id: string, today: number): Promise<void> {
    return acceptAppeal(this.#db, this.#limits, id, today);
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
  async #blockWhatWaited(today: number, hour: number): Promise<void> {
    const waiting = await this.#db
      .prepare(
        `SELECT docs.id FROM docs JOIN reports r ON r.doc = docs.id
         WHERE docs.blocked_at IS NULL AND ${STILL_LIVES("docs", "?1")} AND ${COUNTS_NOW}
         GROUP BY docs.id HAVING COUNT(*) >= ?2 AND COUNT(DISTINCT r.asn) >= ?4 ORDER BY MIN(r.at), docs.id LIMIT ?3`,
      )
      .bind(today, this.#limits.reportsToBlock, this.#limits.sweptAtOnce, this.#limits.reportOperatorsToBlock)
      .all<{ id: string }>();
    if (waiting.results.length === 0) return;
    await this.#db.batch(waiting.results.map(({ id }) => this.#blockWhenItCounts(id, today, hour)));
  }

  async sweep(today: number, hour = today * HOURS_IN_A_DAY): Promise<Swept> {
    await this.#db.batch([this.#db.prepare(this.#createSeen(today)), this.#db.prepare(this.#createSeen(today + 1))]);
    const { summed, failed: failedDays } = await this.#sumPastDays(today);
    let forgotten = 0;
    let failed = failedDays;
    try {
      // Replaced here too, so a quiet day or period does not leave an old key in storage.
      await this.dayKey(today);
      await this.evidenceKey(today);
    } catch (error) {
      failed += 1;
      console.error("the day's key could not be replaced", String(error));
    }
    try {
      await this.#blockWhatWaited(today, hour);
    } catch (error) {
      failed += 1;
      console.error("what waited to be blocked could not be", String(error));
    }
    // A block stops the reads that keep documents alive, so an attack must not be able to erase them (decision 118).
    if (failedDays === 0 && (await this.stage()) !== "blocked") {
      try {
        forgotten = await this.#forget(await this.#expired(today), today);
      } catch (error) {
        failed += 1;
        console.error("what expired could not be forgotten", String(error));
      }
      try {
        await this.#trimReplaced(today, hour * HOUR_MS);
      } catch (error) {
        failed += 1;
        console.error("replaced versions could not be let go", String(error));
      }
    }
    try {
      await this.#db.batch([
        this.#addUploadsToService(today - 1),
        // Yesterday's stays: the digest at 00:00 counts its new keys, on the same minute as this sweep.
        this.#db.prepare("DELETE FROM net_day WHERE day < ?").bind(today - 1),
        this.#db.prepare("DELETE FROM net_doc WHERE day < ?").bind(today - 1),
        this.#db.prepare("DELETE FROM doc_day WHERE day < ?").bind(today - DOC_DAYS_KEPT),
        this.#db.prepare("DELETE FROM net_hour WHERE hour < ?").bind(today * HOURS_IN_A_DAY),
        this.#db.prepare("DELETE FROM false_reporters WHERE at < ?").bind(today - this.#limits.evidenceDays),
        this.#db.prepare("DELETE FROM cases WHERE until < ?").bind(today),
        this.#db
          .prepare(
            `DELETE FROM reports WHERE at < ?1
             AND doc NOT IN (SELECT id FROM docs WHERE legal_until >= ?2)`,
          )
          .bind(today - this.#limits.evidenceDays, today),
        ...["moderation", "openings"].map((log) =>
          this.#db
            .prepare(
              `DELETE FROM ${log} WHERE at < ?1
               AND doc NOT IN (SELECT id FROM docs WHERE legal_until >= ?2 UNION SELECT owner FROM docs WHERE legal_until >= ?2)`,
            )
            .bind((today - this.#limits.evidenceDays) * DAY_MS, today),
        ),
      ]);
    } catch (error) {
      failed += 1;
      console.error("the old rows could not be cleaned", String(error));
    }
    // Once a day, when it adds the day up, so an hourly sweep with nothing to do still writes nothing.
    if (failed === 0 && summed > 0) await this.#noteSwept(hour);
    return { summed, forgotten, failed };
  }

  // A replaced version stays 3 days even with no upload after it, as the privacy policy says.
  async #trimReplaced(today: number, now: number): Promise<void> {
    const cursor = await this.#db
      .prepare("SELECT trim_after FROM service_stage WHERE id = 1")
      .first<{ trim_after: string }>();
    // From where the last run stopped, so documents a report or an order keeps cannot hold the rest back.
    const rows = await this.#db
      .prepare(
        `SELECT id, versions FROM docs
         WHERE id > ?4 AND latest > 0 AND COALESCE(legal_until, 0) < ?5
           AND json_array_length(versions) > ?1 AND json_extract(versions, '$[1].at') <= ?2
         ORDER BY id LIMIT ?3`,
      )
      .bind(
        this.#limits.versionsKept,
        now - this.#limits.replacedKeptDays * DAY_MS,
        TRIMMED_AT_ONCE,
        cursor?.trim_after ?? "",
        today,
      )
      .all<{ id: string; versions: string }>();
    for (const row of rows.results) {
      const all = JSON.parse(row.versions) as Version[];
      const trimmed = keptVersions(all, now, this.#limits);
      if (trimmed.length === all.length) continue;
      const kept = await this.#withEvidence(row.id, today, all, trimmed);
      if (kept.length === all.length) continue;
      const dropped = all.filter((one) => !kept.includes(one));
      // Checked again in the write: a report or an order that arrived meanwhile keeps what it is about.
      const moved = await this.#db
        .prepare(
          `UPDATE docs SET versions = ?1, bytes = ?2
           WHERE id = ?3 AND versions = ?4 AND COALESCE(legal_until, 0) < ?6
             AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.doc = ?3
               AND r.version IN (SELECT value FROM json_each(?5)) AND ${REPORT_AS_EVIDENCE})`,
        )
        .bind(
          JSON.stringify(kept),
          kept.reduce((sum, one) => sum + one.bytes, 0),
          row.id,
          row.versions,
          JSON.stringify(dropped.map((one) => one.n)),
          today,
        )
        .run();
      if (moved.meta.changes === 0) continue;
      const stillNamed = new Set(filesKeysOf(row.id, kept));
      const filesGone = filesKeysOf(row.id, dropped).filter((key) => !stillNamed.has(key));
      await this.#envelopes.delete([...dropped.map((one) => objectKey(row.id, one)), ...filesGone]);
    }
    const next = rows.results.length < TRIMMED_AT_ONCE ? "" : (rows.results.at(-1)?.id ?? "");
    // Written only when it moves, so an idle sweep still writes nothing.
    if (next === (cursor?.trim_after ?? "")) return;
    await this.#db
      .prepare(
        `INSERT INTO service_stage (id, stage, trim_after) VALUES (1, 'open', ?1)
         ON CONFLICT (id) DO UPDATE SET trim_after = excluded.trim_after`,
      )
      .bind(next)
      .run();
  }

  async #noteSwept(hour: number): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO service_stage (id, stage, swept_hour) VALUES (1, 'open', ?1)
         ON CONFLICT (id) DO UPDATE SET swept_hour = excluded.swept_hour`,
      )
      .bind(hour)
      .run();
  }

  async noteSpend({ bill, line, storedGb }: Spent, at: number): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO service_stage (id, stage, bill, line, stored_gb, spent_at) VALUES (1, 'open', ?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO UPDATE SET bill = ?1, line = ?2, stored_gb = ?3, spent_at = ?4`,
      )
      .bind(bill, line, storedGb, at)
      .run();
  }

  // Assigned, not added, so every sweep of the day can say it again, and only a change writes.
  #addUploadsToService(day: number): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT INTO service_day (day, readers, docs, hours, uploads, new_docs, new_keys)
         SELECT ?1, 0, 0, '{}', SUM(uploads), SUM(docs), SUM(keys) FROM net_day WHERE day = ?1 HAVING COUNT(*) > 0
         ON CONFLICT (day) DO UPDATE
           SET uploads = excluded.uploads, new_docs = excluded.new_docs, new_keys = excluded.new_keys
           WHERE uploads <> excluded.uploads OR new_docs <> excluded.new_docs OR new_keys <> excluded.new_keys`,
      )
      .bind(day);
  }

  async #sumPastDays(today: number): Promise<{ summed: number; failed: number }> {
    const tables = await this.#db
      .prepare(
        `SELECT name, instr(sql, '${PROVED}') > 0 AS proved FROM sqlite_master
         WHERE type = 'table' AND name GLOB 'seen_[0-9]*'`,
      )
      .all<{ name: string; proved: number }>();
    const days = tables.results
      .map((one) => ({ day: Number(one.name.slice("seen_".length)), proved: one.proved === 1 }))
      .filter(({ day }) => day < today)
      .sort((a, b) => a.day - b.day);
    let summed = 0;
    let failed = 0;
    for (const { day, proved } of days) {
      const table = seenTable(day);
      try {
        // In one batch, so a day is either counted and gone or still there to count: never lost, never counted twice.
        await this.#db.batch([
          ...(proved ? [] : [this.#db.prepare(addProvedTo(table))]),
          this.#addToDocs(table, day),
          this.#addToService(table, day),
          this.#addToDocDays(table, day),
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

  // A day added up twice was read by more than one network, so the uploader was not alone.
  #addToDocDays(table: string, day: number): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT INTO doc_day (doc, day, nets, proved, hours, peak, by_uploader)
         SELECT h.doc, ?1, SUM(h.n), SUM(h.p), COUNT(*), MAX(h.n),
           SUM(h.n) = 1 AND EXISTS (
             SELECT 1 FROM ${table} s JOIN net_doc u ON u.day = ?1 AND u.doc = s.doc AND u.net = s.reader WHERE s.doc = h.doc
           )
         FROM (SELECT doc, hour, COUNT(*) AS n, SUM(${PROVED}) AS p FROM ${table} GROUP BY doc, hour) h
         WHERE EXISTS (SELECT 1 FROM docs d WHERE d.id = h.doc)
         GROUP BY h.doc
         ON CONFLICT (doc, day) DO UPDATE SET nets = nets + excluded.nets, proved = proved + excluded.proved,
           hours = MAX(hours, excluded.hours), peak = MAX(peak, excluded.peak), by_uploader = 0`,
      )
      .bind(day);
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
      this.#db.prepare("DELETE FROM doc_day WHERE doc IN (SELECT value FROM json_each(?))").bind(ids),
    ]);
    return deleted?.meta.changes ?? 0;
  }

  async spentAt(): Promise<number | null> {
    const row = await this.#db
      .prepare("SELECT spent_at FROM service_stage WHERE id = 1")
      .first<{ spent_at: number | null }>();
    return row?.spent_at ?? null;
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
    const newKeysDay = Math.floor((before - 1) / HOURS_IN_A_DAY);
    const newReports = "FROM reports WHERE at_hour > ?1 AND at_hour < ?2 AND cleared = 0 AND level <> 'light'";
    const [reports, totals, blocked, appealed, keys] = await this.#db.batch([
      this.#db
        .prepare(
          `SELECT doc, category, COUNT(*) AS nets, SUM(not_counting) AS uncounted FROM (
             SELECT doc, category, level, (over_cap = 1 OR net IN (SELECT net FROM false_reporters)) AS not_counting,
               ROW_NUMBER() OVER (PARTITION BY net ORDER BY ${GRAVEST_FIRST}, at_hour) AS in_its_net
             ${newReports}
           )
           GROUP BY doc, category
           ORDER BY MIN(in_its_net), ${GRAVEST_FIRST}, SUM(NOT not_counting) DESC, doc LIMIT ?3`,
        )
        .bind(after, before, atMost),
      this.#db
        .prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT doc || '|' || category) AS listed ${newReports}`)
        .bind(after, before),
      this.#db
        .prepare("SELECT id FROM docs WHERE blocked_hour > ?1 AND blocked_hour < ?2 ORDER BY id LIMIT ?3")
        .bind(after, before, atMost),
      this.#db
        .prepare("SELECT id FROM docs WHERE appealed_hour > ?1 AND appealed_hour < ?2 ORDER BY id LIMIT ?3")
        .bind(after, before, atMost),
      this.#db
        .prepare(
          `SELECT COALESCE(SUM(keys), 0) AS keys, COALESCE(SUM(CASE WHEN net = ?2 THEN bytes END), 0) AS new_keys_bytes
           FROM net_day WHERE day = ?1`,
        )
        .bind(newKeysDay, NEW_KEYS_NET),
    ]);
    const ids = (rows: typeof blocked): string[] => ((rows?.results ?? []) as { id: string }[]).map(({ id }) => id);
    return {
      reports: (reports?.results ?? []) as News["reports"],
      reportsTotal: (totals?.results?.[0] as { n: number } | undefined)?.n ?? 0,
      reportLines: (totals?.results?.[0] as { listed: number } | undefined)?.listed ?? 0,
      blocked: ids(blocked),
      appealed: ids(appealed),
      newKeys: (keys?.results?.[0] as { keys: number } | undefined)?.keys ?? 0,
      newKeysDay,
      newKeysNearTheirTop:
        ((keys?.results?.[0] as { new_keys_bytes: number } | undefined)?.new_keys_bytes ?? 0) >=
        this.#limits.newKeysBytesADay * NEW_KEYS_NOTICED_AT,
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
        .prepare("SELECT id, versions FROM docs WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(ids))
        .all<{ id: string; versions: string }>();
      const known = new Set(held.results.map((one) => one.id));
      // What a document's versions still name; anything else under it is what a failed delete left.
      const named = new Set(
        held.results.flatMap(({ id, versions }) => {
          const listed = JSON.parse(versions) as Version[];
          return [...listed.map((one) => objectKey(id, one)), ...filesKeysOf(id, listed)];
        }),
      );
      const old = now - DAY_MS;
      const orphans = page.objects.filter(
        (one) =>
          !one.key.startsWith(KEY_OBJECTS) &&
          one.uploaded.getTime() < old &&
          (!known.has(idOf(one.key)) || !named.has(one.key)),
      );
      if (orphans.length > 0) await this.#envelopes.delete(orphans.map((one) => one.key));
      forgotten += orphans.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return forgotten;
  }
}
