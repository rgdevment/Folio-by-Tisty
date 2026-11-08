import type {
  Dashboard,
  Found,
  Logged,
  NetsNearTheirTop,
  Overview,
  ServiceDay,
  Top,
  TopOrder,
} from "../core/dashboard";
import { dayOf, LEVEL_ONE, type Limits } from "../core/limits";
import { CAP_USD, STORED_GB_AT_MOST, STORED_GB_FOR_NEW_KEYS } from "../core/spend";
import { hourOf } from "../core/start";
import type { Stage } from "../core/store";
import { keyRecords, keyView, levelsOf, ownersOf } from "./key-view";
import { SERVED } from "./room";
import { NEW_KEYS_NET, seenOf } from "./seen";
import { topDocs } from "./top";

const DAYS_CHARTED = 30;
const LOGGED_AT_MOST = 50;
const NETS_LISTED_AT_MOST = 8;
const NEAR_ITS_TOP = 0.5;
const DOC_ID = /^[A-Za-z0-9]{8}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

const firstOf = <T>(result: D1Result | undefined): T | undefined => result?.results?.[0] as T | undefined;

export class CloudDashboard implements Dashboard {
  readonly #db: D1Database;
  readonly #limits: Limits;

  constructor(db: D1Database, limits: Limits = LEVEL_ONE) {
    this.#db = db;
    this.#limits = limits;
  }

