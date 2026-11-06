import { DAY_MS, dayOf, LEVEL_ONE, type Limits } from "../core/limits";
import type { Queue, QueuedDoc, QueuedReport } from "../core/queue";

export type Acted = "done" | "missing";

const SEEN_AT_MOST = 200;
const HOUR_MS = 3_600_000;
const NOT_FALSE = "r.cleared = 0 AND r.net NOT IN (SELECT net FROM false_reporters)";

export const acceptAppeal = async (
  db: D1Database,
  { pausedDays }: Pick<Limits, "pausedDays">,
  id: string,
  today: number,
): Promise<void> => {
  await db.batch([
    // Who reported it stops counting for a while, and the reports stay as a record.
    db
      .prepare(
        `INSERT INTO false_reporters (net, at)
         SELECT net, ?2 FROM reports
         WHERE doc = ?1 AND cleared = 0 AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND blocked_at IS NOT NULL)
         ON CONFLICT (net) DO UPDATE SET at = excluded.at`,
      )
      .bind(id, today),
    db
      .prepare(
        "UPDATE reports SET cleared = 1 WHERE doc = ?1 AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND blocked_at IS NOT NULL)",
      )
      .bind(id),
    db
      .prepare(
        `UPDATE docs SET blocked_at = NULL, appealed_at = NULL, blocked_hour = NULL, appealed_hour = NULL, fix_by = NULL,
           dies_on = CASE WHEN paused_at IS NULL THEN ?1 + ttl_days ELSE paused_at + ?2 END
         WHERE id = ?3 AND blocked_at IS NOT NULL`,
      )
      .bind(today, pausedDays, id),
  ]);
};

export class CloudModeration {
  readonly #db: D1Database;
  readonly #limits: Limits;

  constructor(db: D1Database, limits: Limits = LEVEL_ONE) {
    this.#db = db;
    this.#limits = limits;
  }

  async queue(now: number): Promise<Queue> {
    const [stage, keys, reports, docs] = await this.#db.batch([
      this.#db.prepare("SELECT stage FROM service_stage WHERE id = 1"),
      this.#db.prepare("SELECT COALESCE(SUM(keys), 0) AS n FROM net_day WHERE day = ?").bind(dayOf(now)),
      this.#db
        .prepare(
          `SELECT r.doc, r.net, r.category, r.level, r.detail, r.sealed_link, r.version, r.at, r.asn
           FROM reports r WHERE r.level <> 'light' AND ${NOT_FALSE}
           ORDER BY r.category = 'csam' DESC, r.level = 'grave' DESC, r.doc, r.at DESC LIMIT ?`,
        )
        .bind(SEEN_AT_MOST),
      this.#db
        .prepare(
          `SELECT id, owner, latest, versions, blocked_at, appealed_at, appealed_hour, counts_from
           FROM docs WHERE blocked_at IS NOT NULL
           ORDER BY appealed_hour IS NULL, blocked_at DESC, id LIMIT ?`,
        )
        .bind(SEEN_AT_MOST),
    ]);
    return {
      stage: (stage?.results?.[0] as { stage: string } | undefined)?.stage ?? "open",
      newKeys: (keys?.results?.[0] as { n: number } | undefined)?.n ?? 0,
      reports: ((reports?.results ?? []) as (Omit<QueuedReport, "sealedLink"> & { sealed_link: string | null })[]).map(
        ({ sealed_link: sealedLink, ...report }) => ({ ...report, sealedLink }),
      ),
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
        }[]
      ).map((row) => ({
        id: row.id,
        latest: row.latest,
        blockedAt: row.blocked_at,
        appealedAt: row.appealed_at,
        waitsForOperator: row.appealed_hour !== null,
        mayCorrect: row.counts_from > row.latest,
        signers: (JSON.parse(row.versions) as { n: number; signer: string }[]).map(({ n, signer }) => ({
          n,
          byOwner: signer === row.owner,
        })),
      })),
    };
  }

  async accept(id: string, now: number): Promise<Acted> {
    if (!(await this.#isBlocked(id))) return "missing";
    await acceptAppeal(this.#db, this.#limits, id, dayOf(now));
    await this.#log(id, "accept", now);
    return "done";
  }

  // The appeal stays spent: it leaves the operator's queue, and the block stands.
  async reject(id: string, now: number): Promise<Acted> {
    const changed = await this.#db
      .prepare(
        "UPDATE docs SET appealed_hour = NULL WHERE id = ? AND blocked_at IS NOT NULL AND appealed_hour IS NOT NULL",
      )
      .bind(id)
      .run();
    if (changed.meta.changes === 0) return "missing";
    await this.#log(id, "reject", now);
    return "done";
  }

  async block(id: string, note: string, now: number): Promise<Acted> {
    const today = dayOf(now);
    const changed = await this.#db
      .prepare(
        `UPDATE docs SET blocked_at = ?1, blocked_hour = ?2, dies_on = ?1 + ?3
         WHERE id = ?4 AND latest >= 0 AND blocked_at IS NULL`,
      )
      .bind(today, Math.floor(now / HOUR_MS), this.#limits.evidenceDays, id)
      .run();
    if (changed.meta.changes === 0) return "missing";
    await this.#log(id, "block", now, note);
    return "done";
  }

  async reportWasFalse(id: string, net: string, now: number): Promise<Acted> {
    const [cleared] = await this.#db.batch([
      this.#db.prepare("UPDATE reports SET cleared = 1 WHERE doc = ?1 AND net = ?2 AND cleared = 0").bind(id, net),
      this.#db
        .prepare(
          `INSERT INTO false_reporters (net, at)
           SELECT net, ?3 FROM reports WHERE doc = ?1 AND net = ?2
           ON CONFLICT (net) DO UPDATE SET at = excluded.at`,
        )
        .bind(id, net, dayOf(now)),
    ]);
    if ((cleared?.meta.changes ?? 0) === 0) return "missing";
    await this.#log(id, "false_report", now);
    return "done";
  }

  async opened(id: string, reason: string, now: number): Promise<Acted> {
    await this.#db
      .prepare("INSERT OR IGNORE INTO openings (doc, at, reason) VALUES (?, ?, ?)")
      .bind(id, now, reason)
      .run();
    return "done";
  }

  async forgetOldLog(now: number): Promise<void> {
    await this.#db
      .prepare("DELETE FROM moderation WHERE at < ?")
      .bind(now - this.#limits.evidenceDays * DAY_MS)
      .run();
  }

  async #isBlocked(id: string): Promise<boolean> {
    const row = await this.#db.prepare("SELECT 1 FROM docs WHERE id = ? AND blocked_at IS NOT NULL").bind(id).first();
    return row !== null;
  }

  async #log(id: string, action: string, now: number, note?: string): Promise<void> {
    await this.#db
      .prepare("INSERT OR IGNORE INTO moderation (at, doc, action, note) VALUES (?, ?, ?, ?)")
      .bind(now, id, action, note ?? null)
      .run();
  }
}
