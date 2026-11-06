export interface Printing {
  button: HTMLElement;
  root: ShadowRoot;
  sheet: HTMLElement;
  others: (signal: AbortSignal) => { before: HTMLElement[]; after: HTMLElement[] };
}

// Before the browser is asked: it takes the address it prints on every sheet ahead of beforeprint.
const withoutKey = (): (() => void) => {
  const { href, hash, pathname, search } = window.location;
  if (hash) window.history.replaceState(window.history.state, "", `${pathname}${search}`);
  return () => window.history.replaceState(window.history.state, "", href);
};

const withOthers = ({ sheet, others }: Printing): (() => void) => {
  const drawing = new AbortController();
  const { before, after } = others(drawing.signal);
  sheet.prepend(...before);
  sheet.append(...after);
  return () => {
    drawing.abort();
    for (const page of [...before, ...after]) page.remove();
  };
};

const withFoldsOpen = ({ root }: Printing): (() => void) => {
  const closed = [...root.querySelectorAll("details:not([open])")];
  for (const fold of closed) fold.setAttribute("open", "");
  return () => {
    for (const fold of closed) fold.removeAttribute("open");
  };
};

const asksToPrint = ({ ctrlKey, metaKey, key }: KeyboardEvent): boolean => (ctrlKey || metaKey) && /^p$/i.test(key);

export const offerPrinting = (printing: Printing): void => {
  const { button } = printing;
  if (typeof window.print !== "function") {
    button.hidden = true;
    return;
  }
  let undo: (() => void)[] = [];
  const prepare = (): void => {
    if (undo.length > 0) return;
    undo = [withoutKey(), withOthers(printing), withFoldsOpen(printing)];
  };
  const restore = (): void => {
    for (const step of undo) step();
    undo = [];
  };
  const printNow = (): void => {
    prepare();
    window.print();
  };
  window.addEventListener("beforeprint", prepare);
  window.addEventListener("afterprint", restore);
  window.addEventListener("pointerdown", restore);
  window.addEventListener("keydown", (event) => {
    if (!asksToPrint(event)) {
      restore();
      return;
    }
    event.preventDefault();
    printNow();
  });
  button.addEventListener("click", printNow);
};