  async #readersOn(day: number): Promise<number> {
    const seen = await seenOf(this.#db, day);
    if (!seen) return 0;
    return (await this.#db.prepare(`SELECT COUNT(*) AS n FROM ${seen.table}`).first<{ n: number }>())?.n ?? 0;
  }

  async overview(now: number): Promise<Overview> {
    const today = dayOf(now);
    const [stage, docs, keys, net, reports, yesterday, held] = await this.#db.batch([
      this.#db.prepare(
        "SELECT stage, bill, line, stored_gb, spent_at, swept_hour, digested_hour FROM service_stage WHERE id = 1",
      ),
      this.#db
        .prepare(
          `SELECT COALESCE(SUM(d.anchor IS NULL), 0) AS open,
             COALESCE(SUM(d.anchor IS NULL AND d.first_day = ?1), 0) AS new_today,
             COUNT(DISTINCT d.anchor) AS with_languages
           FROM docs d WHERE d.latest > 0 AND d.blocked_at IS NULL AND ${SERVED("?1")}`,
        )
        .bind(today),
      this.#db.prepare("SELECT COUNT(*) AS n FROM keys"),
      this.#db
        .prepare(
          `SELECT COALESCE(SUM(keys), 0) AS keys, COALESCE(SUM(uploads), 0) AS uploads, COALESCE(SUM(docs), 0) AS docs,
             COALESCE(SUM(CASE WHEN net = ?2 THEN bytes END), 0) AS new_keys_bytes
           FROM net_day WHERE day = ?1`,
        )
        .bind(today, NEW_KEYS_NET),
      this.#db.prepare("SELECT level, COUNT(*) AS n FROM reports WHERE cleared = 0 GROUP BY level"),
      this.#db.prepare("SELECT readers FROM service_day WHERE day = ?").bind(today - 1),
      this.#db.prepare("SELECT COALESCE(SUM(bytes + files_bytes), 0) AS n FROM docs WHERE latest >= 0"),
    ]);
    const service = firstOf<{
      stage: Stage;
      bill: number | null;
      line: number | null;
      stored_gb: number | null;
      spent_at: number | null;
      swept_hour: number | null;
      digested_hour: number | null;
    }>(stage);
    const counted = firstOf<{ open: number; new_today: number; with_languages: number }>(docs);
    const day = firstOf<{ keys: number; uploads: number; docs: number; new_keys_bytes: number }>(net);
    return {
      stage: service?.stage ?? "open",
      docs: {
        open: counted?.open ?? 0,
        newToday: counted?.new_today ?? 0,
        withLanguages: counted?.with_languages ?? 0,
      },
      readers: {
        today: await this.#readersOn(today),
        yesterday: firstOf<{ readers: number }>(yesterday)?.readers ?? null,
      },
      keys: {
        total: firstOf<{ n: number }>(keys)?.n ?? 0,
        newToday: day?.keys ?? 0,
        newADay: this.#limits.newKeysADay,
      },
      uploads: { today: day?.uploads ?? 0, newDocs: day?.docs ?? 0 },
      stored: {
        gb: service?.stored_gb ?? null,
        heldBytes: firstOf<{ n: number }>(held)?.n ?? 0,
        newKeysBytesToday: day?.new_keys_bytes ?? 0,
        atMostGb: STORED_GB_AT_MOST,
        newKeysStopGb: STORED_GB_FOR_NEW_KEYS,
      },
      reports: levelsOf((reports?.results ?? []) as { level: string; n: number }[]),
      spend: {
        bill: service?.bill ?? null,
        line: service?.line ?? null,
        capUsd: CAP_USD,
        at: service?.spent_at ?? null,
      },
      beats: {
        sweptHour: service?.swept_hour ?? null,
        spentAt: service?.spent_at ?? null,
        digestedHour: service?.digested_hour || null,
      },
    };
  }

  async days(now: number): Promise<ServiceDay[]> {
    const today = dayOf(now);
    const first = today - DAYS_CHARTED + 1;
    const [past, uploads] = await this.#db.batch([
      this.#db.prepare("SELECT day, readers, uploads FROM service_day WHERE day >= ?1 AND day < ?2").bind(first, today),
      this.#db.prepare("SELECT COALESCE(SUM(uploads), 0) AS n FROM net_day WHERE day = ?").bind(today),
    ]);
    const byDay = new Map(((past?.results ?? []) as unknown as ServiceDay[]).map((one) => [one.day, one]));
    byDay.set(today, {
      day: today,
      readers: await this.#readersOn(today),
      uploads: firstOf<{ n: number }>(uploads)?.n ?? 0,
    });
    return Array.from({ length: DAYS_CHARTED }, (_, at) => {
      const day = first + at;
      return byDay.get(day) ?? { day, readers: 0, uploads: 0 };
    });
  }

  async log(): Promise<Logged[]> {
    const logged = await this.#db
      .prepare(
        `SELECT at, action, doc AS "on", note FROM moderation
         UNION ALL SELECT at, 'opened', doc, reason FROM openings
         ORDER BY at DESC LIMIT ?`,
      )
      .bind(LOGGED_AT_MOST)
      .all<Logged>();
    return logged.results;
  }

  async nets(now: number): Promise<NetsNearTheirTop> {
    const { netDocsADay: docs, netBytesADay: bytes, newKeysADay: keys, uploadsAnHour } = this.#limits;
    const found = await this.#db
      .prepare(
        `SELECT net, docs, bytes, keys, uploads_this_hour AS uploadsThisHour,
           MAX(docs * 1.0 / ?3, bytes * 1.0 / ?4, keys * 1.0 / ?5, uploads_this_hour * 1.0 / ?6) AS share
         FROM (
           SELECT d.net, d.docs, d.bytes, d.keys, COALESCE(h.n, 0) AS uploads_this_hour
           FROM net_day d LEFT JOIN net_hour h ON h.net = d.net AND h.action = 'upload' AND h.hour = ?2
           WHERE d.day = ?1 AND d.net <> ?7
         )
         WHERE share >= ?8 ORDER BY share DESC, net LIMIT ?9`,
      )
      .bind(dayOf(now), hourOf(now), docs, bytes, keys, uploadsAnHour, NEW_KEYS_NET, NEAR_ITS_TOP, NETS_LISTED_AT_MOST)
      .all<NetsNearTheirTop["nets"][number]>();
    return { limits: { docs, bytes, keys, uploadsAnHour }, nets: found.results };
  }

  top(now: number, order: TopOrder, flaggedOnly: boolean): Promise<Top> {
    return topDocs(this.#db, this.#limits, now, order, flaggedOnly);
  }

  owners(docs: string[], now: number) {
    return ownersOf(
      this.#db,
      docs.filter((one) => DOC_ID.test(one)),
      dayOf(now),
    );
  }

  key(root: string, now: number) {
    return keyView(this.#db, this.#limits, root, dayOf(now));
  }

  keyRecords(root: string, now: number) {
    return keyRecords(this.#db, root, dayOf(now));
  }

  async find(asked: string, now: number): Promise<Found> {
    const said = asked.trim();
    if (DOC_ID.test(said)) {
      const doc = await this.#db
        .prepare("SELECT id, owner FROM docs WHERE id = ?")
        .bind(said)
        .first<{ id: string; owner: string }>();
      return doc ? { kind: "doc", ...doc } : { kind: "none" };
    }
    if (!DIGEST.test(said)) return { kind: "none" };
    const [key, days, reports] = await this.#db.batch([
      this.#db
        .prepare(
          "SELECT 1 AS here WHERE EXISTS (SELECT 1 FROM keys WHERE root = ?1) OR EXISTS (SELECT 1 FROM docs WHERE owner = ?1)",
        )
        .bind(said),
      this.#db
        .prepare("SELECT day, docs, bytes, keys FROM net_day WHERE net = ?1 AND day >= ?2 ORDER BY day DESC")
        .bind(said, dayOf(now) - 1),
      this.#db.prepare("SELECT COUNT(*) AS n FROM reports WHERE net = ?").bind(said),
    ]);
    if (firstOf(key)) return { kind: "key", root: said };
    const listed = (days?.results ?? []) as { day: number; docs: number; bytes: number; keys: number }[];
    if (listed.length > 0) return { kind: "net", net: said, days: listed };
    // A reporter's network is digested with the evidence key, not the day's, so it never meets the quotas.
    const reported = firstOf<{ n: number }>(reports)?.n ?? 0;
    return reported > 0 ? { kind: "reporter", net: said, reports: reported } : { kind: "none" };
  }
}
