export interface Leaf {
  across: number;
  down: number;
  margin: number;
}

const TURN = "sheet-turn";
const HEADING = /^H[1-6]$/;

const bottomOf = (one: HTMLElement): number => one.offsetTop + one.offsetHeight;

const isBlock = (one: HTMLElement): boolean => one.offsetHeight > 0;

const floats = (one: Element): boolean => one.matches('blockquote[data-callout="idea"][data-side]');

const uncut = (sheet: HTMLElement): void => {
  for (const turn of sheet.querySelectorAll(`.${TURN}`)) turn.remove();
};

const turnBefore = (one: HTMLElement): HTMLElement => {
  const turn = document.createElement("div");
  turn.className = TURN;
  one.before(turn);
  return turn;
};

// From the top down, so a rule's old fill is replaced before anything under it is measured.
export const cut = (sheet: HTMLElement, { down, margin }: Leaf): void => {
  uncut(sheet);
  const room = down - 2 * margin - 1;
  let begins = margin;
  let ended = margin;
  let deepest = margin;
  let fresh = true;
  let heads: HTMLElement[] = [];
  let headsEnded = margin;
  let headsOpen = false;
  const beginUnder = (band: HTMLElement, from: number): void => {
    band.style.setProperty("--fill", `${Math.max(0, begins + room - from)}px`);
    begins = bottomOf(band) + margin;
    ended = begins;
    deepest = begins;
    fresh = true;
  };
  for (const one of [...sheet.children] as HTMLElement[]) {
    if (!isBlock(one)) continue;
    if (one.tagName === "HR") {
      beginUnder(one, ended);
      heads = [];
      continue;
    }
    if (!fresh && bottomOf(one) - begins > room) {
      const moving = headsOpen ? undefined : heads[0];
      beginUnder(turnBefore(moving ?? one), moving ? headsEnded : ended);
      if (moving) ended = bottomOf(heads.at(-1) as HTMLElement);
      else heads = [];
      headsOpen = true;
    }
    if (!HEADING.test(one.tagName)) heads = [];
    else if (heads.push(one) === 1) {
      headsEnded = ended;
      headsOpen = fresh;
    }
    fresh = one.className === "tags";
    deepest = Math.max(deepest, bottomOf(one));
    if (!floats(one)) ended = bottomOf(one);
  }
  sheet.style.setProperty("--last", `${Math.max(0, begins + room - Math.max(ended, deepest))}px`);
};

const keepingInSight = (sheet: HTMLElement, lay: () => void): void => {
  const first = [...sheet.children].find((one) => one.className !== TURN && one.getBoundingClientRect().bottom > 0);
  const top = first?.getBoundingClientRect().top ?? 0;
  lay();
  const moved = first ? first.getBoundingClientRect().top - top : 0;
  if (Math.abs(moved) >= 1) scrollBy({ top: moved, behavior: "instant" });
};

export const offerSheets = (sheet: HTMLElement): ((leaf?: Leaf | null) => void) => {
  let paper: Leaf | null = null;
  let laidAt = "";
  const size = (): string => `${sheet.offsetWidth} ${sheet.offsetHeight}`;
  const lay = (leaf = paper): void => {
    paper = leaf;
    const fitsItsPaper = leaf !== null && !sheet.hasAttribute("data-waiting") && sheet.offsetWidth === leaf.across;
    keepingInSight(sheet, () => {
      sheet.toggleAttribute("data-cut", fitsItsPaper);
      if (fitsItsPaper) cut(sheet, leaf);
      else uncut(sheet);
    });
    laidAt = size();
  };
  new ResizeObserver(() => {
    requestAnimationFrame(() => {
      if (size() !== laidAt) lay();
    });
  }).observe(sheet);
  return lay;
};
