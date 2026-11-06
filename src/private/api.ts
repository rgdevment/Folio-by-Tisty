import { type AdminAction, administer, setPermitHolds } from "../core/admin";
import { dayOf } from "../core/limits";
import { netDigest } from "../core/net";
import {
  type Asked,
  latestVersion,
  readDoc,
  readFiles,
  type Served,
  type ServedFiles,
  type SyncTools,
} from "../core/read";
import { type Refused, tooFast } from "../core/refused";
import { type ReportTools, reportDoc, saidOf } from "../core/report";
import { takeRevocations } from "../core/revocations";
import { startNow } from "../core/start";
import { type FirstUpload, filesEnvelopeBytesAtMost, uploadDoc, uploadFiles } from "../core/upload";

const PREFIX = "/api/v1/";
const DOC_PATH = /^docs\/([A-Za-z0-9]{8})(?:\/(report|admin|pause|resume|appeal|latest|permit))?$/;
const FILES_PATH = /^docs\/([A-Za-z0-9]{8})\/files(?:\/([A-Za-z0-9_-]{43}))?$/;
const REPORT_BYTES_AT_MOST = 16 * 1024;
const PERMIT_BYTES_AT_MOST = 256;
const REVOCATIONS_BYTES_AT_MOST = 8 * 1024;

export const STATUS: Record<Refused["refused"], number> = {
  missing: 404,
  paused: 403,
  blocked: 403,
  slow: 429,
  quota: 429,
  proof: 429,
  bad_report: 400,
  too_big: 413,
  not_blocked: 409,
  appealed: 409,
  failed: 500,
  behind: 409,
  not_yours: 403,
  shares_full: 409,
  bad_upload: 400,
  uploads_off: 503,
  outdated: 426,
  envelope: 422,
  revoked: 403,
  bad_revocation: 400,
};

const ADMIN_ROUTES: Record<string, AdminAction> = {
  "GET admin": "status",
  "POST pause": "pause",
  "POST resume": "resume",
  "POST appeal": "appeal",
  "DELETE ": "stop",
};

const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

const json = (status: number, said: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(said), {
    status,
    headers: { ...API_HEADERS, "Content-Type": "application/json", ...headers },
  });

const refusal = (refused: Refused, now: number): Response => {
  const waits = "until" in refused ? { "Retry-After": String(Math.ceil((refused.until - now) / 1000)) } : undefined;
  return json(STATUS[refused.refused], refused, waits);
};

const ipOf = (request: Request): string => request.headers.get("CF-Connecting-IP") ?? "";

const cfOf = (request: Request) => (request as { cf?: { country?: string; colo?: string; asn?: number } }).cf;

export interface Api {
  tools: ReportTools & SyncTools;
  waitUntil: (work: Promise<unknown>) => void;
  now: number;
}

const askedOf = (request: Request, id: string, now: number): Asked => {
  const proof = request.headers.get("Folio-Proof");
  return { id, now, ip: ipOf(request), ...(proof === null ? {} : { proof }) };
};

const bytesAnswer = (
  request: Request,
  id: string,
  answer: Served | ServedFiles,
  { tools, waitUntil, now }: Api,
  headers: Record<string, string> = {},
): Response => {
  const cf = cfOf(request);
  // What the read log keeps (decision 98): the document, the country and the data center, never the network.
  console.log(JSON.stringify({ read: id, country: cf?.country, colo: cf?.colo }));
  const { note } = answer;
  if (note) waitUntil(tools.store.note(note, dayOf(now)));
  return new Response(answer.body, {
    headers: { ...API_HEADERS, "Content-Type": "application/octet-stream", ...headers },
  });
};

const answerRead = async (request: Request, id: string, api: Api): Promise<Response> => {
  const answer = await readDoc(askedOf(request, id, api.now), api.tools);
  if (!("served" in answer)) return refusal(answer, api.now);
  return bytesAnswer(request, id, answer, api, {
    "Folio-Version": String(answer.version.n),
    "Folio-Hash": answer.version.hash,
    "Folio-Arrived": String(answer.version.at),
    "Folio-Dies-On": String(answer.diesOn),
    "Folio-Revocations": JSON.stringify(answer.revocations),
  });
};

const answerFiles = async (request: Request, id: string, hash: string, api: Api): Promise<Response> => {
  const answer = await readFiles({ ...askedOf(request, id, api.now), hash }, api.tools);
  return "served" in answer ? bytesAnswer(request, id, answer, api) : refusal(answer, api.now);
};

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Read in pieces, since a body sent in parts says no length and could be any size.
const blobUpTo = async (request: Request, atMost: number): Promise<Blob | null> => {
  if (!request.body) return new Blob();
  const reader = request.body.getReader();
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(pieces);
    bytes += value.byteLength;
    if (bytes > atMost) {
      await reader.cancel();
      return null;
    }
    pieces.push(value);
  }
};

const textUpTo = async (request: Request, atMost: number): Promise<string | null> =>
  (await blobUpTo(request, atMost))?.text() ?? null;

const firstUploadOf = ({ headers }: Request): FirstUpload | undefined => {
  const start = headers.get("Folio-Start");
  if (start === null) return undefined;
  const anchor = headers.get("Folio-Anchor");
  return {
    start,
    proof: headers.get("Folio-Proof") ?? "",
    adminToken: headers.get("Folio-Admin") ?? "",
    ttlDays: Number(headers.get("Folio-Ttl-Days")),
    ...(anchor === null ? {} : { anchor }),
  };
};

