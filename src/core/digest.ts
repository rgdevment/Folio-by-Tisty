import { DAY_MS, LEVEL_ONE } from "./limits";
import { hourOf } from "./start";
import type { News, Stage, Store } from "./store";

export interface DigestTools {
  store: Pick<Store, "stage" | "digested" | "news" | "setDigested">;
  send: (subject: string, text: string) => Promise<void>;
  panel?: string | undefined;
  newKeysToNotice?: number;
}

const SEEN_AT_MOST = 50;

const listOf = (title: string, lines: string[], more = lines.length >= SEEN_AT_MOST): string[] => {
  if (lines.length === 0) return [];
  return [title, ...lines, ...(more ? ["(hay más)"] : []), ""];
};

const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

const textOf = (stage: Stage, was: Stage, news: News, keysSaid: number, panel?: string) =>
  [
    ...(stage === was ? [] : [`Servicio: ${stage} (antes: ${was})`, ""]),
    ...(keysSaid > 0 ? [`Llaves nuevas el ${dateOf(news.newKeysDay)}: ${keysSaid}`, ""] : []),
    ...(news.newKeysNearTheirTop ? [`Tope de subidas nuevas casi agotado el ${dateOf(news.newKeysDay)}.`, ""] : []),
    ...listOf(
      `Denuncias nuevas (${news.reportsTotal}):`,
      news.reports.map(
        ({ doc, category, nets, uncounted }) =>
          `${category}: ${doc}, ${nets} ${nets === 1 ? "red" : "redes"}${uncounted > 0 ? `, ${uncounted} sin contar` : ""}`,
      ),
      news.reportLines > news.reports.length,
    ),
    ...listOf("Bloqueados:", news.blocked),
    ...listOf("Reclamos:", news.appealed),
    ...(panel ? [`Panel: ${panel}`] : []),
  ]
    .join("\n")
    .trimEnd();

// Marked only once it went, so a mail that fails tells it all the next time.
export const sendDigest = async (
  now: number,
  { store, send, panel, newKeysToNotice = LEVEL_ONE.newKeysToNotice }: DigestTools,
): Promise<boolean> => {
  const hour = hourOf(now);
  const { hour: told, alerted } = await store.digested();
  const stage = await store.stage();
  const news = await store.news(told, hour, SEEN_AT_MOST);
  const keysSaid = news.newKeys >= newKeysToNotice ? news.newKeys : 0;
  const empty =
    news.reports.length + news.blocked.length + news.appealed.length + keysSaid === 0 && !news.newKeysNearTheirTop;
  if (empty && stage === alerted) return false;

  const grave = news.reports.some(({ category }) => category === "csam");
  await send(grave ? "Folio: resumen, con CSAM" : "Folio: resumen", textOf(stage, alerted, news, keysSaid, panel));
  await store.setDigested(hour - 1, stage);
  return true;
};
