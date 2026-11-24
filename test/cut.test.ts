import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cut, type Leaf, offerSheets } from "../src/page/ui/cut";

const LEAF: Leaf = { across: 794, down: 140, margin: 10 };
const ROOM = 119;
const BAND = 200;

interface Block {
  tag: string;
  top: number;
  tall: number;
  markup?: string;
}

let sheet: HTMLElement;
let grown: () => void;
let frames: (() => void)[];
let scrolled: { top: number }[];
let wide: number;

const bandsBefore = (one: Element): number => {
  let gap = 0;
  for (let at = one.previousElementSibling; at; at = at.previousElementSibling) {
    if (at.className === "sheet-turn") gap += BAND;
  }
  return gap;
};

const laid = (...blocks: Block[]): HTMLElement => {
  sheet.innerHTML = blocks
    .map(({ tag, markup = "" }) => (tag === "hr" ? "<hr>" : `<${tag}${markup}></${tag}>`))
    .join("");
  for (const [at, one] of [...sheet.children].entries()) {
    const { top, tall } = blocks[at] as Block;
    Object.defineProperty(one, "offsetTop", { get: () => top + bandsBefore(one) });
    Object.defineProperty(one, "offsetHeight", { value: tall });
    (one as HTMLElement).getBoundingClientRect = () =>
      ({ top: top + bandsBefore(one) - 50, bottom: top + bandsBefore(one) + tall - 50 }) as DOMRect;
  }
  return sheet;
};

const turns = (): HTMLElement[] => [...sheet.querySelectorAll<HTMLElement>(".sheet-turn")];
const fillOf = (one: Element | undefined): string | undefined =>
  (one as HTMLElement | undefined)?.style.getPropertyValue("--fill");
const p = (top: number, tall: number): Block => ({ tag: "p", top, tall });

beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><article class="sheet"></article>');
  sheet = window.document.querySelector(".sheet") as HTMLElement;
  wide = LEAF.across;
  Object.defineProperty(sheet, "offsetWidth", { get: () => wide });
  Object.defineProperty(sheet, "offsetHeight", { get: () => 100 + sheet.querySelectorAll("*").length });
  Object.defineProperty(window.HTMLElement.prototype, "offsetTop", { configurable: true, get: () => 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 0 });
  frames = [];
  scrolled = [];
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("scrollBy", (to: { top: number }) => scrolled.push(to));
  vi.stubGlobal("requestAnimationFrame", (draw: () => void) => frames.push(draw));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        grown = callback;
      }
      observe(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a sheet cut for its paper", () => {
  it("moves whole to the next sheet the block that does not fit", () => {
    laid(p(10, 40), p(60, 40), p(110, 40));
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(1);
    expect(turns()[0]?.nextElementSibling).toBe(sheet.children[3]);
    expect(fillOf(turns()[0])).toBe("29px");
  });

  it("fits a block to the last pixel of its room, and one pixel more it does not", () => {
    laid(p(10, 60), p(80, ROOM - 70));
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(0);
    laid(p(10, 60), p(80, ROOM - 69));
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(1);
  });

  it("cuts sooner under the bar of a title, whose three pixels more push the last block out", () => {
    const under = (border: number): Block[] => [{ tag: "h1", top: 10, tall: 24 + border }, p(50 + border, ROOM - 41)];
    laid(...under(1));
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(0);
    laid(...under(4));
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(1);
  });

  it("leaves where it starts a block taller than its paper, instead of a blank sheet before it", () => {
    laid({ tag: "table", top: 20, tall: 500 }, p(530, 40));
    cut(sheet, LEAF);
    expect(turns().map((one) => one.nextElementSibling?.tagName)).toEqual(["P"]);
  });

  it("takes what is hidden for no block", () => {
    laid({ tag: "dl", top: 10, tall: 0, markup: ' class="front"' }, { tag: "table", top: 10, tall: 500 });
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(0);
  });

  it("keeps the title with the tags Folio writes over it, which are no block of the document", () => {
    laid(
      { tag: "p", top: 10, tall: 20, markup: ' class="tags"' },
      { tag: "h1", top: 40, tall: 30 },
      { tag: "table", top: 80, tall: 500 },
    );
    cut(sheet, LEAF);
    expect(turns().map((one) => one.nextElementSibling?.tagName)).toEqual(["TABLE"]);
  });

  it("fills under a turn from where its sheet begins, though only a floated note stands on it", () => {
    laid(
      p(10, 100),
      { tag: "blockquote", top: 100, tall: 80, markup: ' data-callout="idea" data-side="right"' },
      { tag: "hr", top: 110, tall: 2 },
    );
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(1);
    expect(Number.parseInt(fillOf(sheet.lastElementChild ?? undefined) ?? "", 10)).toBe(ROOM);
  });

  it("takes for no block what has no measures, as a formula or a drawing left bare", () => {
    laid(p(10, 40), { tag: "hr", top: 60, tall: 50 }, p(130, 40));
    const bare = document.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
    sheet.children[0]?.after(bare);
    cut(sheet, LEAF);
    expect(fillOf(sheet.children[2])).toBe("79px");
    expect(sheet.style.getPropertyValue("--last")).toBe("69px");
  });

  it("takes along the headings right above the block that moves", () => {
    laid(p(10, 40), { tag: "h2", top: 60, tall: 30 }, { tag: "h3", top: 90, tall: 20 }, p(110, 40));
    cut(sheet, LEAF);
    expect(turns().map((one) => one.nextElementSibling?.tagName)).toEqual(["H2"]);
    expect(fillOf(turns()[0])).toBe("79px");
  });

  it("leaves where it is a heading that already opens its sheet", () => {
    laid({ tag: "h2", top: 10, tall: 30 }, p(50, 500));
    cut(sheet, LEAF);
    expect(turns().map((one) => one.nextElementSibling?.tagName)).toEqual(["P"]);
  });

  it("starts a sheet at every rule among the blocks", () => {
    laid(p(10, 40), { tag: "hr", top: 60, tall: 50 }, p(130, 40));
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(0);
    expect(fillOf(sheet.children[1])).toBe("79px");
    expect(sheet.style.getPropertyValue("--last")).toBe("69px");
  });

  it("fills from the blocks in the flow, while a floated note still ends the last sheet", () => {
    const note = ' data-callout="idea" data-side="right"';
    laid(
      p(10, 40),
      { tag: "blockquote", top: 50, tall: 80, markup: note },
      { tag: "hr", top: 52, tall: 2 },
      p(70, 20),
      { tag: "blockquote", top: 90, tall: 100, markup: note },
    );
    cut(sheet, { ...LEAF, down: 200 });
    expect(fillOf(sheet.children[2])).toBe("139px");
    expect(sheet.style.getPropertyValue("--last")).toBe("53px");
  });

  it("is cut again from nothing, never over its own turns", () => {
    laid(p(10, 40), p(60, 40), p(110, 40));
    cut(sheet, LEAF);
    cut(sheet, LEAF);
    expect(turns()).toHaveLength(1);
  });
});

