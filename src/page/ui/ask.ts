import type { Revocation } from "@tisty/contracts";
import type { Arrived } from "../read";

export const TOO_MANY_VISITS = "Hay demasiadas visitas desde tu red. Vuelve a intentarlo en un momento.";

export const NOT_ARRIVED: Record<string, string> = {
  paused: "Quien compartió este documento lo pausó.",
  blocked: "Este documento fue bloqueado.",
  slow: TOO_MANY_VISITS,
  quota: "Hay demasiadas visitas desde tu red. Vuelve a intentarlo más tarde.",
  proof: "Este documento tuvo muchas visitas hoy. Vuelve a intentarlo más tarde.",
};

export interface NotArrived {
  refused: string;
  salt?: string;
  bits?: number;
}

const revocationsIn = (said: string | null): Revocation[] => {
  try {
    const read: unknown = JSON.parse(said ?? "[]");
    return Array.isArray(read) ? (read as Revocation[]) : [];
  } catch {
    return [];
  }
};

export const asking = (path: string, proof?: string): Promise<Response> =>
  fetch(path, {
    credentials: "omit",
    cache: "no-store",
    ...(proof === undefined ? {} : { headers: { "Folio-Proof": proof } }),
  });

// Loaded before anything else on the page, so the envelope is already coming while the reader's code is.
export const askFor = async (id: string, proof?: string): Promise<Arrived | NotArrived> => {
  try {
    const response = await asking(`/api/v1/docs/${id}`, proof);
    if (!response.ok) return (await response.json()) as NotArrived;
    const arrivedAt = Number(response.headers.get("Folio-Arrived"));
    const diesOn = Number(response.headers.get("Folio-Dies-On"));
    // Without its dates a signature would be weighed against 1970, so it is not taken as an answer.
    if (!(arrivedAt > 0 && diesOn > 0)) return { refused: "unreachable" };
    const revocations = revocationsIn(response.headers.get("Folio-Revocations"));
    const version = Number(response.headers.get("Folio-Version"));
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      arrivedAt,
      diesOn,
      revocations,
      ...(version > 0 ? { version } : {}),
    };
  } catch {
    return { refused: "unreachable" };
  }
};
