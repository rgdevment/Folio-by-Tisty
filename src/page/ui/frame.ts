import type { Document, Orientation, Page, Paper, Verdict } from "@tisty/contracts";
import type { Standing } from "../../core/look-alike";
import { MAKER } from "../maker";
import { cardsFor, referenceOf } from "./cards";
import { bareUrl } from "./clean";
import { element } from "./element";
import { desktopOf, offerTisty, type Platform } from "./offer-tisty";
import { offerPrinting } from "./print";
import sheetStyles from "./sheet.css?url";
import { said, speak } from "./speak";

// From the sheet contract: what paper measures, in millimetres, and how it is worked out on screen.
const PAPER_MILLIMETRES: Record<Paper, [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4],
  folio: [215.9, 330.2],
  tabloid: [279.4, 431.8],
};
const MARGIN_MILLIMETRES = { x: 20, y: 22 };
const PIXELS_PER_INCH = 96;
const MILLIMETRES_PER_INCH = 25.4;
const LONG_PAGE_WIDTH_PIXELS = 820;

const pixels = (millimetres: number): number => Math.round((millimetres / MILLIMETRES_PER_INCH) * PIXELS_PER_INCH);

const DAY_MILLISECONDS = 86_400_000;

const TONES: Record<Verdict, string> = {
  holds: "good",
  retired: "warn",
  doubtful: "bad",
  refused: "bad",
  unreadable: "bad",
};

export interface Seal {
  verdict: Verdict;
  fingerprint: string;
  ownerFingerprint: string | null;
  signerStanding: Standing;
  ownerStanding: Standing;
  diesOn: number;
}

// Through the object model, since the page's policy lets no style be written into it.
const printOn = (across: number, down: number): void => {
  if (!("adoptedStyleSheets" in document)) return;
  const size = new CSSStyleSheet();
  size.replaceSync(`@page { size: ${across}mm ${down}mm; }`);
  document.adoptedStyleSheets = [size];
};

const withLayout = (host: HTMLElement, sheets: boolean, paper: Paper, orientation: Orientation): void => {
  const [short, long] = PAPER_MILLIMETRES[paper];
  const across = orientation === "landscape" ? long : short;
  const down = orientation === "landscape" ? short : long;
  host.dataset.sheets = String(sheets);
  printOn(across, down);
  // On the column, because the card of pages under the sheet keeps its width too.
  element("sheet-column").style.setProperty("--page-width", `${sheets ? pixels(across) : LONG_PAGE_WIDTH_PIXELS}px`);
  if (sheets) {
    host.style.setProperty("--page-height", `${pixels(down)}px`);
    host.style.setProperty("--margin-x", `${pixels(MARGIN_MILLIMETRES.x)}px`);
    host.style.setProperty("--margin-y", `${pixels(MARGIN_MILLIMETRES.y)}px`);
  }
};

const paperOf = (held: Document): Paper => {
  const said = held.sheet?.paper as Paper | undefined;
  return said && said in PAPER_MILLIMETRES ? said : "a4";
};

const pressed = (button: HTMLElement, on: boolean): void => button.setAttribute("aria-pressed", String(on));

const drawPaperPanel = (host: HTMLElement, held: Document): void => {
  const papers = element<HTMLFieldSetElement>("leaves");
  const leaves = [...papers.querySelectorAll<HTMLButtonElement>("button")];
  const sheets = element("sheets");
  const landscape = element("landscape");
  const ownPaper = paperOf(held);
  const ownAcross = held.sheet?.orientation === "landscape";
  let paper = ownPaper;
  let inSheets = held.sheet?.on === true;
  let across = ownAcross;
  const apply = (): void => {
    // Out of sheets these controls cannot be pressed, so printing must not follow a choice the reader can no longer see or undo.
    const paperNow = inSheets ? paper : ownPaper;
    const acrossNow = inSheets ? across : ownAcross;
    papers.disabled = !inSheets;
    for (const leaf of leaves) {
      pressed(leaf, leaf.dataset.paper === paperNow);
      // Tabloid is not offered, but a document that asked for it keeps it.
      if (leaf.dataset.paper === paperNow) leaf.hidden = false;
    }
    pressed(sheets, inSheets);
    pressed(landscape, acrossNow);
    landscape.hidden = !inSheets;
    withLayout(host, inSheets, paperNow, acrossNow ? "landscape" : "portrait");
  };
  for (const leaf of leaves) {
    leaf.addEventListener("click", () => {
      paper = leaf.dataset.paper as Paper;
      apply();
    });
  }
  sheets.addEventListener("click", () => {
    inSheets = !inSheets;
    apply();
  });
  landscape.addEventListener("click", () => {
    across = !across;
    apply();
  });
  apply();
};