describe("the sheets of a page", () => {
  const isCut = (): boolean => sheet.hasAttribute("data-cut");

  beforeEach(() => {
    laid(p(10, 40), p(60, 40), p(110, 40));
  });

  it("are none until it says it is in sheets, and none again when it leaves them", () => {
    const lay = offerSheets(sheet);
    lay();
    expect([isCut(), turns().length]).toEqual([false, 0]);
    lay(LEAF);
    expect([isCut(), turns().length]).toEqual([true, 1]);
    lay(null);
    expect([isCut(), turns().length]).toEqual([false, 0]);
  });

  it("are none where the window is narrower than the paper, until it has the room", () => {
    wide = 380;
    const lay = offerSheets(sheet);
    lay(LEAF);
    expect([isCut(), turns().length]).toEqual([false, 0]);
    wide = LEAF.across;
    grown();
    for (const draw of frames) draw();
    expect([isCut(), turns().length]).toEqual([true, 1]);
  });

  it("are laid again when a picture that arrives makes it grow, and only then", () => {
    offerSheets(sheet)(LEAF);
    const first = turns()[0];
    grown();
    for (const draw of frames) draw();
    expect(turns()[0]).toBe(first);
    laid(p(10, 40), p(60, 60), p(130, 40), p(180, 40));
    grown();
    for (const draw of frames) draw();
    expect(turns()[0]).not.toBe(first);
  });

  it("keep what is read under a turn where it was, though the turn itself goes", () => {
    const lay = offerSheets(sheet);
    lay(LEAF);
    const [turn] = turns();
    Object.defineProperty(turn, "getBoundingClientRect", { value: () => ({ top: 0, bottom: 50 }) });
    Object.defineProperty(sheet.children[0], "getBoundingClientRect", { value: () => ({ top: -90, bottom: -50 }) });
    Object.defineProperty(sheet.children[1], "getBoundingClientRect", { value: () => ({ top: -40, bottom: -1 }) });
    lay(null);
    expect(scrolled.at(-1)).toEqual({ top: -BAND, behavior: "instant" });
  });

  it("keep the block in sight where it was", () => {
    laid(p(0, 40), p(60, 100), p(170, 40));
    Object.defineProperty(sheet.children[0], "getBoundingClientRect", { value: () => ({ top: -50, bottom: -10 }) });
    offerSheets(sheet)(LEAF);
    expect(scrolled).toEqual([{ top: BAND, behavior: "instant" }]);
  });
});
