import type { Translation } from "@tisty/contracts";
import { fromBase64Url, words } from "../../core/bytes";
import { openRecords } from "../../core/case-records";
import { EnvelopeRefused } from "../../rules/envelope";
import { preferredTranslation } from "../languages";
import type { CaseLink } from "../link";
import { OPERATOR_KEY } from "../operator-key";
import type { Arrived, Opened, ShownEditor } from "../read";
import { openLink } from "../read";
import { keptAsRead, printOf, reachedBy } from "../reviews";
import { askFor, askForCase, asking, type NotArrived, notArrived } from "./ask";
import { domPurifyCleaner } from "./clean";
import { drawClosed } from "./closed";
import { filePresser, saved } from "./files";
import { finished, pictureAddresses } from "./finish";
import { drawCredit, drawFrame, type Shown } from "./frame";
import { keep } from "./kept";
import { offerLanguages } from "./language-switch";
import { offerReport, type Reportable } from "./report";
import { answeringProof } from "./solve";
import { said } from "./speak";

const KEY_IN_WHAT_WAS_PASTED = /[A-Za-z0-9_-]{43}/;

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
  byAnother: boolean;
}

const opening = async (id: string, linkKey: string, arrived: Arrived): Promise<Showing> => ({
  id,
  linkKey,
  arrived,
  opened: await openLink(id, linkKey, arrived),
});

const ownerNamed = ({ held, ownerFingerprint, signerStanding, ownerStanding }: Opened): ShownEditor =>
  ownerFingerprint === null
    ? { name: held.signed_as ?? said().noName, standing: signerStanding }
    : { name: held.owner_name ?? said().noName, standing: ownerStanding };

const shownOf = ({ id, linkKey, opened }: Showing, caseToken?: string): Shown => {
  const { held, pictures } = opened;
  const cleaner = domPurifyCleaner(window);
  const addresses = pictureAddresses(held.pictures ?? [], pictures);
  return {
    held,
    wordsOf: (html) => finished(cleaner.clean(html), addresses),
    seal: opened,
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
// Before contract 1.8.0 no language could name its anchor, so one without it holds only under its anchor's owner.
const belongs = ({ held }: Opened, { lang }: Translation, anchor: string, ownersOwn: boolean): boolean =>
  held.lang === lang && (held.anchor === undefined ? ownersOwn : held.anchor === anchor);

const translated = async ({ document: id, key = "" }: Translation): Promise<Showing | undefined> => {
  try {
    const answer = await answeringProof(await askFor(id), (proof) => askFor(id, proof));
    return "refused" in answer ? undefined : await opening(id, key, answer);
  } catch {
    return undefined;
  }
};

// Only what the anchor's owner keeps, as its owner read it, shows under another root (contract, review.shown).
const showsHere = async (anchor: Showing, translation: Translation, { opened }: Showing, ownersOwn: boolean) =>
  belongs(opened, translation, anchor.id, ownersOwn) &&
  (ownersOwn ||
    keptAsRead(
      { document: translation.document, lang: opened.held.lang ?? "", print: await printOf(opened.parts) },
      anchor.opened.ownerKeeps,
    ));

const credited = (anchor: Showing, { showing, byAnother }: Language): void =>
  drawCredit(byAnother ? { translator: ownerNamed(showing.opened), owner: ownerNamed(anchor.opened) } : null);

const shownInLanguages = async (anchor: Showing): Promise<void> => {
  const { id, opened } = anchor;
  const { lang = "", languages = [] } = opened.held;
  const offered = reachedBy(languages, opened.ownerKeeps);
  const anchorLanguage = { lang, showing: anchor, shown: shownOf(anchor), byAnother: false };
  const kept = new Map<string, Language>([[lang, anchorLanguage]]);
  const languageOf = async (chosen: string): Promise<Language | undefined> => {
    const known = kept.get(chosen);
    const translation = offered.find((one) => one.lang === chosen);
    if (known || !translation) return known;
    const showing = await translated(translation);
    if (!showing) return undefined;
    const ownersOwn = showing.opened.owner === opened.owner;
    if (!(await showsHere(anchor, translation, showing, ownersOwn))) return undefined;
    const language = { lang: chosen, showing, shown: shownOf(showing), byAnother: !ownersOwn };
    kept.set(chosen, language);
    return language;
  };
  const chosenAt = `language ${id}`;
  const preferred = preferredTranslation(navigator.languages ?? [], lang, offered)?.lang;
  let recalled = null as string | null;
  keep((stored) => {
    recalled = stored.getItem(chosenAt);
  });
  const first =
    (recalled !== null && (await languageOf(recalled))) ||
    (preferred !== undefined && (await languageOf(preferred))) ||
    undefined;
  let current = first ?? anchorLanguage;
  const show = drawFrame(current.shown);
  offerReport(() => reportableOf(current.showing));
  credited(anchor, current);
  if (offered.length === 0) return;
  offerLanguages({
    langs: [...new Set([lang, ...offered.map((one) => one.lang)])],
    shown: current.lang,
    missedTheReaders: preferred !== undefined && first === undefined,
    choose: async (chosen) => {
      const next = await languageOf(chosen);
      if (!next) return false;
      current = next;
      show(next.shown);
      credited(anchor, next);
      keep((stored) => stored.setItem(chosenAt, chosen));
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
    drawClosed(said().refused[error.refusal]);
    return false;
  }
};

const savedRecords = async (id: string, token: string, recordsKey: string): Promise<void> => {
  const response = await asking(`/api/v1/cases/${id}/records`, undefined, token);
  const { sealed } = (await response.json()) as { sealed: string };
  const records = await openRecords(sealed, fromBase64Url(recordsKey));
  saved({ name: `folio-${id}-${said().recordsFile}.json` }, words(records));
};

const offerCaseTools = (id: string, { token, recordsKey }: CaseLink): void => {
  document.getElementById("edit-in-tisty")?.remove();
  document.querySelector(".actions-note")?.remove();
  const button = document.getElementById("report") as HTMLButtonElement;
  if (recordsKey === undefined) {
    button.remove();
    return;
  }
  button.textContent = said().downloadRecords;
  button.disabled = false;
  button.addEventListener("click", () => {
    savedRecords(id, token, recordsKey).catch(() => {
      button.textContent = said().couldNotBringRecords;
    });
  });
};

export const showCase = async (id: string, link: CaseLink): Promise<void> => {
  const answer = await askForCase(id, link.token);
  if ("refused" in answer) {
    drawClosed(answer.refused === "missing" ? said().caseGone : (notArrived(answer.refused) ?? said().couldNotArrive));
    return;
  }
  const linkKey = KEY_IN_WHAT_WAS_PASTED.exec(prompt(said().askingTheKey) ?? "")?.[0] ?? "";
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
    else drawClosed(notArrived(answer.refused) ?? said().couldNotArrive);
    return;
  }
  await opened(id, linkKey, answer);
};
