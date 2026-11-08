import type { Top, TopDoc, TopOrder } from "../core/dashboard";
import { dayOf, type Limits, type ReportLevel } from "../core/limits";
import { type DayReading, LONE_AFTER_DAYS, signalsOf } from "../core/signals";
import type { Version } from "../core/store";
import { seenOf } from "./seen";

const LISTED = 50;
const WATCHED_AT_MOST = 2000;

const BORN = "COALESCE(d.first_day, CAST(json_extract(d.versions, '$[0].at') / 86400000 AS INTEGER))";
const ORDERS: Record<TopOrder, string> = {
  readers: "nets DESC, d.id",
  weight: "bytes DESC, d.id",
  edits: "d.latest DESC, d.id",
  oldest: "born, d.id",
};
const NOBODY_READ = "SELECT NULL AS doc, 0 AS nets, 0 AS proved, 0 AS hours, 0 AS peak WHERE 0";
const NO_OWNER_READ = "SELECT NULL AS owner, 0 AS n WHERE 0";

interface Row {
  id: string;
  owner: string;
  latest: number;
  versions: string;
  bytes: number;
  ttl_days: number;
  dies_on: number;
  born: number | null;
  blocked_at: number | null;
  paused_at: number | null;
  key_day: number | null;
  languages: number;
  nets: number;
  proved: number;
  hours: number;
  peak: number;
  owner_rows: number;
  y_nets: number | null;
  y_proved: number;
  y_hours: number;
  y_peak: number;
  most_nets: number | null;
  by_uploader: number | null;
  up_keys: number | null;
  up_docs: number | null;
  report: ReportLevel | null;
}

const readOfToday = async (db: D1Database, today: number): Promise<{ docs: string; owners: string }> => {
  const seen = await seenOf(db, today);
  if (!seen) return { docs: NOBODY_READ, owners: NO_OWNER_READ };
  return {
    docs: `SELECT doc, SUM(n) AS nets, SUM(p) AS proved, COUNT(*) AS hours, MAX(n) AS peak
           FROM (SELECT doc, hour, COUNT(*) AS n, SUM(${seen.proved}) AS p FROM ${seen.table} GROUP BY doc, hour)
           GROUP BY doc`,
    owners: `SELECT owner, COUNT(*) AS n FROM ${seen.table} GROUP BY owner`,
  };
};

const editsADay = (versions: Version[], today: number): number => {
  const onDay = (day: number): number => versions.filter((one) => dayOf(one.at) === day).length;
  return Math.max(onDay(today), onDay(today - 1));
};

const topDocOf = (row: Row, today: number, limits: Limits): TopDoc => {
  const versions = JSON.parse(row.versions) as Version[];
  const read: DayReading = { nets: row.nets, proved: row.proved, hours: row.hours, peak: row.peak };
  const yesterday: DayReading | null =
    row.y_nets === null ? null : { nets: row.y_nets, proved: row.y_proved, hours: row.y_hours, peak: row.y_peak };
  const liveDays = row.born === null ? 0 : today - row.born;
  return {
    id: row.id,
    owner: row.owner,
    keyDay: row.key_day,
    languages: row.languages,
    today: read,
    yesterday,
    ownerAtTop: row.owner_rows >= limits.rowsPerOwnerADay,
    bytes: row.bytes,
    latest: row.latest,
    latestAt: versions.at(-1)?.at ?? null,
    firstDay: row.born,
    ttlDays: row.ttl_days,
    diesOn: row.dies_on,
    blocked: row.blocked_at !== null,
    paused: row.paused_at !== null,
    signals: signalsOf(
      {
        today: read,
        yesterday,
        ownerRows: row.owner_rows,
        liveDays,
        mostNetsADay: row.most_nets,
        byUploader: row.by_uploader === 1,
        uploader: row.up_keys === null ? null : { keys: row.up_keys, docs: row.up_docs ?? 0 },
        editsADay: editsADay(versions, today),
        report: row.report,
      },
      limits,
    ),
  };
};

export const topDocs = async (
  db: D1Database,
  limits: Limits,
  now: number,
  order: TopOrder,
  flaggedOnly: boolean,
): Promise<Top> => {
  const today = dayOf(now);
  const read = await readOfToday(db, today);
  const rows = await db
    .prepare(
      `WITH read_today AS (${read.docs}), owner_rows AS (${read.owners}),
         uploaders AS (
           SELECT u.doc, MAX(q.keys) AS keys, MAX(q.docs) AS docs
           FROM net_doc u JOIN net_day q ON q.day = u.day AND q.net = u.net
           WHERE u.day >= ?1 - 1 GROUP BY u.doc
         )
       SELECT d.id, d.owner, d.latest, d.versions, d.ttl_days, d.dies_on, d.blocked_at, d.paused_at,
         json_extract(d.versions, '$[#-1].bytes') + d.files_bytes AS bytes, ${BORN} AS born,
         k.first_day AS key_day,
         (SELECT COUNT(*) FROM docs l WHERE l.anchor = d.id AND l.owner = d.owner AND l.latest > 0) AS languages,
         COALESCE(t.nets, 0) AS nets, COALESCE(t.proved, 0) AS proved, COALESCE(t.hours, 0) AS hours,
         COALESCE(t.peak, 0) AS peak, COALESCE(o.n, 0) AS owner_rows,
         y.nets AS y_nets, COALESCE(y.proved, 0) AS y_proved, COALESCE(y.hours, 0) AS y_hours, COALESCE(y.peak, 0) AS y_peak,
         (SELECT MAX(x.nets) FROM doc_day x WHERE x.doc = d.id AND x.day >= ?1 - ?3) AS most_nets,
         (SELECT MAX(x.by_uploader) FROM doc_day x WHERE x.doc = d.id AND x.day >= ?1 - ?3) AS by_uploader,
         up.keys AS up_keys, up.docs AS up_docs,
         (SELECT r.level FROM reports r WHERE r.doc = d.id AND r.cleared = 0
          ORDER BY CASE r.level WHEN 'grave' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END LIMIT 1) AS report
       FROM docs d
         LEFT JOIN keys k ON k.root = d.owner
         LEFT JOIN read_today t ON t.doc = d.id
         LEFT JOIN owner_rows o ON o.owner = d.owner
         LEFT JOIN doc_day y ON y.doc = d.id AND y.day = ?1 - 1
         LEFT JOIN uploaders up ON up.doc = d.id
       WHERE d.latest > 0
       ORDER BY ${ORDERS[order]} LIMIT ?2`,
    )
    .bind(today, flaggedOnly ? WATCHED_AT_MOST : LISTED, LONE_AFTER_DAYS)
    .all<Row>();
  const docs = rows.results.map((row) => topDocOf(row, today, limits));
  return {
    order,
    flaggedOnly,
    docs: (flaggedOnly ? docs.filter((one) => one.signals.length > 0) : docs).slice(0, LISTED),
  };
};