// By hand and not with scrollIntoView, which would also move the page the reader is reading.
const centerInItsList = (button: HTMLElement): void => {
  const list = button.closest("ol");
  if (list) list.scrollTop = button.offsetTop - list.clientHeight / 2;
};

const headingsIn = (root: ShadowRoot): Element[] => [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")];

// The last heading past the limit. They go down the page in order, so a long page is asked about only a few of them.
const lastPast = (headings: Element[], limit: number): Element | undefined => {
  let low = 0;
  let high = headings.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((headings[middle] as Element).getBoundingClientRect().top <= limit) low = middle + 1;
    else high = middle;
  }
  return headings[low - 1];
};

// Marks the heading being read: the last one past the upper third of the window, or the last of all once at the end.
const followReading = (marks: Map<Element, HTMLElement>): AbortController => {
  const headings = [...marks.keys()];
  let marked: HTMLElement | undefined;
  const mark = (): void => {
    const atTheEnd = scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 1;
    const reached = atTheEnd ? headings.at(-1) : lastPast(headings, innerHeight / 3);
    const button = reached && marks.get(reached);
    if (button === marked) return;
    marked?.removeAttribute("aria-current");
    button?.setAttribute("aria-current", "location");
    if (button) centerInItsList(button);
    marked = button;
  };
  const stop = new AbortController();
  addEventListener("scroll", mark, { passive: true, signal: stop.signal });
  // A list shown by a wider window was hidden until now, so it has to find its place again.
  addEventListener(
    "resize",
    () => {
      mark();
      if (marked) centerInItsList(marked);
    },
    { signal: stop.signal },
  );
  // After the frame has drawn: until then the sheet is hidden, and every heading would seem already passed.
  requestAnimationFrame(mark);
  return stop;
};

const drawIndex = (root: ShadowRoot, held: Document | Page): AbortController => {
  const list = element("index");
  list.replaceChildren();
  // A new page starts at its top, so its list does too, wherever the last one had got to.
  list.scrollTop = 0;
  const marks = new Map<Element, HTMLElement>();
  const headings = headingsIn(root);
  // The title is already the first thing on the sheet, so the index starts after it.
  const shown = headings[0]?.textContent === held.title ? headings.slice(1) : headings;
  for (const heading of shown) {
    const item = document.createElement("li");
    item.dataset.level = heading.tagName.slice(1);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = heading.textContent;
    // Inside the document only, so an id in it can never lead to the page around it.
    button.addEventListener("click", () => {
      closePanel();
      heading.scrollIntoView({ block: "start" });
    });
    item.append(button);
    list.append(item);
    marks.set(heading, button);
  }
  const empty = list.childElementCount === 0;
  element("panel-index").hidden = empty;
  // On a phone its button would open a dimmed screen with nothing on it.
  for (const button of element("dock").querySelectorAll<HTMLElement>('[data-panel="panel-index"]')) {
    button.hidden = empty;
  }
  return followReading(marks);
};

// The arithmetic is frame.css's: it only needs what the panels measure, which no stylesheet can ask for.
const measurePanels = (): void => {
  const panels = element("panels");
  const list = element("index");
  new ResizeObserver(() => {
    const height = panels.getBoundingClientRect().height;
    panels.style.setProperty("--panels-height", `${height}px`);
    panels.style.setProperty("--panels-rest", `${height - list.getBoundingClientRect().height}px`);
  }).observe(panels);
};

const fact = (list: HTMLElement, name: string, value: string): void => {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = name;
  const said = document.createElement("dd");
  said.textContent = value;
  row.append(term, said);
  list.append(row);
};

const inPageLanguage = (moment: Date, options: Intl.DateTimeFormatOptions): string =>
  moment.toLocaleDateString(document.documentElement.lang, options);

const dayOf = (moment: string): string => inPageLanguage(new Date(moment), { dateStyle: "medium" });

const lastDay = (diesOn: number): string =>
  inPageLanguage(new Date(diesOn * DAY_MILLISECONDS), { dateStyle: "long", timeZone: "UTC" });

// What the sheet does not already say: the title and tags are on it, and the paper is in its own panel.
const SAID_ELSEWHERE = new Set(["title", "tags", "tag", "paper", "sheets", "orientation", "lang"]);

const drawDetails = (root: ShadowRoot, held: Document): void => {
  const list = element("details");
  list.replaceChildren();
  const { made, wrote } = said();
  if (held.made) fact(list, made, dayOf(held.made));
  if (held.wrote) fact(list, wrote, dayOf(held.wrote));
  // The properties travel hidden in the HTML, and a reader shows them here (contract, «text»).
  for (const name of root.querySelectorAll("dl.front > dt")) {
    const key = name.textContent ?? "";
    const value = name.nextElementSibling;
    if (!SAID_ELSEWHERE.has(key.toLowerCase()) && value?.tagName === "DD") fact(list, key, value.textContent ?? "");
  }
  list.hidden = list.childElementCount === 0;
};

