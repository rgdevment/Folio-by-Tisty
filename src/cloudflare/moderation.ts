import { caseNameOf } from "../core/case-records";
import { dayOf, LEVEL_ONE, type Limits } from "../core/limits";
import { GRAVEST_FIRST, type Queue, type QueuedReport, type QueuedWarning } from "../core/queue";
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
// Only after the report was opened: erasing the seal before that would leave nobody able to read the document.
const READY_TO_HAND_OVER = `EXISTS (SELECT 1 FROM docs d WHERE d.id = ?1 AND d.blocked_by_operator = 1)
  AND EXISTS (SELECT 1 FROM cases c WHERE ${CASE_FOR_THE_AUTHORITY})
  AND EXISTS (SELECT 1 FROM openings o WHERE o.doc = ?1 AND o.reason NOT LIKE 'case %')`;

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

export const CLAIMED = -1;

// Broader than what the sweep holds: a grave report stays whoever else that network reported, and a stranger's citation stays whole.
const MUST_STAY = (doc: string, today: string): string =>
  `(COALESCE(${doc}.legal_until, 0) >= ${today}
    OR EXISTS (SELECT 1 FROM reports r WHERE r.doc = ${doc}.id AND r.level = 'grave' AND r.cleared = 0)
    OR EXISTS (SELECT 1 FROM cases c WHERE c.doc = ${doc}.id AND c.sealed_records IS NOT NULL AND c.until >= ${today})
    OR EXISTS (SELECT 1 FROM holds h JOIN docs k ON k.id = h.holder WHERE h.held = ${doc}.id AND k.owner <> ${doc}.owner))`;

// By the group: the sweep takes a language with its anchor, so one that must stay keeps them all.
const PURGEABLE = `SELECT d.id FROM docs d
  WHERE d.owner = (SELECT owner FROM docs WHERE id = ?1) AND d.latest >= 0
    AND NOT EXISTS (
      SELECT 1 FROM docs g WHERE g.owner = d.owner AND COALESCE(g.anchor, g.id) = COALESCE(d.anchor, d.id)
        AND ${MUST_STAY("g", "?2")}
    )`;

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

const OWNER_TO_BLOCK = (doc: string): string =>
  `(SELECT d.owner FROM docs d WHERE d.id = ${doc}
     AND NOT EXISTS (SELECT 1 FROM keys k WHERE k.root = d.owner AND k.blocked_at IS NOT NULL))`;

export class CloudModeration {
  readonly #db: D1Database;
  readonly #limits: Limits;

  constructor(db: D1Database, limits: Limits = LEVEL_ONE) {
    this.#db = db;
    this.#limits = limits;
  }

