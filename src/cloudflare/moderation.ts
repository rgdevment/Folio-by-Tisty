import { caseNameOf } from "../core/case-records";
import { dayOf, LEVEL_ONE, type Limits } from "../core/limits";
import type { Queue, QueuedReport } from "../core/queue";
import { hourOf } from "../core/start";

export type Acted = "done" | "missing";

export interface NewCase {
  version: number;
  tokenHash: string;
  sealedRecords?: string;
}

const SEEN_AT_MOST = 200;
const CASE_LINK_DAYS = 30;
const RECORD_ROWS_AT_MOST = 200;
const REPORT_ROWS_AT_MOST = 1000;
const REPORTS_BYTES_IN_RECORDS = 300_000;
const CASE_FOR_THE_AUTHORITY = "c.doc = ?1 AND c.sealed_records IS NOT NULL AND c.until >= ?2";
const READY_TO_HAND_OVER = `EXISTS (SELECT 1 FROM docs d WHERE d.id = ?1 AND d.blocked_by_operator = 1)
  AND EXISTS (SELECT 1 FROM cases c WHERE ${CASE_FOR_THE_AUTHORITY})`;

const reportsThatFit = (reports: unknown[]): { kept: unknown[]; leftOut: number } => {
  const kept: unknown[] = [];
  let bytes = 0;
  for (const report of reports) {
    bytes += new TextEncoder().encode(JSON.stringify(report)).length;
    if (bytes > REPORTS_BYTES_IN_RECORDS) break;
    kept.push(report);
  }
  return { kept, leftOut: reports.length - kept.length };
};
const REPORTS_TO_SEE = "FROM reports r WHERE r.level <> 'light' AND r.cleared = 0";

export const mayCorrect = (row: {
  blocked_at: number | null;
  blocked_by_operator: number;
  counts_from: number;
  latest: number;
}): boolean => row.blocked_at !== null && row.blocked_by_operator === 0 && row.counts_from > row.latest;

const acceptingAppeal = (
  db: D1Database,
  { pausedDays }: Pick<Limits, "pausedDays">,
  id: string,
  today: number,
): D1PreparedStatement[] => [
  // Clears them and keeps them as a record. A network shared in good faith pays only if a report is found false.
  db
    .prepare(
      "UPDATE reports SET cleared = 1 WHERE doc = ?1 AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND blocked_at IS NOT NULL)",
    )
    .bind(id),
  db
    .prepare(
      `UPDATE docs SET blocked_at = NULL, appealed_at = NULL, blocked_hour = NULL, appealed_hour = NULL, fix_by = NULL, blocked_by_operator = 0,
           dies_on = CASE WHEN paused_at IS NULL THEN ?1 + ttl_days ELSE paused_at + ?2 END
         WHERE id = ?3 AND blocked_at IS NOT NULL`,
    )
    .bind(today, pausedDays, id),
];

export const acceptAppeal = async (
  db: D1Database,
  limits: Pick<Limits, "pausedDays">,
  id: string,
  today: number,
): Promise<void> => {
  await db.batch(acceptingAppeal(db, limits, id, today));
};

export class CloudModeration {
  readonly #db: D1Database;
  readonly #limits: Limits;

  constructor(db: D1Database, limits: Limits = LEVEL_ONE) {
    this.#db = db;
    this.#limits = limits;
  }

