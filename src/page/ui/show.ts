import type { Translation } from "@tisty/contracts";
import { fromBase64Url, words } from "../../core/bytes";
import { openRecords } from "../../core/case-records";
import { type EnvelopeRefusal, EnvelopeRefused } from "../../rules/envelope";
import { preferredTranslation } from "../languages";
import type { CaseLink } from "../link";
import { OPERATOR_KEY } from "../operator-key";
import type { Arrived, Opened } from "../read";
import { openLink } from "../read";
import { askFor, askForCase, asking, NOT_ARRIVED, type NotArrived } from "./ask";
import { domPurifyCleaner } from "./clean";
import { drawClosed } from "./closed";
import { filePresser, saved } from "./files";
import { finished, pictureAddresses } from "./finish";
import { drawFrame, type Shown } from "./frame";
import { offerLanguages } from "./language-switch";
import { offerReport, type Reportable } from "./report";
import { answeringProof } from "./solve";

const DAY_MILLISECONDS = 86_400_000;

const COULD_NOT_ARRIVE = "No se pudo traer el documento. Vuelve a intentarlo en un momento.";
const CASE_GONE = "Este link de caso no existe o ya caducó. Pídele uno nuevo a quien te lo entregó.";
const ASKING_THE_KEY = "Pega la llave del documento, o su link completo.";
const KEY_IN_WHAT_WAS_PASTED = /[A-Za-z0-9_-]{43}/;

const REFUSED: Record<EnvelopeRefusal, string> = {
  newer:
    "Este documento se escribió con una versión más nueva de la que esta página sabe leer. Vuelve a intentarlo más tarde.",
  older: "Este documento es demasiado antiguo para esta página.",
  damaged: "Este documento llegó dañado, así que no se muestra.",
  unsigned: "La firma de este documento no vale, así que no se muestra.",
  key: "Este link no abre el documento. Pídele el link completo a quien te lo mandó.",
};

const lastDay = (diesOn: number): string =>
  new Date(diesOn * DAY_MILLISECONDS).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });

interface Showing {
  id: string;
  linkKey: string;
  arrived: Arrived;
  opened: Opened;
}

interface Language {
  lang: string;
  showing: Showing;
  shown: Shown;
}

const opening = async (id: string, linkKey: string, arrived: Arrived): Promise<Showing> => ({
  id,
  linkKey,
  arrived,
  opened: await openLink(id, linkKey, arrived),
});

const ownerOf = ({ fingerprint, ownerFingerprint }: Opened): string => ownerFingerprint ?? fingerprint;

const shownOf = ({ id, linkKey, opened }: Showing, caseToken?: string): Shown => {
  const { held, pictures, verdict, fingerprint, ownerFingerprint, diesOn } = opened;
  const cleaner = domPurifyCleaner(window);
  const addresses = pictureAddresses(held.pictures ?? [], pictures);
  return {
    held,
    wordsOf: (html) => finished(cleaner.clean(html), addresses),
    seal: {
      verdict,
      fingerprint,
      ownerFingerprint,
      diesOn: lastDay(diesOn),
    },
    pressFile: filePresser({ id, linkKey, held, ...(caseToken === undefined ? {} : { caseToken }) }),
  };
};

const reportableOf = ({ id, linkKey, arrived: { version } }: Showing): Reportable => ({
  id,
  linkKey,
  operatorKey: OPERATOR_KEY,
  ...(version === undefined ? {} : { version }),
});

// Whatever keeps a translation from opening, the reader stays on what was already checked.
// The server keeps a language under its anchor's owner, so a translation by anyone else, or in another tongue, is a lie.
const belongs = ({ opened }: Showing, { lang }: Translation, anchor: Opened): boolean =>
  ownerOf(opened) === ownerOf(anchor) && opened.held.lang === lang;

const translated = async ({ document: id, key = "" }: Translation): Promise<Showing | undefined> => {
  try {
    const answer = await answeringProof(await askFor(id), (proof) => askFor(id, proof));
    return "refused" in answer ? undefined : await opening(id, key, answer);
  } catch {
    return undefined;
  }
};

