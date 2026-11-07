import type { Acted, CloudModeration, NewCase } from "../cloudflare/moderation";
import { isSealedRecords } from "../core/case-records";
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
    | "makeCase"
    | "handedOver"
    | "forgetContact"
    | "networkWasFalse"
  >;
  access: AccessSettings;
  certs: Certs;
  now: number;
}

const ACTION_PATH = /^\/api\/docs\/([A-Za-z0-9]{8})\/(accept|reject|block|opened|panic|case|handed_over)$/;
const TOKEN_HASH = /^[A-Za-z0-9_-]{43}$/;
const REPORT_PATH =
  /^\/api\/docs\/([A-Za-z0-9]{8})\/reports\/([A-Za-z0-9_-]{1,64})\/(false|false_network|forget_contact)$/;
const ON_REPORT = {
  false: "reportWasFalse",
  false_network: "networkWasFalse",
  forget_contact: "forgetContact",
} as const;
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
  const [, id, action] = ACTION_PATH.exec(path) ?? [];
  if (!id) return json(404, { refused: "missing" });
  if (action === "accept") return answerOf(await moderation.accept(id, now));
  if (action === "reject") return answerOf(await moderation.reject(id, now));
  if (action === "handed_over") return answerOf(await moderation.handedOver(id, now));
  if (action === "case") {
    const made = await newCaseOf(request);
    return made ? answerOf(await moderation.makeCase(id, made, now)) : json(400, { refused: "bad_case" });
  }
  const note = await noteOf(request);
  if (!note) return json(400, { refused: "no_reason" });
  if (action === "panic") {
    const records = await moderation.panic(id, note, now);
    return records ? json(200, { records }) : json(404, { refused: "missing" });
  }
  return answerOf(action === "block" ? await moderation.block(id, note, now) : await moderation.opened(id, note, now));
};

const reportsFromOf = (request: Request): number => {
  const from = Number(new URL(request.url).searchParams.get("from"));
  return Number.isSafeInteger(from) && from > 0 ? from : 0;
};

export const answer = async (request: Request, api: AdminApi): Promise<Response> => {
  const operator = await isOperator(request.headers.get("Cf-Access-Jwt-Assertion"), api.access, api.certs, api.now);
  if (!operator) return json(403, { refused: "not_the_operator" });

  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/api/queue") {
    return json(200, await api.moderation.queue(api.now, reportsFromOf(request)));
  }
  if (request.method !== "POST") return json(404, { refused: "missing" });
  // A form or a link from elsewhere cannot send this header, and the preflight it needs is never answered.
  if (request.headers.get("Folio-Operator") !== "1") return json(403, { refused: "not_the_operator" });
  return act(request, pathname, api);
};
