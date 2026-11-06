import { hourOf } from "./start";
import type { News, Stage, Store } from "./store";

export interface DigestTools {
  store: Pick<Store, "stage" | "digested" | "news" | "setDigested">;
  send: (subject: string, text: string) => Promise<void>;
  panel?: string | undefined;
}

const SEEN_AT_MOST = 50;

const listOf = (title: string, lines: string[]): string[] => {
  if (lines.length === 0) return [];
  const more = lines.length >= SEEN_AT_MOST ? ["(hay más)"] : [];
  return [title, ...lines, ...more, ""];
};

const textOf = (stage: Stage, was: Stage, { reports, blocked, appealed }: News, panel?: string): string =>
  [
    ...(stage === was ? [] : [`Gasto: ${stage} (antes: ${was})`, ""]),
    ...listOf(
      "Denuncias nuevas:",
      reports.map(({ doc, category, nets }) => `${category}: ${doc}, ${nets} ${nets === 1 ? "red" : "redes"}`),
    ),
    ...listOf("Bloqueados:", blocked),
    ...listOf("Reclamos:", appealed),
    ...(panel ? [`Panel: ${panel}`] : []),
  ]
    .join("\n")
    .trimEnd();

// Marked only once it went, so a mail that fails tells it all the next time.
export const sendDigest = async (now: number, { store, send, panel }: DigestTools): Promise<boolean> => {
  const hour = hourOf(now);
  const { hour: told, alerted } = await store.digested();
  const stage = await store.stage();
  const news = await store.news(told, hour, SEEN_AT_MOST);
  const empty = news.reports.length + news.blocked.length + news.appealed.length === 0;
  if (empty && stage === alerted) return false;

  const grave = news.reports.some(({ category }) => category === "csam");
  await send(grave ? "Folio: resumen, con CSAM" : "Folio: resumen", textOf(stage, alerted, news, panel));
  await store.setDigested(hour - 1, stage);
  return true;
};
