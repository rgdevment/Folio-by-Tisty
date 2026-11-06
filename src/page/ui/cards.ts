import type { Document, Page } from "@tisty/contracts";
import { bareUrl } from "./clean";
import { widgetDrawer } from "./widgets";

const REFERENCE = /^tisty:(page|cited)\/(\d+)$/i;
const SVG = "http://www.w3.org/2000/svg";
// The same drawings Tisty gives its cards.
const BOOK = [
  "M12 5v16",
  "M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z",
];
const LEAF = [
  "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
  "M14 2v5a1 1 0 0 0 1 1h5",
  "M16 13H8",
  "M16 17H8",
];
const GLIMPSE_CHARACTERS = 160;
const PRESS_TO_ASK = "Presiona para traerlo.";

const piece = (link: Element, kind: string, said = ""): HTMLElement => {
  const one = link.ownerDocument.createElement("span");
  one.className = kind;
  one.textContent = said;
  return one;
};

const glyph = (link: Element, paths: string[]): SVGElement => {
  const drawn = link.ownerDocument.createElementNS(SVG, "svg");
  drawn.setAttribute("class", "card-glyph");
  drawn.setAttribute("viewBox", "0 0 24 24");
  drawn.setAttribute("aria-hidden", "true");
  for (const shape of paths) {
    const path = link.ownerDocument.createElementNS(SVG, "path");
    path.setAttribute("d", shape);
    drawn.append(path);
  }
  return drawn;
};

const fill = (link: Element, name: string, under: string, paths: string[], chip: string): void => {
  const tile = piece(link, "card-tile");
  tile.append(glyph(link, paths));
  const meta = piece(link, "card-meta");
  meta.append(piece(link, "chip", chip), piece(link, "card-go", "›"));
  link.replaceChildren(tile, piece(link, "card-name", name), piece(link, "card-blurb", under), meta);
};

export const referenceOf = (href: string): { kind: "page" | "cited"; at: number } | undefined => {
  const [, kind, at] = REFERENCE.exec(bareUrl(href)) ?? [];
  return kind ? { kind: kind.toLowerCase() as "page" | "cited", at: Number(at) } : undefined;
};

const BLOCKS = "p, li, blockquote";

// Only the innermost blocks, so a paragraph inside a quote is not said twice, and whole characters, so no emoji is cut.
const glimpsed = (words: DocumentFragment, title: string | undefined): string => {
  const said = [...words.querySelectorAll(BLOCKS)]
    .filter((one) => !one.querySelector(BLOCKS))
    .map((one) => one.textContent?.trim())
    .filter(Boolean);
  // A title can be the first paragraph (contract, «title»), and the card already says it.
  const told = said[0] === title?.trim() ? said.slice(1) : said;
  return [...told.join(" · ")].slice(0, GLIMPSE_CHARACTERS).join("");
};

// A card alone in its paragraph is drawn whole, and one inside a sentence stays a word of it, as Tisty does.
const standsAlone = (link: Element, words: DocumentFragment): boolean => {
  const paragraph = link.parentElement;
  return (
    paragraph?.parentNode === words &&
    paragraph.children.length === 1 &&
    paragraph.textContent?.trim() === link.textContent?.trim()
  );
};

const drawFiles = (words: DocumentFragment, held: Document): void => {
  for (const link of words.querySelectorAll("a[data-file]")) {
    const file = held.files?.find((one) => one.at === Number(link.getAttribute("data-file")));
    link.setAttribute("title", PRESS_TO_ASK);
    if (!file || !link.matches("p > a.card") || !standsAlone(link, words)) continue;
    fill(link, file.name, PRESS_TO_ASK, LEAF, "Adjunto");
    link.classList.add("doc-card");
  }
};

// What it writes comes from the document that was already checked, always as words and never as HTML.
export const cardsFor = (held: Document, wordsOf: (html: string) => DocumentFragment) => {
  const pages: Page[] = held.pages ?? [];
  // A page is cleaned once for its card, however many times the reader comes back to the words that name it.
  const glimpses = new Map<Page, string>();
  const glimpseOf = (page: Page): string => {
    const known = glimpses.get(page) ?? glimpsed(wordsOf(page.html), page.title);
    glimpses.set(page, known);
    return known;
  };

  const drawWidgets = widgetDrawer();

  return (words: DocumentFragment, signal: AbortSignal): DocumentFragment => {
    drawWidgets(words, signal);
    drawFiles(words, held);
    for (const link of words.querySelectorAll("p > a.card")) {
      if (!standsAlone(link, words)) continue;
      const reference = referenceOf(link.getAttribute("href") ?? "");
      const said = link.textContent ?? "";
      if (reference?.kind === "page") {
        const page = pages.find((one) => one.at === reference.at);
        if (!page) continue;
        const chip = `Página ${pages.indexOf(page) + 1} de ${pages.length}`;
        fill(link, page.title ?? said, glimpseOf(page), BOOK, chip);
        link.classList.add("doc-card", "is-page");
      } else if (reference?.kind === "cited") {
        const cited = held.cited?.[reference.at];
        if (!cited) continue;
        fill(link, cited.title ?? said, "", LEAF, "Documento");
        link.classList.add("doc-card");
      }
    }
    return words;
  };
};