  async queue(now: number): Promise<Queue> {
    const [stage, keys, reports, reportsTotal, docs] = await this.#db.batch([
      this.#db.prepare("SELECT stage FROM service_stage WHERE id = 1"),
      this.#db.prepare("SELECT COALESCE(SUM(keys), 0) AS n FROM net_day WHERE day = ?").bind(dayOf(now)),
      this.#db
        .prepare(
          `SELECT r.doc, r.net, r.category, r.level, r.detail, r.sealed_link, r.version, r.at, r.asn,
             r.net IN (SELECT net FROM false_reporters) AS false_net
           ${REPORTS_TO_SEE}
           ORDER BY r.category = 'csam' DESC, r.level = 'grave' DESC, r.at DESC, r.doc LIMIT ?`,
        )
        .bind(SEEN_AT_MOST),
      this.#db.prepare(`SELECT COUNT(*) AS n ${REPORTS_TO_SEE}`),
      this.#db
        .prepare(
          `SELECT id, owner, latest, versions, blocked_at, appealed_at, appealed_hour, counts_from, blocked_by_operator,
             COALESCE(
               (SELECT MAX(r.version) FROM reports r
                WHERE r.doc = docs.id AND r.cleared = 0 AND r.level <> 'light'
                  AND EXISTS (SELECT 1 FROM json_each(docs.versions) v WHERE json_extract(v.value, '$.n') = r.version)),
               latest
             ) AS version_to_open,
             blocked_by_operator = 1
               AND EXISTS (SELECT 1 FROM reports r WHERE r.doc = docs.id AND r.sealed_link IS NOT NULL)
               AND EXISTS (SELECT 1 FROM cases c WHERE c.doc = docs.id AND c.sealed_records IS NOT NULL AND c.until >= ?2)
               AS may_hand_over
           FROM docs WHERE blocked_at IS NOT NULL
           ORDER BY appealed_hour IS NULL, blocked_at DESC, id LIMIT ?1`,
        )
        .bind(SEEN_AT_MOST, dayOf(now)),
    ]);
    return {
      stage: (stage?.results?.[0] as { stage: string } | undefined)?.stage ?? "open",
      newKeys: (keys?.results?.[0] as { n: number } | undefined)?.n ?? 0,
      reportsTotal: (reportsTotal?.results?.[0] as { n: number } | undefined)?.n ?? 0,
      reports: (
        (reports?.results ?? []) as (Omit<QueuedReport, "sealedLink" | "fromFalseNet"> & {
          sealed_link: string | null;
          false_net: number;
        })[]
      ).map(({ sealed_link: sealedLink, false_net: falseNet, ...report }) => ({
        ...report,
        sealedLink,
        fromFalseNet: falseNet === 1,
      })),
      docs: (
        (docs?.results ?? []) as {
          id: string;
          owner: string;
          latest: number;
          versions: string;
          blocked_at: number;
          appealed_at: number | null;
          appealed_hour: number | null;
          counts_from: number;
          blocked_by_operator: number;
          version_to_open: number;
          may_hand_over: number;
        }[]
      ).map((row) => ({
        id: row.id,
        latest: row.latest,
        blockedAt: row.blocked_at,
        appealedAt: row.appealed_at,
        waitsForOperator: row.appealed_hour !== null,
        mayCorrect: mayCorrect(row),
        versionToOpen: row.version_to_open,
        mayHandOver: row.may_hand_over === 1,
        signers: (JSON.parse(row.versions) as { n: number; signer: string }[]).map(({ n, signer }) => ({
          n,
          byOwner: signer === row.owner,
        })),
      })),
    };
  }

  async accept(id: string, now: number): Promise<Acted> {
    const today = dayOf(now);
    const lifting = [
      this.#db
        .prepare(
          "DELETE FROM cases WHERE doc = ?1 AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND blocked_at IS NOT NULL)",
        )
        .bind(id),
      // A panic never holds past the evidence period, so what does came from an order and stays.
      this.#db
        .prepare("UPDATE docs SET legal_until = NULL WHERE id = ?1 AND blocked_at IS NOT NULL AND legal_until <= ?2")
        .bind(id, today + this.#limits.evidenceDays),
      ...acceptingAppeal(this.#db, this.#limits, id, today),
    ];
    return this.#actedAndLogged(lifting, this.#logIfChanged(id, "accept", now));
  }

  // The appeal stays spent: it leaves the operator's queue, and the block stands.
  async reject(id: string, now: number): Promise<Acted> {
    const rejecting = this.#db
      .prepare(
        "UPDATE docs SET appealed_hour = NULL WHERE id = ? AND blocked_at IS NOT NULL AND appealed_hour IS NOT NULL",
      )
      .bind(id);
    return this.#actedAndLogged([rejecting], this.#logIfChanged(id, "reject", now));
  }

  // A block that reports already placed is taken over too, or its owner could still lift it after this decision.
  async block(id: string, note: string, now: number): Promise<Acted> {
    const blocking = this.#db
      .prepare(
        `UPDATE docs SET blocked_by_operator = 1, blocked_at = COALESCE(blocked_at, ?1),
           blocked_hour = COALESCE(blocked_hour, ?2), dies_on = ?1 + ?3
         WHERE id = ?4 AND latest >= 0 AND blocked_by_operator = 0`,
      )
      .bind(dayOf(now), hourOf(now), this.#limits.evidenceDays, id);
    return this.#actedAndLogged([blocking], this.#logIfChanged(id, "block", now, note));
  }

  async panic(id: string, note: string, now: number): Promise<unknown> {
    const today = dayOf(now);
    const until = today + this.#limits.evidenceDays;
    const holding = this.#db
      .prepare(
        `UPDATE docs SET blocked_by_operator = 1, blocked_at = COALESCE(blocked_at, ?1),
           blocked_hour = COALESCE(blocked_hour, ?2), dies_on = CASE WHEN blocked_at IS NULL THEN ?3 ELSE dies_on END,
           legal_until = MAX(COALESCE(legal_until, 0), ?3)
         WHERE id = ?4 AND latest >= 0`,
      )
      .bind(today, hourOf(now), until, id);
    const acted = await this.#actedAndLogged([holding], this.#logIfChanged(id, "panic", now, note));
    return acted === "done" ? this.#records(id) : null;
  }

  async makeCase(id: string, made: NewCase, now: number): Promise<Acted> {
    const adding = this.#db
      .prepare(
        `INSERT OR IGNORE INTO cases (token_hash, doc, version, until, sealed_records)
         SELECT ?1, d.id, ?2, ?3, ?4 FROM docs d
         WHERE d.id = ?5 AND EXISTS (SELECT 1 FROM json_each(d.versions) v WHERE json_extract(v.value, '$.n') = ?2)`,
      )
      .bind(made.tokenHash, made.version, dayOf(now) + CASE_LINK_DAYS, made.sealedRecords ?? null, id);
    const purpose = made.sealedRecords === undefined ? "verify" : "authority";
    const note = `${purpose} v${made.version} ${caseNameOf(made.tokenHash)}`;
    return this.#actedAndLogged([adding], this.#logIfChanged(id, "case", now, note));
  }

  async handedOver(id: string, now: number): Promise<Acted> {
    const today = dayOf(now);
    const endingVerifyLinks = this.#db
      .prepare(`DELETE FROM cases WHERE doc = ?1 AND sealed_records IS NULL AND ${READY_TO_HAND_OVER}`)
      .bind(id, today);
    const erasing = this.#db
      .prepare(
        `UPDATE reports SET sealed_link = NULL WHERE doc = ?1 AND sealed_link IS NOT NULL AND ${READY_TO_HAND_OVER}`,
      )
      .bind(id, today);
    return this.#actedAndLogged([endingVerifyLinks, erasing], this.#logIfChanged(id, "handed_over", now));
  }

  // Never who reported: not the network, nor its provider, nor the link it sealed (decision 152).
  async #records(id: string): Promise<unknown> {
    const [doc, reports, actions, openings, ownerKey] = await this.#db.batch([
      this.#db
        .prepare("SELECT owner, latest, versions, blocked_at, dies_on, legal_until FROM docs WHERE id = ?")
        .bind(id),
      this.#db
        .prepare(
          `SELECT category, level, detail, version, at, cleared FROM reports WHERE doc = ?
           ORDER BY category = 'csam' DESC, level = 'grave' DESC, at LIMIT ?`,
        )
        .bind(id, REPORT_ROWS_AT_MOST),
      this.#db
        .prepare("SELECT at, action, note FROM moderation WHERE doc = ? ORDER BY at DESC LIMIT ?")
        .bind(id, RECORD_ROWS_AT_MOST),
      this.#db
        .prepare("SELECT at, reason FROM openings WHERE doc = ? ORDER BY at DESC LIMIT ?")
        .bind(id, RECORD_ROWS_AT_MOST),
      this.#db
        .prepare(
          `SELECT k.first_day, k.terms_version, k.terms_hour FROM keys k
           WHERE k.root = (SELECT owner FROM docs WHERE id = ?)`,
        )
        .bind(id),
    ]);
    const row = doc?.results[0] as { versions: string } & Record<string, unknown>;
    const { kept, leftOut } = reportsThatFit(reports?.results ?? []);
    return {
      id,
      ...row,
      versions: JSON.parse(row.versions) as unknown,
      ownerKey: ownerKey?.results[0] ?? null,
      reports: kept,
      reportsLeftOut: leftOut,
      actions: actions?.results ?? [],
      openings: openings?.results ?? [],
    };
  }

  async reportWasFalse(id: string, net: string, now: number): Promise<Acted> {
    const naming = this.#db
      .prepare(
        `INSERT INTO false_reporters (net, at)
         SELECT net, ?3 FROM reports WHERE doc = ?1 AND net = ?2 AND cleared = 0
         ON CONFLICT (net) DO UPDATE SET at = excluded.at`,
      )
      .bind(id, net, dayOf(now));
    const clearing = this.#db
      .prepare("UPDATE reports SET cleared = 1 WHERE doc = ?1 AND net = ?2 AND cleared = 0")
      .bind(id, net);
    return this.#actedAndLogged([naming, clearing], this.#logIfChanged(id, "false_report", now));
  }

  async opened(id: string, reason: string, now: number): Promise<Acted> {
    await this.#db
      .prepare("INSERT OR IGNORE INTO openings (doc, at, reason) VALUES (?, ?, ?)")
      .bind(id, now, reason)
      .run();
    return "done";
  }

  async #actedAndLogged(acting: D1PreparedStatement[], log: D1PreparedStatement): Promise<Acted> {
    const answers = await this.#db.batch([...acting, log]);
    return (answers[acting.length - 1]?.meta.changes ?? 0) > 0 ? "done" : "missing";
  }

  // In one batch with the action, right after it, so neither stands without the other.
  #logIfChanged(id: string, action: string, now: number, note?: string): D1PreparedStatement {
    return this.#db
      .prepare("INSERT OR IGNORE INTO moderation (at, doc, action, note) SELECT ?, ?, ?, ? WHERE changes() > 0")
      .bind(now, id, action, note ?? null);
  }
}
