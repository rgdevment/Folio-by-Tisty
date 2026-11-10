import type { Reviewed, Revocation } from "@tisty/contracts";
import type { Arrived } from "../read";
import { said } from "./speak";

export const notArrived = (refused: string): string | undefined => {
  const why: Record<string, string> = said().notArrived;
  return why[refused];
};

export interface NotArrived {
  refused: string;
  salt?: string;
  bits?: number;
}

const jsonIn = (said: string | null): unknown => {
  try {
    return JSON.parse(said ?? "null");
  } catch {
    return null;
  }
};

const revocationsIn = (said: string | null): Revocation[] => {
  const read = jsonIn(said);
  return Array.isArray(read) ? (read as Revocation[]) : [];
};

export const asking = (path: string, proof?: string, caseToken?: string): Promise<Response> =>
  fetch(path, {
    credentials: "omit",
    cache: "no-store",
    ...(proof === undefined ? {} : { headers: { "Folio-Proof": proof } }),
    ...(caseToken === undefined ? {} : { headers: { "Folio-Case": caseToken } }),
  });

const arrivedFrom = async (response: Response): Promise<Arrived | NotArrived> => {
  if (!response.ok) return (await response.json()) as NotArrived;
  const arrivedAt = Number(response.headers.get("Folio-Arrived"));
  const diesOn = Number(response.headers.get("Folio-Dies-On"));
  // Without its dates a signature would be weighed against 1970, so it is not taken as an answer.
  if (!(arrivedAt > 0 && diesOn > 0)) return { refused: "unreachable" };
  const revocations = revocationsIn(response.headers.get("Folio-Revocations"));
  const version = Number(response.headers.get("Folio-Version"));
  const reviewed = jsonIn(response.headers.get("Folio-Reviewed"));
  const reviewedAt = Number(response.headers.get("Folio-Reviewed-Arrived"));
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    arrivedAt,
    diesOn,
    revocations,
    ...(version > 0 ? { version } : {}),
    ...(reviewed !== null && typeof reviewed === "object" ? { reviewed: reviewed as Reviewed } : {}),
    ...(reviewedAt > 0 ? { reviewedAt } : {}),
  };
};

// Loaded before anything else on the page, so the envelope is already coming while the reader's code is.
export const askFor = async (id: string, proof?: string): Promise<Arrived | NotArrived> => {
  try {
    return await arrivedFrom(await asking(`/api/v1/docs/${id}`, proof));
  } catch {
    return { refused: "unreachable" };
  }
};

export const askForCase = async (id: string, caseToken: string): Promise<Arrived | NotArrived> => {
  try {
    return await arrivedFrom(await asking(`/api/v1/cases/${id}`, undefined, caseToken));
  } catch {
    return { refused: "unreachable" };
  }
};
