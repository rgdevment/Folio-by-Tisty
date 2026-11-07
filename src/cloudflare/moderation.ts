import { dayOf, LEVEL_ONE, type Limits } from "../core/limits";
import type { Queue, QueuedReport } from "../core/queue";
import { hourOf } from "../core/start";

export type Acted = "done" | "missing";

const SEEN_AT_MOST = 200;
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
          `SELECT id, owner, latest, versions, blocked_at, appealed_at, appealed_hour, counts_from, blocked_by_operator
           FROM docs WHERE blocked_at IS NOT NULL
           ORDER BY appealed_hour IS NULL, blocked_at DESC, id LIMIT ?`,
        )
        .bind(SEEN_AT_MOST),
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
        }[]
      ).map((row) => ({
        id: row.id,
        latest: row.latest,
        blockedAt: row.blocked_at,
        appealedAt: row.appealed_at,
        waitsForOperator: row.appealed_hour !== null,
        mayCorrect: mayCorrect(row),
        signers: (JSON.parse(row.versions) as { n: number; signer: string }[]).map(({ n, signer }) => ({
          n,
          byOwner: signer === row.owner,
        })),
      })),
    };
  }

  async accept(id: string, now: number): Promise<Acted> {
    const lifting = acceptingAppeal(this.#db, this.#limits, id, dayOf(now));
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
