import { checkWidget, strayInWidget, WIDGET, widgetPage } from "@tisty/contracts/check";

// The page's own policy would strip a srcdoc of its styles, so the frame gets a page served under the widget's policy.
const EMPTY_PAGE = "/widget-frame";
const SHORTEST = 40;
const TALLEST = 2400;
const WRONG_SHOWN_AT_MOST = 3;
const WRONG_SHOWN_CHARACTERS = 60;

const NOT_A_WIDGET = "Este bloque no es un widget y por eso se muestra como código: ";
const ONLY_HTML_AND_CSS = "Un widget es solo HTML y CSS, sin nada que se ejecute ni venga de afuera.";
const TOO_BIG = `Un widget puede tener hasta ${Math.round(WIDGET.bytes / 1000)} KB; este pasa de ahí, así que se muestra como código.`;
const COULD_NOT_DRAW =
  "No se pudo dibujar este widget, así que se muestra como código. Recarga la página para volver a intentarlo.";

const shortened = (said: string): string =>
  said.length > WRONG_SHOWN_CHARACTERS ? `${said.slice(0, WRONG_SHOWN_CHARACTERS)}…` : said;

const whyNotDrawn = (source: string): string | null => {
  if (new TextEncoder().encode(source).length > WIDGET.bytes) return TOO_BIG;
  const wrong = [...new Set([...checkWidget(source), ...strayInWidget(source)])];
  if (wrong.length === 0) return null;
  return `${NOT_A_WIDGET}${wrong.slice(0, WRONG_SHOWN_AT_MOST).map(shortened).join(", ")}. ${ONLY_HTML_AND_CSS}`;
};

const sizing = (frame: HTMLIFrameElement, box: Element) => {
  const measured = (): number => Math.max(box.scrollHeight, box.getBoundingClientRect().height);
  let chasing = false;
  return (): void => {
    if (chasing) return;
    const height = Math.min(TALLEST, Math.max(SHORTEST, Math.ceil(measured())));
    frame.style.height = `${height}px`;
    // What grows with its frame would chase it to the top, so it keeps this height and scrolls inside.
    chasing = height < TALLEST && measured() > height;
  };
};

const inTheme = (frame: HTMLIFrameElement, inside: globalThis.Document, dark: boolean): void => {
  inside.documentElement.classList.toggle("dark", dark);
  frame.style.colorScheme = dark ? "dark" : "light";
};

const followTheme = (
  frame: HTMLIFrameElement,
  inside: globalThis.Document,
  host: HTMLElement,
  signal: AbortSignal,
): void => {
  const asShown = (): void => inTheme(frame, inside, host.dataset.theme === "dark");
  const themes = new MutationObserver(asShown);
  themes.observe(host, { attributes: true, attributeFilter: ["data-theme"] });
  signal.addEventListener("abort", () => themes.disconnect(), { once: true });
  const place = frame.ownerDocument.defaultView;
  place?.addEventListener("beforeprint", () => inTheme(frame, inside, false), { signal });
  place?.addEventListener("afterprint", asShown, { signal });
};

const written = (frame: HTMLIFrameElement, source: string, signal: AbortSignal): boolean => {
  const inside = frame.contentDocument;
  if (!inside) return false;
  const host = (frame.getRootNode() as ShadowRoot).host as HTMLElement;
  const dark = host.dataset.theme === "dark";
  inside.open();
  inside.write(widgetPage(source, dark));
  inside.close();
  const box = inside.querySelector("main.w");
  // A style the frame's policy refused has no sheet: that is the page's policy, so its address did not serve its own.
  if (!box || !inside.querySelector("style")?.sheet) return false;
  inTheme(frame, inside, dark);
  followTheme(frame, inside, host, signal);
  const sizes = new ResizeObserver(sizing(frame, box));
  sizes.observe(box);
  signal.addEventListener("abort", () => sizes.disconnect(), { once: true });
  return true;
};

const framed = (
  page: globalThis.Document,
  name: string,
  source: string,
  signal: AbortSignal,
  onFailure: () => void,
): HTMLIFrameElement => {
  const frame = page.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = name || "Widget";
  frame.style.height = `${SHORTEST}px`;
  frame.addEventListener(
    "load",
    () => {
      if (!written(frame, source, signal)) onFailure();
    },
    { once: true },
  );
  frame.src = EMPTY_PAGE;
  return frame;
};

const saying = (page: globalThis.Document, said: string): HTMLElement => {
  const note = page.createElement("p");
  note.className = "widget-said";
  note.textContent = said;
  return note;
};

export const widgetDrawer = () => {
  const verdicts = new Map<string, string | null>();
  const verdictOn = (source: string): string | null => {
    const known = verdicts.get(source);
    if (known !== undefined) return known;
    const verdict = whyNotDrawn(source);
    verdicts.set(source, verdict);
    return verdict;
  };

  return (words: DocumentFragment, signal: AbortSignal): void => {
    for (const code of words.querySelectorAll("figure.code > pre > code.language-widget")) {
      const source = code.textContent ?? "";
      const figure = code.closest("figure") as Element;
      const page = figure.ownerDocument;
      const why = verdictOn(source);
      if (why) {
        figure.before(saying(page, why));
        continue;
      }
      const name = figure.querySelector("figcaption")?.textContent?.trim() ?? "";
      const drawn = page.createElement("figure");
      drawn.className = "widget";
      if (name) {
        const caption = page.createElement("figcaption");
        caption.textContent = name;
        drawn.append(caption);
      }
      drawn.append(framed(page, name, source, signal, () => drawn.replaceWith(saying(page, COULD_NOT_DRAW), figure)));
      figure.replaceWith(drawn);
    }
  };
};