const bytesUpTo = (request: Request, atMost: number) => async () => {
  if (Number(request.headers.get("Content-Length") ?? 0) > atMost) return null;
  const blob = await blobUpTo(request, atMost);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
};

const answerUpload = async (request: Request, id: string, { tools, now }: Api): Promise<Response> => {
  const bytes = bytesUpTo(request, tools.limits.envelopeBytesAtMost);
  const first = firstUploadOf(request);
  const files = request.headers.get("Folio-Files");
  const answer = await uploadDoc(
    { id, now, ip: ipOf(request), bytes, ...(first ? { first } : {}), ...(files === null ? {} : { files }) },
    tools,
  );
  return "refused" in answer ? refusal(answer, now) : json(200, answer);
};

const answerFilesUpload = async (request: Request, id: string, { tools, now }: Api): Promise<Response> => {
  const bytes = bytesUpTo(request, filesEnvelopeBytesAtMost(tools.limits));
  const answer = await uploadFiles({ id, now, ip: ipOf(request), bytes }, tools);
  return "refused" in answer ? refusal(answer, now) : json(200, answer);
};

const answerLatest = async (request: Request, id: string, { tools, now }: Api): Promise<Response> => {
  const answer = await latestVersion({ id, now, ip: ipOf(request) }, tools);
  return "refused" in answer ? refusal(answer, now) : json(200, answer);
};

const answerPermit = async (request: Request, id: string, api: Api): Promise<Response> => {
  const { tools, now } = api;
  const text = await textUpTo(request, PERMIT_BYTES_AT_MOST);
  const said = text === null ? null : jsonOf(text);
  if (!setPermitHolds(said)) return refusal({ refused: "bad_upload" }, now);
  const token = request.headers.get("Folio-Admin") ?? "";
  const answer = await administer({ id, now, action: "permit", token, ip: ipOf(request), permit: said.permit }, tools);
  return "refused" in answer ? refusal(answer, now) : json(200, answer);
};

const answerRevocations = async (request: Request, { tools, now }: Api): Promise<Response> => {
  const text = await textUpTo(request, REVOCATIONS_BYTES_AT_MOST);
  if (text === null) return refusal({ refused: "too_big" }, now);
  const answer = await takeRevocations({ said: jsonOf(text), ip: ipOf(request), now }, tools);
  return "refused" in answer ? refusal(answer, now) : json(200, answer);
};

const answerReport = async (request: Request, id: string, { tools, now }: Api): Promise<Response> => {
  const text = await textUpTo(request, REPORT_BYTES_AT_MOST);
  if (text === null) return refusal({ refused: "too_big" }, now);
  const said = saidOf(jsonOf(text), tools.limits);
  if (!said) return refusal({ refused: "bad_report" }, now);

  const proof = request.headers.get("Folio-Proof");
  const answer = await reportDoc(
    { id, now, said, ip: ipOf(request), asn: cfOf(request)?.asn ?? 0, ...(proof === null ? {} : { proof }) },
    tools,
  );
  return "refused" in answer ? refusal(answer, now) : json(202, answer);
};

const answerAdmin = async (
  request: Request,
  id: string,
  action: AdminAction,
  { tools, now }: Api,
): Promise<Response> => {
  const token = request.headers.get("Folio-Admin") ?? "";
  const answer = await administer({ id, now, action, token, ip: ipOf(request) }, tools);
  return "refused" in answer ? refusal(answer, now) : json(200, answer);
};

const answerStart = async (request: Request, { tools, now }: Api): Promise<Response> => {
  const net = await netDigest(await tools.dayKey(dayOf(now)), ipOf(request));
  // The brake and not a count: a start keeps nothing, so it should not write a row either.
  if (!(await tools.limiter.allows(net))) return refusal(tooFast(now), now);
  return json(200, await startNow(tools.secret, now));
};

const route = async (request: Request, api: Api): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(PREFIX)) return new Response(null, { status: 404 });
  const path = pathname.slice(PREFIX.length);

  if (path === "start" && request.method === "POST") return answerStart(request, api);
  if (path === "revocations" && request.method === "POST") return answerRevocations(request, api);
  const [, filesOf, named] = FILES_PATH.exec(path) ?? [];
  if (filesOf && named && request.method === "GET") return answerFiles(request, filesOf, named, api);
  if (filesOf && !named && request.method === "PUT") return answerFilesUpload(request, filesOf, api);
  const [, id, part = ""] = DOC_PATH.exec(path) ?? [];
  if (!id) return json(404, { refused: "missing" });

  const route = `${request.method} ${part}`;
  if (route === "GET ") return answerRead(request, id, api);
  if (route === "PUT ") return answerUpload(request, id, api);
  if (route === "GET latest") return answerLatest(request, id, api);
  if (route === "PUT permit") return answerPermit(request, id, api);
  if (route === "POST report") return answerReport(request, id, api);
  const action = ADMIN_ROUTES[route];
  return action ? answerAdmin(request, id, action, api) : json(404, { refused: "missing" });
};

// A failure answers like any refusal, with the same headers, so a client knows to send it again.
export const answer = async (request: Request, api: Api): Promise<Response> => {
  try {
    return await route(request, api);
  } catch (error) {
    console.error("an answer failed", String(error));
    return refusal({ refused: "failed" }, api.now);
  }
};
