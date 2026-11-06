import type { Acted, CloudModeration } from "../cloudflare/moderation";
import type { AccessSettings, Certs } from "./access";
import { isOperator } from "./access";

export interface AdminApi {
  moderation: Pick<CloudModeration, "queue" | "accept" | "reject" | "block" | "reportWasFalse" | "opened">;
  access: AccessSettings;
  certs: Certs;
  now: number;
}

const ACTION_PATH = /^\/api\/docs\/([A-Za-z0-9]{8})\/(accept|reject|block|opened)$/;
const FALSE_REPORT_PATH = /^\/api\/docs\/([A-Za-z0-9]{8})\/reports\/([A-Za-z0-9_-]{1,64})\/false$/;
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

const act = async (request: Request, path: string, { moderation, now }: AdminApi): Promise<Response> => {
  const [, reportDoc, net] = FALSE_REPORT_PATH.exec(path) ?? [];
  if (reportDoc && net) return answerOf(await moderation.reportWasFalse(reportDoc, net, now));
  const [, id, action] = ACTION_PATH.exec(path) ?? [];
  if (!id) return json(404, { refused: "missing" });
  if (action === "accept") return answerOf(await moderation.accept(id, now));
  if (action === "reject") return answerOf(await moderation.reject(id, now));
  const note = await noteOf(request);
  if (!note) return json(400, { refused: "no_reason" });
  return answerOf(action === "block" ? await moderation.block(id, note, now) : await moderation.opened(id, note, now));
};

export const answer = async (request: Request, api: AdminApi): Promise<Response> => {
  const operator = await isOperator(request.headers.get("Cf-Access-Jwt-Assertion"), api.access, api.certs, api.now);
  if (!operator) return json(403, { refused: "not_the_operator" });

  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/api/queue") return json(200, await api.moderation.queue(api.now));
  if (request.method !== "POST") return json(404, { refused: "missing" });
  // A form or a link from elsewhere cannot send this header, and the preflight it needs is never answered.
  if (request.headers.get("Folio-Operator") !== "1") return json(403, { refused: "not_the_operator" });
  return act(request, pathname, api);
};