  async queue(now: number, reportsFrom = 0): Promise<Queue> {
    const [stage, keys, reports, reportsTotal, docs, warned, blockedKeys] = await this.#db.batch([
      this.#db.prepare("SELECT stage FROM service_stage WHERE id = 1"),
      this.#db.prepare("SELECT COALESCE(SUM(keys), 0) AS n FROM net_day WHERE day = ?").bind(dayOf(now)),
      this.#db
        .prepare(
          `SELECT r.doc, ${OWNER_TO_BLOCK("r.doc")} AS owner_to_block, r.net, r.category, r.level, r.detail, r.sealed_link, r.sealed_contact, r.version, r.at, r.asn, r.over_cap,
             r.net IN (SELECT net FROM false_reporters) AS false_net
           ${REPORTS_TO_SEE}
           ORDER BY ROW_NUMBER() OVER (PARTITION BY r.net ORDER BY ${GRAVEST_FIRST}, r.at),
             ${GRAVEST_FIRST}, false_net, r.at DESC, r.doc, r.net
           LIMIT ?1 OFFSET ?2`,
        )
        .bind(SEEN_AT_MOST, reportsFrom),
      this.#db.prepare(`SELECT COUNT(*) AS n ${REPORTS_TO_SEE}`),
      this.#db
        .prepare(
          `SELECT id, owner, latest, versions, blocked_at, appealed_at, appealed_hour, counts_from, blocked_by_operator,
             ${OWNER_TO_BLOCK("docs.id")} AS owner_to_block,
             COALESCE(
               (SELECT MAX(r.version) FROM reports r
                WHERE r.doc = docs.id AND r.cleared = 0 AND r.level <> 'light'
                  AND EXISTS (SELECT 1 FROM json_each(docs.versions) v WHERE json_extract(v.value, '$.n') = r.version)),
               latest
             ) AS version_to_open,
             blocked_by_operator = 1
               AND EXISTS (SELECT 1 FROM reports r WHERE r.doc = docs.id AND r.sealed_link IS NOT NULL)
               AND EXISTS (SELECT 1 FROM cases c WHERE c.doc = docs.id AND c.sealed_records IS NOT NULL AND c.until >= ?2)
               AND EXISTS (SELECT 1 FROM openings o WHERE o.doc = docs.id AND o.reason NOT LIKE 'case %')
               AS may_hand_over
           FROM docs WHERE blocked_at IS NOT NULL
           ORDER BY appealed_hour IS NULL, blocked_at DESC, id LIMIT ?1`,
        )
        .bind(SEEN_AT_MOST, dayOf(now)),
      this.#db
        .prepare(
          `SELECT id, fix_by AS fixBy,
             (SELECT COUNT(*) FROM reports r WHERE r.doc = docs.id AND r.level = 'light' AND r.cleared = 0) AS nets
           FROM docs WHERE fix_by IS NOT NULL AND blocked_at IS NULL ORDER BY fix_by, id LIMIT ?`,
        )
        .bind(SEEN_AT_MOST),
      this.#db
        .prepare("SELECT root, blocked_at FROM keys WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC LIMIT ?")
        .bind(SEEN_AT_MOST),
    ]);
    return {
      stage: (stage?.results?.[0] as { stage: string } | undefined)?.stage ?? "open",
      newKeys: (keys?.results?.[0] as { n: number } | undefined)?.n ?? 0,
      reportsTotal: (reportsTotal?.results?.[0] as { n: number } | undefined)?.n ?? 0,
      reportsFrom,
      reports: (
        (reports?.results ?? []) as (Omit<
          QueuedReport,
          "sealedLink" | "sealedContact" | "fromFalseNet" | "ownerToBlock"
        > & {
          owner_to_block: string | null;
          sealed_link: string | null;
          sealed_contact: string | null;
          false_net: number;
          over_cap: number;
        })[]
      ).map(
        ({
          owner_to_block: ownerToBlock,
          sealed_link: sealedLink,
          sealed_contact: sealedContact,
          false_net: falseNet,
          over_cap: overCap,
          ...report
        }) => ({
          ...report,
          ownerToBlock,
          sealedLink,
          sealedContact,
          fromFalseNet: falseNet === 1,
          overCap: overCap === 1,
        }),
      ),
      warned: (warned?.results ?? []) as unknown as QueuedWarning[],
      docs: (
        (docs?.results ?? []) as {
          id: string;
          owner: string;
          owner_to_block: string | null;
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
        ownerToBlock: row.owner_to_block,
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
      blockedKeys: ((blockedKeys?.results ?? []) as { root: string; blocked_at: number }[]).map((row) => ({
        root: row.root,
        blockedAt: row.blocked_at,
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

  async blockKey(root: string, note: string, now: number): Promise<Acted> {
    const blocking = this.#db
      .prepare("UPDATE keys SET blocked_at = ? WHERE root = ? AND blocked_at IS NULL")
      .bind(dayOf(now), root);
    return this.#actedAndLogged([blocking], this.#logIfChanged(root, "block_key", now, note));
  }

  async unblockKey(root: string, now: number): Promise<Acted> {
    const lifting = this.#db
      .prepare("UPDATE keys SET blocked_at = NULL WHERE root = ? AND blocked_at IS NOT NULL")
      .bind(root);
    return this.#actedAndLogged([lifting], this.#logIfChanged(root, "unblock_key", now));
  }

  async purgePreview(id: string, now: number): Promise<{ purged: number; kept: number } | null> {
    const [purgeable, all] = await this.#db.batch<{ n: number }>([
      this.#db.prepare(`SELECT COUNT(*) AS n FROM (${PURGEABLE})`).bind(id, dayOf(now)),
      this.#db
        .prepare("SELECT COUNT(*) AS n FROM docs WHERE owner = (SELECT owner FROM docs WHERE id = ?1) AND latest >= 0")
        .bind(id),
    ]);
    const purged = purgeable?.results[0]?.n ?? 0;
    const total = all?.results[0]?.n ?? 0;
    return total > 0 ? { purged, kept: total - purged } : null;
  }

  // The sweep of the private Worker empties what is claimed here, since this Worker never holds the envelopes.
  async purgeOwner(id: string, note: string, now: number): Promise<{ purged: number; kept: number } | null> {
    const today = dayOf(now);
    const of = (sql: string, ...more: unknown[]) => this.#db.prepare(sql).bind(id, today, ...more);
    const [logged, , , , left] = await this.#db.batch<{ kept: number }>([
      of(
        `INSERT OR IGNORE INTO moderation (at, doc, action, note)
         SELECT ?3, purgeable.id, 'purge_owner', ?4 FROM (${PURGEABLE}) purgeable`,
        now,
        note,
      ),
      of(`UPDATE reports SET cleared = 1 WHERE doc IN (${PURGEABLE})`),
      of(`DELETE FROM cases WHERE doc IN (${PURGEABLE})`),
      of(`UPDATE docs SET latest = ${CLAIMED} WHERE id IN (${PURGEABLE})`),
      this.#db
        .prepare(
          `SELECT COUNT(*) AS kept FROM docs
           WHERE owner = (SELECT owner FROM docs WHERE id = ?1) AND latest >= 0`,
        )
        .bind(id),
    ]);
    const purged = logged?.meta.changes ?? 0;
    const kept = left?.results[0]?.kept ?? 0;
    return purged + kept > 0 ? { purged, kept } : null;
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
          `SELECT category, level, detail, version, at, cleared, over_cap FROM reports WHERE doc = ?
           ORDER BY category = 'csam' DESC, level = 'grave' DESC, at LIMIT ?`,
        )
        .bind(id, REPORT_ROWS_AT_MOST),
      this.#db
        .prepare(
          `SELECT at, action, note FROM moderation WHERE doc = ?1 OR doc = (SELECT owner FROM docs WHERE id = ?1)
           ORDER BY at DESC LIMIT ?2`,
        )
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

  async clearWarning(id: string, now: number): Promise<Acted> {
    const clearing = this.#db
      .prepare(
        `UPDATE reports SET cleared = 1 WHERE doc = ?1 AND level = 'light' AND cleared = 0
           AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND fix_by IS NOT NULL)`,
      )
      .bind(id);
    const lifting = this.#db.prepare("UPDATE docs SET fix_by = NULL WHERE id = ? AND fix_by IS NOT NULL").bind(id);
    return this.#actedAndLogged([clearing, lifting], this.#logIfChanged(id, "clear_warning", now));
  }

  async forgetContact(id: string, net: string, now: number): Promise<Acted> {
    const forgetting = this.#db
      .prepare("UPDATE reports SET sealed_contact = NULL WHERE doc = ? AND net = ? AND sealed_contact IS NOT NULL")
      .bind(id, net);
    return this.#actedAndLogged([forgetting], this.#logIfChanged(id, "forget_contact", now));
  }

  #namingFalse(id: string, net: string, now: number): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT INTO false_reporters (net, at, since)
         SELECT net, ?3, ?3 FROM reports WHERE doc = ?1 AND net = ?2 AND cleared = 0
         ON CONFLICT (net) DO UPDATE SET at = excluded.at`,
      )
      .bind(id, net, dayOf(now));
  }

  async reportWasFalse(id: string, net: string, now: number): Promise<Acted> {
    const clearing = this.#db
      .prepare("UPDATE reports SET cleared = 1 WHERE doc = ?1 AND net = ?2 AND cleared = 0")
      .bind(id, net);
    return this.#actedAndLogged(
      [this.#namingFalse(id, net, now), clearing],
      this.#logIfChanged(id, "false_report", now),
    );
  }

  // Logged on every document it clears, so each one's records say why its reports stopped counting.
  async networkWasFalse(id: string, net: string, now: number): Promise<Acted> {
    const logging = this.#db
      .prepare(
        `INSERT OR IGNORE INTO moderation (at, doc, action, note)
         SELECT DISTINCT ?2, doc, 'false_network', ?3 FROM reports WHERE net = ?1 AND cleared = 0 AND doc <> ?3`,
      )
      .bind(net, now, id);
    const clearing = this.#db.prepare("UPDATE reports SET cleared = 1 WHERE net = ? AND cleared = 0").bind(net);
    return this.#actedAndLogged(
      [this.#namingFalse(id, net, now), logging, clearing],
      this.#logIfChanged(id, "false_network", now),
    );
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