const drawName = (who: "signer" | "owner", alias: string | undefined, standing: Standing): void => {
  const verified = standing === "verified";
  element(who).textContent = (verified ? MAKER?.name : alias) ?? said().noName;
  element(`${who}-verified`).hidden = !verified;
  const note = element(`${who}-note`);
  const notes: Record<Standing, string> = {
    verified: MAKER?.domain ?? "",
    imitates: said().anotherKey,
    takenBack: said().takenBack,
    plain: "",
  };
  note.textContent = notes[standing];
  note.hidden = note.textContent === "";
  note.classList.toggle("is-warning", !verified);
};

const drawOwner = (held: Document, { ownerFingerprint, ownerStanding }: Seal): void => {
  element("owner-facts").hidden = ownerFingerprint === null;
  drawName("owner", held.owner_name, ownerStanding);
  element("owner-fingerprint").textContent = ownerFingerprint ?? "";
};

const drawSeal = (held: Document, seal: Seal): void => {
  const { verdict, fingerprint, signerStanding, diesOn } = seal;
  const shown = element("seal");
  shown.hidden = false;
  shown.dataset.tone = TONES[verdict];
  element("seal-text").textContent = said().verdicts[verdict];
  drawName("signer", held.signed_as, signerStanding);
  element("fingerprint").textContent = fingerprint;
  drawOwner(held, seal);
  element("dies-on").textContent = lastDay(diesOn);
};

const drawActions = (): void => {
  const edit = element<HTMLAnchorElement>("edit-in-tisty");
  edit.href = `tisty://edit?link=${encodeURIComponent(location.href)}`;
  offerTisty(edit, desktopOf(navigator as Platform));
};

let opener: HTMLElement | null = null;

const closePanel = (): void => {
  for (const panel of document.querySelectorAll<HTMLElement>(".panel[data-open]")) delete panel.dataset.open;
  element("scrim").hidden = true;
  opener?.setAttribute("aria-expanded", "false");
  opener?.focus();
  opener = null;
};

const drawDock = (): void => {
  const dock = element("dock");
  dock.hidden = false;
  dock.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("button[data-panel]");
    if (!button?.dataset.panel) return;
    const panel = element(button.dataset.panel);
    const wasOpen = panel.dataset.open !== undefined;
    closePanel();
    if (wasOpen) return;
    panel.dataset.open = "";
    panel.tabIndex = -1;
    panel.focus();
    // Only now: a list that was hidden has no measures, so it could not follow the reading until it is shown.
    const reading = panel.querySelector<HTMLElement>('[aria-current="location"]');
    if (reading) centerInItsList(reading);
    opener = button;
    button.setAttribute("aria-expanded", "true");
    element("scrim").hidden = false;
  });
  element("scrim").addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });
};

const tagsOf = (tags: string[]): HTMLElement => {
  const list = document.createElement("p");
  list.className = "tags";
  for (const tag of tags) {
    const one = document.createElement("span");
    one.textContent = `#${tag}`;
    list.append(one);
  }
  return list;
};

// Nothing here changes the address by itself: the part after its # holds the link key (contract, «links»).
const followLink = (event: Event, root: ShadowRoot, held: Document, goTo: (page: Page) => void): void => {
  const link = (event.target as Element).closest("a");
  const where = bareUrl(link?.getAttribute("href") ?? "");
  if (!where || link?.getAttribute("target") === "_blank") return;
  event.preventDefault();
  if (where.startsWith("#")) {
    root.getElementById(where.slice(1))?.scrollIntoView({ block: "start" });
    return;
  }
  const reference = referenceOf(where);
  if (reference?.kind === "page") {
    const page = held.pages?.find((one) => one.at === reference.at);
    if (page) goTo(page);
  } else if (reference?.kind === "cited") {
    const cited = held.cited?.[reference.at];
    if (cited) location.assign(`/${encodeURIComponent(cited.document)}#${encodeURIComponent(cited.key ?? "")}`);
  }
};

const offerFiles = (root: ShadowRoot, pressFile: (link: HTMLElement) => void): void => {
  const fileAt = (event: Event) => (event.target as Element).closest<HTMLElement>("a[data-file]");
  root.addEventListener("click", (event) => {
    const link = fileAt(event);
    if (link) pressFile(link);
  });
  root.addEventListener("keydown", (event) => {
    const link = fileAt(event);
    const { key } = event as KeyboardEvent;
    if (!link || (key !== "Enter" && key !== " ")) return;
    event.preventDefault();
    pressFile(link);
  });
};

const nameOf = (shown: Document | Page): string => shown.title ?? said().untitled;

