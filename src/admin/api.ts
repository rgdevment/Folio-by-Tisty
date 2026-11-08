import type { Acted, CloudModeration, NewCase } from "../cloudflare/moderation";
import { isSealedRecords } from "../core/case-records";
import type { About, Dashboard, TopOrder } from "../core/dashboard";
import type { AccessSettings, Certs } from "./access";
import { isOperator } from "./access";

export interface AdminApi {
  moderation: Pick<
    CloudModeration,
    | "queue"
    | "accept"
    | "reject"
    | "block"
    | "reportWasFalse"
    | "opened"
    | "panic"
    | "purgeOwner"
    | "purgePreview"
    | "makeCase"
    | "handedOver"
    | "forgetContact"
    | "networkWasFalse"
    | "clearWarning"
    | "blockKey"
    | "unblockKey"
  >;
  dashboard: Dashboard;
  about: About;
  access: AccessSettings;
  certs: Certs;
  now: number;
}

const ACTION_PATH =
  /^\/api\/docs\/([A-Za-z0-9]{8})\/(accept|reject|block|opened|panic|purge_owner|case|handed_over|clear_warning)$/;
const PURGE_PREVIEW_PATH = /^\/api\/docs\/([A-Za-z0-9]{8})\/purge_owner$/;
const TOKEN_HASH = /^[A-Za-z0-9_-]{43}$/;
const REPORT_PATH =
  /^\/api\/docs\/([A-Za-z0-9]{8})\/reports\/([A-Za-z0-9_-]{1,64})\/(false|false_network|forget_contact)$/;
const ON_REPORT = {
  false: "reportWasFalse",
  false_network: "networkWasFalse",
  forget_contact: "forgetContact",
} as const;
const KEY_PATH = /^\/api\/keys\/([A-Za-z0-9_-]{43})\/(block|unblock)$/;
const KEY_VIEW_PATH = /^\/api\/keys\/([A-Za-z0-9_-]{43})(\/records)?$/;
const TOP_ORDERS: readonly TopOrder[] = ["readers", "weight", "edits", "oldest"];
const OWNERS_AT_MOST = 200;
const SAID_AT_MOST = 500;
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Content-Type": "application/json",
};

const json = (status: number, said: unknown): Response =>
  new Response(JSON.stringify(said), { status, headers: HEADERS });

const answerOf = (acted: Acted): Response =>
  acted === "done" ? json(200, { done: true }) : json(404, { refused: "missing" });

const noteOf = async (request: Request): Promise<string | null> => {
  const said = (await request.json().catch(() => null)) as { note?: unknown } | null;
  const note = typeof said?.note === "string" ? said.note.trim() : "";
  return note.length > 0 && note.length <= SAID_AT_MOST ? note : null;
};

const newCaseOf = async (request: Request): Promise<NewCase | null> => {
  const said = (await request.json().catch(() => null)) as Partial<NewCase> | null;
  const { version, tokenHash, sealedRecords } = said ?? {};
  if (!Number.isInteger(version) || (version as number) < 1) return null;
  if (typeof tokenHash !== "string" || !TOKEN_HASH.test(tokenHash)) return null;
  if (sealedRecords !== undefined && !isSealedRecords(sealedRecords)) return null;
  return { version: version as number, tokenHash, ...(sealedRecords === undefined ? {} : { sealedRecords }) };
};