const shownInLanguages = async (anchor: Showing): Promise<void> => {
  const { lang = "", languages = [] } = anchor.opened.held;
  const anchorLanguage = { lang, showing: anchor, shown: shownOf(anchor) };
  const kept = new Map<string, Language>([[lang, anchorLanguage]]);
  const languageOf = async (chosen: string): Promise<Language | undefined> => {
    const known = kept.get(chosen);
    const translation = languages.find((one) => one.lang === chosen);
    if (known || !translation) return known;
    const showing = await translated(translation);
    if (!showing || !belongs(showing, translation, anchor.opened)) return undefined;
    const language = { lang: chosen, showing, shown: shownOf(showing) };
    kept.set(chosen, language);
    return language;
  };
  const preferred = preferredTranslation(navigator.languages ?? [], anchor.opened.held.lang, languages);
  const first = preferred && (await languageOf(preferred.lang));
  let current = first ?? anchorLanguage;
  const show = drawFrame(current.shown);
  offerReport(() => reportableOf(current.showing));
  if (languages.length === 0) return;
  offerLanguages({
    langs: [lang, ...languages.map((one) => one.lang)],
    shown: current.lang,
    missedTheReaders: preferred !== undefined && first === undefined,
    choose: async (chosen) => {
      const next = await languageOf(chosen);
      if (!next) return false;
      current = next;
      show(next.shown);
      return true;
    },
  });
};

const shown = async (id: string, linkKey: string, arrived: Arrived, caseToken?: string): Promise<void> => {
  const anchor = await opening(id, linkKey, arrived);
  if (caseToken === undefined) await shownInLanguages(anchor);
  else drawFrame(shownOf(anchor, caseToken));
};

const opened = async (id: string, linkKey: string, arrived: Arrived, caseToken?: string): Promise<boolean> => {
  try {
    await shown(id, linkKey, arrived, caseToken);
    return true;
  } catch (error) {
    if (!(error instanceof EnvelopeRefused)) throw error;
    drawClosed(REFUSED[error.refusal]);
    return false;
  }
};

const savedRecords = async (id: string, token: string, recordsKey: string): Promise<void> => {
  const response = await asking(`/api/v1/cases/${id}/records`, undefined, token);
  const { sealed } = (await response.json()) as { sealed: string };
  const records = await openRecords(sealed, fromBase64Url(recordsKey));
  saved({ name: `folio-${id}-registros.json` }, words(records));
};

const offerCaseTools = (id: string, { token, recordsKey }: CaseLink): void => {
  document.getElementById("edit-in-tisty")?.remove();
  document.querySelector(".actions-note")?.remove();
  const button = document.getElementById("report") as HTMLButtonElement;
  if (recordsKey === undefined) {
    button.remove();
    return;
  }
  button.textContent = "Descargar registros";
  button.disabled = false;
  button.addEventListener("click", () => {
    savedRecords(id, token, recordsKey).catch(() => {
      button.textContent = "No se pudieron traer los registros";
    });
  });
};

export const showCase = async (id: string, link: CaseLink): Promise<void> => {
  const answer = await askForCase(id, link.token);
  if ("refused" in answer) {
    drawClosed(answer.refused === "missing" ? CASE_GONE : (NOT_ARRIVED[answer.refused] ?? COULD_NOT_ARRIVE));
    return;
  }
  const linkKey = KEY_IN_WHAT_WAS_PASTED.exec(prompt(ASKING_THE_KEY) ?? "")?.[0] ?? "";
  if (await opened(id, linkKey, answer, link.token)) offerCaseTools(id, link);
};

export const showLink = async (
  id: string,
  linkKey: string,
  asked: Promise<Arrived | NotArrived>,
  notFound: string,
): Promise<void> => {
  // Past a document's free readers of the day, the server asks for a little work and not for a wait.
  const answer = await answeringProof(await asked, (proof) => askFor(id, proof));
  if ("refused" in answer) {
    if (answer.refused === "missing") location.replace(notFound);
    else drawClosed(NOT_ARRIVED[answer.refused] ?? COULD_NOT_ARRIVE);
    return;
  }
  await opened(id, linkKey, answer);
};