// At the end of the document and on a card of their own, as Tisty shows them.
const drawPages = (pages: Page[], goTo: (shown: Page) => void): void => {
  element("pages-card").hidden = pages.length === 0;
  element("pages-count").textContent = String(pages.length);
  const items = pages.map((shown) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = nameOf(shown);
    button.addEventListener("click", () => goTo(shown));
    item.append(button);
    return item;
  });
  element("pages").replaceChildren(...items);
};

const markPage = (at: number): void => {
  for (const [place, button] of element("pages").querySelectorAll("button").entries()) {
    if (place === at) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
};

// The way back to the document, in the bar so it is there however far down the page the reader goes.
const drawWayBack = (held: Document, at: number, total: number, goTo: (shown: Document) => void): void => {
  element("crumb").hidden = at < 0;
  if (at < 0) return;
  element("crumb-title").textContent = nameOf(held);
  element("crumb-at").textContent = said().pageOf(at + 1, total);
  element("crumb-back").onclick = () => goTo(held);
};

const sectionBeingRead = (root: ShadowRoot): number => {
  const headings = headingsIn(root);
  const reached = lastPast(headings, innerHeight / 3);
  return reached ? headings.indexOf(reached) : -1;
};

export interface Shown {
  held: Document;
  wordsOf: (html: string) => DocumentFragment;
  seal: Seal;
  pressFile?: (link: HTMLElement) => void;
}

// What it draws is already clean: `wordsOf` gives what the cleaner gave back, never the HTML as it arrived.
export const drawFrame = (first: Shown): ((next: Shown) => void) => {
  const host = element("sheet");
  // The sheet goes in a shadow root, which keeps its CSS, ids and classes apart in both directions.
  const root = host.attachShadow({ mode: "closed" });
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = sheetStyles;
  const sheet = document.createElement("article");
  sheet.className = "sheet";
  sheet.tabIndex = -1;
  root.append(styles, sheet);

  let { held, wordsOf, pressFile } = first;
  let pages: Page[] = [];
  let withCards: ReturnType<typeof cardsFor>;
  let reading: AbortController | undefined;
  let drawing: AbortController | undefined;
  let showing: Document | Page = held;
  const goTo = (shown: Document | Page): void => {
    showing = shown;
    sheet.lang = shown.lang ?? held.lang ?? "";
    drawing?.abort();
    drawing = new AbortController();
    const words = withCards(wordsOf(shown.html), drawing.signal);
    sheet.replaceChildren(...(shown.tags?.length ? [tagsOf(shown.tags)] : []), words);
    document.title = shown.title ? `${shown.title} · Folio` : "Folio by Tisty";
    const at = pages.indexOf(shown as Page);
    markPage(at);
    drawWayBack(held, at, pages.length, turnTo);
    reading?.abort();
    reading = drawIndex(root, shown);
    // At once: gliding back over a long page would only show everything the reader is leaving.
    scrollTo({ top: 0, behavior: "instant" });
  };
  // What the reader clicked is gone with the old words, so a keyboard goes on from the new ones.
  const turnTo = (shown: Document | Page): void => {
    goTo(shown);
    sheet.focus({ preventScroll: true });
  };
  root.addEventListener("click", (event) => followLink(event, root, held, turnTo));
  offerFiles(root, (link) => pressFile?.(link));

  const draw = (next: Shown, page = -1, section = -1): void => {
    ({ held, wordsOf, pressFile } = next);
    speak(held.lang);
    pages = held.pages ?? [];
    withCards = cardsFor(held, wordsOf);
    drawPages(pages, turnTo);
    goTo(held);
    drawDetails(root, held);
    drawSeal(held, next.seal);
    const samePlace = pages[page];
    if (samePlace) goTo(samePlace);
    headingsIn(root)[section]?.scrollIntoView({ block: "start" });
  };
  draw(first);
  const printedPage = (page: Document | Page, side: string, signal: AbortSignal): HTMLElement => {
    const printed = document.createElement("section");
    printed.className = `printed-page ${side}`;
    printed.lang = page.lang ?? held.lang ?? "";
    printed.append(...(page.tags?.length ? [tagsOf(page.tags)] : []), withCards(wordsOf(page.html), signal));
    return printed;
  };
  offerPrinting({
    button: element("print"),
    root,
    sheet,
    others: (signal) => {
      const all: (Document | Page)[] = [held, ...pages];
      const at = all.indexOf(showing);
      return {
        before: all.slice(0, at).map((page) => printedPage(page, "before", signal)),
        after: all.slice(at + 1).map((page) => printedPage(page, "after", signal)),
      };
    },
  });
  drawPaperPanel(host, held);
  drawActions();
  drawDock();
  measurePanels();
  element("loading").hidden = true;
  element("desk").hidden = false;
  document.body.dataset.state = "open";
  // As in Tisty, another language keeps the reader on the page in the same place and in the section with the same count.
  return (next) => draw(next, pages.indexOf(showing as Page), sectionBeingRead(root));
};
