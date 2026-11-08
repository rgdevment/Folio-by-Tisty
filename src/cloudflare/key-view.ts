import type { KeyDoc, KeyView, Owner } from "../core/dashboard";
import type { Limits, ReportLevel } from "../core/limits";
import { HELD_BYTES, HOLDS_ROOM, SERVED } from "./room";

const LISTED_AT_MOST = 200;
const RECORDS_AT_MOST = 1000;

const HOLDS = (today: string): string => `COALESCE(SUM(CASE WHEN ${HOLDS_ROOM(today)} THEN ${HELD_BYTES} END), 0)`;
const ALIVE = SERVED("?2");

export const levelsOf = (rows: { level: string; n: number }[]): Record<ReportLevel, number> => {
  const levels: Record<ReportLevel, number> = { grave: 0, medium: 0, light: 0 };
  for (const { level, n } of rows) if (level in levels) levels[level as ReportLevel] = n;
  return levels;
};

export const ownersOf = async (db: D1Database, docs: string[], today: number): Promise<Record<string, Owner>> => {
  if (docs.length === 0) return {};
  const found = await db
    .prepare(
      `SELECT asked.id AS doc, asked.owner AS root, k.first_day, k.blocked_at,
         (SELECT ${HOLDS("?2")} FROM docs d WHERE d.owner = asked.owner) AS holds
       FROM docs asked LEFT JOIN keys k ON k.root = asked.owner
       WHERE asked.id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify([...new Set(docs)]), today)
    .all<{ doc: string; root: string; first_day: number | null; blocked_at: number | null; holds: number }>();
  return Object.fromEntries(
    found.results.map((one) => [
      one.doc,
      { root: one.root, firstDay: one.first_day, blockedAt: one.blocked_at, holds: one.holds },
    ]),
  );
};

export const keyView = async (db: D1Database, limits: Limits, root: string, today: number): Promise<KeyView | null> => {
  const [key, docs, editors, reports, listed] = await db.batch([
    db.prepare("SELECT first_day, terms_version, terms_hour, blocked_at FROM keys WHERE root = ?").bind(root),
    db
      .prepare(
        `SELECT COUNT(*) AS n, ${HOLDS("?2")} AS holds,
           COALESCE(SUM(d.latest > 0 AND d.blocked_at IS NULL AND ${ALIVE}), 0) AS open,
           COALESCE(SUM(d.latest >= 0 AND d.blocked_at IS NULL AND NOT ${ALIVE}), 0) AS expired,
           COALESCE(SUM(d.blocked_at IS NOT NULL), 0) AS blocked,
           COALESCE(SUM(MAX(d.latest, 0)), 0) AS versions
         FROM docs d WHERE d.owner = ?1`,
      )
      .bind(root, today),
    db.prepare("SELECT COUNT(*) AS n FROM editors WHERE root = ?").bind(root),
    db
      .prepare(
        `SELECT r.level, COUNT(*) AS n FROM reports r JOIN docs d ON d.id = r.doc
         WHERE d.owner = ? AND r.cleared = 0 GROUP BY r.level`,
      )
      .bind(root),
    db
      .prepare(
        `SELECT d.id, d.anchor, d.latest, ${HELD_BYTES} AS bytes, d.first_day AS firstDay, d.dies_on AS diesOn,
           d.blocked_at AS blockedAt, d.paused_at AS pausedAt, d.legal_until AS legalUntil, ${ALIVE} AS alive
         FROM docs d WHERE d.owner = ?1 AND d.latest >= 0 ORDER BY d.dies_on DESC, d.id LIMIT ?3`,
      )
      .bind(root, today, LISTED_AT_MOST),
  ]);
  const known = key?.results[0] as
    | { first_day: number; terms_version: string | null; terms_hour: number | null; blocked_at: number | null }
    | undefined;
  const counted = docs?.results[0] as
    | { n: number; holds: number; open: number; expired: number; blocked: number; versions: number }
    | undefined;
  if (!known && !counted?.n) return null;
  return {
    root,
    firstDay: known?.first_day ?? null,
    blockedAt: known?.blocked_at ?? null,
    termsVersion: known?.terms_version ?? null,
    termsHour: known?.terms_hour ?? null,
    holds: counted?.holds ?? 0,
    holdsAtMost: limits.keyBytesAtMost,
    docs: { open: counted?.open ?? 0, expired: counted?.expired ?? 0, blocked: counted?.blocked ?? 0 },
    versions: counted?.versions ?? 0,
    asEditor: (editors?.results[0] as { n: number } | undefined)?.n ?? 0,
    reports: levelsOf((reports?.results ?? []) as { level: string; n: number }[]),
    listed: ((listed?.results ?? []) as (Omit<KeyDoc, "alive"> & { alive: number })[]).map((one) => ({
      ...one,
      alive: one.alive === 1,
    })),
  };
};

// Never who reported: not the network, nor its provider, nor what they sealed, as in a case's records (decision 152).
export const keyRecords = async (db: D1Database, root: string, today: number): Promise<unknown> => {
  const [key, docs, reports, actions, openings] = await db.batch([
    db.prepare("SELECT root, first_day, terms_version, terms_hour, blocked_at FROM keys WHERE root = ?").bind(root),
    db
      .prepare(
        `SELECT id, anchor, latest, versions, ttl_days, first_day, dies_on, paused_at, blocked_at, legal_until
         FROM docs WHERE owner = ? AND latest >= 0 ORDER BY id LIMIT ?`,
      )
      .bind(root, RECORDS_AT_MOST),
    db
      .prepare(
        `SELECT r.doc, r.category, r.level, r.detail, r.version, r.at, r.cleared, r.over_cap
         FROM reports r JOIN docs d ON d.id = r.doc WHERE d.owner = ? ORDER BY r.doc, r.at LIMIT ?`,
      )
      .bind(root, RECORDS_AT_MOST),
    db
      .prepare(
        `SELECT at, doc, action, note FROM moderation
         WHERE doc = ?1 OR doc IN (SELECT id FROM docs WHERE owner = ?1) ORDER BY at DESC LIMIT ?2`,
      )
      .bind(root, RECORDS_AT_MOST),
    db
      .prepare(
        "SELECT at, doc, reason FROM openings WHERE doc IN (SELECT id FROM docs WHERE owner = ?1) ORDER BY at DESC LIMIT ?2",
      )
      .bind(root, RECORDS_AT_MOST),
  ]);
  const owned = (docs?.results ?? []) as ({ versions: string } & Record<string, unknown>)[];
  if (!key?.results[0] && owned.length === 0) return null;
  return {
    day: today,
    key: key?.results[0] ?? { root },
    docs: owned.map((one) => ({ ...one, versions: JSON.parse(one.versions) as unknown })),
    reports: reports?.results ?? [],
    actions: actions?.results ?? [],
    openings: openings?.results ?? [],
  };
};
