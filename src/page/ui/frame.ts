import type { Document, Orientation, Page, Paper, Verdict } from "@tisty/contracts";
import { readingLink } from "../link";
import { cardsFor, referenceOf } from "./cards";
import { bareUrl } from "./clean";
import sheetStyles from "./sheet.css?url";

export const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found as T;
};

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

const VERDICTS: Record<Verdict, { text: string; tone: string }> = {
  holds: { text: "Firma válida", tone: "good" },
  retired: { text: "Firma de una llave retirada después", tone: "warn" },
  doubtful: { text: "Firma dudosa: la llave estaba retirada", tone: "bad" },
  refused: { text: "La firma no vale", tone: "bad" },
  unreadable: { text: "No se pudo leer la firma", tone: "bad" },
};

export interface Seal {
  verdict: Verdict;
  fingerprint: string;
  ownerFingerprint: string | null;
  diesOn: string;
}

const withLayout = (host: HTMLElement, sheets: boolean, paper: Paper, orientation: Orientation): void => {
  const [short, long] = PAPER_MILLIMETRES[paper];
  const across = orientation === "landscape" ? long : short;
  const down = orientation === "landscape" ? short : long;
  host.dataset.sheets = String(sheets);
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
  const leaves = [...element("leaves").querySelectorAll<HTMLButtonElement>("button")];
  const sheets = element("sheets");
  const landscape = element("landscape");
  let paper = paperOf(held);
  let inSheets = held.sheet?.on === true;
  let across = held.sheet?.orientation === "landscape";
  const apply = (): void => {
    for (const leaf of leaves) {
      pressed(leaf, leaf.dataset.paper === paper);
      // Tabloid is not offered, but a document that asked for it keeps it.
      if (leaf.dataset.paper === paper) leaf.hidden = false;
    }
    pressed(sheets, inSheets);
    pressed(landscape, across);
    landscape.hidden = !inSheets;
    withLayout(host, inSheets, paper, across ? "landscape" : "portrait");
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
  const headings = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
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

const dayOf = (moment: string): string => new Date(moment).toLocaleDateString(undefined, { dateStyle: "medium" });

// What the sheet does not already say: the title and tags are on it, and the paper is in its own panel.
const SAID_ELSEWHERE = new Set(["title", "tags", "tag", "paper", "sheets", "orientation", "lang"]);

const drawDetails = (root: ShadowRoot, held: Document): void => {
  const list = element("details");
  if (held.made) fact(list, "Creado", dayOf(held.made));
  if (held.wrote) fact(list, "Editado", dayOf(held.wrote));
  // The properties travel hidden in the HTML, and a reader shows them here (contract, «text»).
  for (const name of root.querySelectorAll("dl.front > dt")) {
    const key = name.textContent ?? "";
    const value = name.nextElementSibling;
    if (!SAID_ELSEWHERE.has(key.toLowerCase()) && value?.tagName === "DD") fact(list, key, value.textContent ?? "");
  }
  list.hidden = list.childElementCount === 0;
};

const drawOwner = (held: Document, ownerFingerprint: string | null): void => {
  element("owner-facts").hidden = ownerFingerprint === null;
  element("owner").textContent = held.owner_name ?? "Sin nombre";
  element("owner-fingerprint").textContent = ownerFingerprint ?? "";
};

const drawSeal = (held: Document, { verdict, fingerprint, ownerFingerprint, diesOn }: Seal): void => {
  const { text, tone } = VERDICTS[verdict];
  const seal = element("seal");
  seal.hidden = false;
  seal.dataset.tone = tone;
  element("seal-text").textContent = text;
  element("signer").textContent = held.signed_as ?? "Sin nombre";
  element("fingerprint").textContent = fingerprint;
  drawOwner(held, ownerFingerprint);
  element("dies-on").textContent = diesOn;
};

// A browser never says whether Tisty is installed, so every click also offers it, until the app takes the focus away.
const offerTisty = (edit: HTMLElement): void => {
  const notice = element("opening-tisty");
  let leftForTheApp = false;
  const close = (): void => {
    notice.hidden = true;
    leftForTheApp = false;
  };
  edit.addEventListener("click", () => {
    leftForTheApp = false;
    notice.hidden = false;
  });
  element("opening-tisty-close").addEventListener("click", close);
  addEventListener("blur", () => {
    leftForTheApp = !notice.hidden;
  });
  // Closed on coming back and not on leaving, because a system's own question also takes the focus and the reader still needs this.
  addEventListener("focus", () => {
    if (leftForTheApp) close();
  });
};

const drawActions = (): void => {
  const edit = element<HTMLAnchorElement>("edit-in-tisty");
  edit.href = `tisty://edit?link=${encodeURIComponent(location.href)}`;
  offerTisty(edit);
  const label = element("copy-link-text");
  const said = label.textContent;
  element("copy-link").addEventListener("click", async () => {
    await navigator.clipboard.writeText(readingLink(location));
    label.textContent = "Copiado";
    setTimeout(() => {
      label.textContent = said;
    }, 1500);
  });
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

const nameOf = (shown: Document | Page): string => shown.title ?? "Sin título";

// At the end of the document and on a card of their own, as Tisty shows them.
const drawPages = (pages: Page[], goTo: (shown: Page) => void): void => {
  if (pages.length === 0) return;
  element("pages-card").hidden = false;
  element("pages-count").textContent = String(pages.length);
  const list = element("pages");
  for (const shown of pages) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = nameOf(shown);
    button.addEventListener("click", () => goTo(shown));
    item.append(button);
    list.append(item);
  }
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
  element("crumb-at").textContent = `${at + 1} de ${total}`;
  element("crumb-back").onclick = () => goTo(held);
};

// What it draws is already clean: `wordsOf` gives what the cleaner gave back, never the HTML as it arrived.
export const drawFrame = (
  held: Document,
  wordsOf: (html: string) => DocumentFragment,
  seal: Seal,
  pressFile?: (link: HTMLElement) => void,
): void => {
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

  const pages = held.pages ?? [];
  const withCards = cardsFor(held, wordsOf);
  let reading: AbortController | undefined;
  let drawing: AbortController | undefined;
  const goTo = (shown: Document | Page): void => {
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
  if (pressFile) offerFiles(root, pressFile);

  drawPages(pages, turnTo);
  goTo(held);
  drawPaperPanel(host, held);
  drawDetails(root, held);
  drawSeal(held, seal);
  drawActions();
  drawDock();
  measurePanels();
  element("loading").hidden = true;
  element("desk").hidden = false;
  document.body.dataset.state = "open";
};