const act = async (request: Request, path: string, { moderation, now }: AdminApi): Promise<Response> => {
  const [, reportDoc, net, onReport] = REPORT_PATH.exec(path) ?? [];
  if (reportDoc && net) {
    const acting = ON_REPORT[onReport as keyof typeof ON_REPORT];
    return answerOf(await moderation[acting](reportDoc, net, now));
  }
  const [, root, onKey] = KEY_PATH.exec(path) ?? [];
  if (root && onKey === "unblock") return answerOf(await moderation.unblockKey(root, now));
  if (root) {
    const reason = await noteOf(request);
    if (!reason) return json(400, { refused: "no_reason" });
    return answerOf(await moderation.blockKey(root, reason, now));
  }
  const [, id, action] = ACTION_PATH.exec(path) ?? [];
  if (!id) return json(404, { refused: "missing" });
  if (action === "accept") return answerOf(await moderation.accept(id, now));
  if (action === "reject") return answerOf(await moderation.reject(id, now));
  if (action === "handed_over") return answerOf(await moderation.handedOver(id, now));
  if (action === "clear_warning") return answerOf(await moderation.clearWarning(id, now));
  if (action === "case") {
    const made = await newCaseOf(request);
    return made ? answerOf(await moderation.makeCase(id, made, now)) : json(400, { refused: "bad_case" });
  }
  const note = await noteOf(request);
  if (!note) return json(400, { refused: "no_reason" });
  if (action === "purge_owner") {
    const purged = await moderation.purgeOwner(id, note, now);
    return purged ? json(200, purged) : json(404, { refused: "missing" });
  }
  if (action === "panic") {
    const records = await moderation.panic(id, note, now);
    return records ? json(200, { records }) : json(404, { refused: "missing" });
  }
  return answerOf(action === "block" ? await moderation.block(id, note, now) : await moderation.opened(id, note, now));
};

const orderOf = (said: string | null): TopOrder => TOP_ORDERS.find((one) => one === said) ?? "readers";

const shownEmail = (email: string): string => {
  const [name = ""] = email.split("@");
  return name ? `${name}@…` : "";
};

const look = async (url: URL, api: AdminApi): Promise<Response | null> => {
  const { dashboard, now } = api;
  const asked = url.searchParams;
  switch (url.pathname) {
    case "/api/overview":
      return json(200, { ...(await dashboard.overview(now)), ...api.about, operator: shownEmail(api.access.email) });
    case "/api/days":
      return json(200, await dashboard.days(now));
    case "/api/log":
      return json(200, await dashboard.log());
    case "/api/nets":
      return json(200, await dashboard.nets(now));
    case "/api/top":
      return json(200, await dashboard.top(now, orderOf(asked.get("by")), asked.get("flagged") === "1"));
    case "/api/owners":
      return json(200, await dashboard.owners((asked.get("docs") ?? "").split(",").slice(0, OWNERS_AT_MOST), now));
    case "/api/find":
      return json(200, await dashboard.find(asked.get("q") ?? "", now));
  }
  const [, root, records] = KEY_VIEW_PATH.exec(url.pathname) ?? [];
  if (!root) return null;
  const found = records ? await dashboard.keyRecords(root, now) : await dashboard.key(root, now);
  return found ? json(200, found) : json(404, { refused: "missing" });
};

const reportsFromOf = (request: Request): number => {
  const from = Number(new URL(request.url).searchParams.get("from"));
  return Number.isSafeInteger(from) && from > 0 ? from : 0;
};

export const answer = async (request: Request, api: AdminApi): Promise<Response> => {
  const operator = await isOperator(request.headers.get("Cf-Access-Jwt-Assertion"), api.access, api.certs, api.now);
  if (!operator) return json(403, { refused: "not_the_operator" });

  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/queue") {
    const queue = await api.moderation.queue(api.now, reportsFromOf(request));
    const docs = [...queue.reports.map((one) => one.doc), ...queue.docs.map((one) => one.id)];
    return json(200, { ...queue, owners: await api.dashboard.owners(docs, api.now) });
  }
  const looked = request.method === "GET" ? await look(url, api) : null;
  if (looked) return looked;
  const [, toPurge] = PURGE_PREVIEW_PATH.exec(pathname) ?? [];
  if (request.method === "GET" && toPurge) {
    const preview = await api.moderation.purgePreview(toPurge, api.now);
    return preview ? json(200, preview) : json(404, { refused: "missing" });
  }
  if (request.method !== "POST") return json(404, { refused: "missing" });
  // A form or a link from elsewhere cannot send this header, and the preflight it needs is never answered.
  if (request.headers.get("Folio-Operator") !== "1") return json(403, { refused: "not_the_operator" });
  return act(request, pathname, api);
};
