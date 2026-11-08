import { readFileSync } from "node:fs";
import type { Document, Page } from "@tisty/contracts";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domPurifyCleaner } from "../src/page/ui/clean";
import { finished } from "../src/page/ui/finish";
import { drawFrame, type Seal } from "../src/page/ui/frame";

const SEAL = { verdict: "holds", fingerprint: "1", ownerFingerprint: null, diesOn: "mañana" } as const;
const ADDRESS = "https://tisty.cl/k7Qm2xPa#THEKEY";

const ENERO: Page = {
  id: "p1",
  page_of: "k7Qm2xPa",
  at: 1,
  title: "Enero",
  html: '<h1 id="enero">Enero</h1>',
  body: "",
};

const HELD: Document = {
  id: "k7Qm2xPa",
  title: "Paseos",
  body: "",
  html: [
    '<h1 id="paseos">Paseos</h1>',
    '<p><a href="#rio">río</a> <a href="tisty:page/1">Enero</a></p>',
    '<p><a href="tisty:cited/0">otro</a> <a href="tisty:file/0">adjunto</a></p>',
    '<p>En la <a href="https://www.tisty.app/">web</a> de Tisty.</p>',
    '<h2 id="rio">Río</h2>',
  ].join(""),
  pages: [ENERO],
  cited: [{ document: "wordsOnly", key: "CITEDKEY" }],
};

let root: ShadowRoot;
let scrolled: Element[];
let assign: ReturnType<typeof vi.fn>;
let place: Window & typeof globalThis;

const linkSaying = (words: string): Element | undefined =>
  [...root.querySelectorAll("a")].find((one) => one.textContent === words);

const click = (words: string): boolean => {
  const event = new place.MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
  // Read as it reaches the page, and stopped there: jsdom cannot follow a link anyway.
  let prevented = false;
  place.document.addEventListener(
    "click",
    (seen: Event) => {
      prevented = seen.defaultPrevented;
      seen.preventDefault();
    },
    { once: true },
  );
  linkSaying(words)?.dispatchEvent(event);
  return prevented;
};

const draw = (held: Document): void => {
  const cleaner = domPurifyCleaner(place);
  drawFrame({ held, wordsOf: (html) => finished(cleaner.clean(html), []), seal: SEAL });
};

beforeEach(() => {
  const dom = new JSDOM(readFileSync("src/page/index.html", "utf8"), { url: ADDRESS });
  place = dom.window;
  scrolled = [];
  assign = vi.fn();
  const attach = place.Element.prototype.attachShadow;
  place.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    root = attach.call(this, init);
    return root;
  };
  place.Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal("window", place);
  vi.stubGlobal("window", place);
  vi.stubGlobal("document", place.document);
  vi.stubGlobal("DOMParser", place.DOMParser);
  vi.stubGlobal("MutationObserver", place.MutationObserver);
  vi.stubGlobal("AbortController", place.AbortController);
  vi.stubGlobal("location", { href: ADDRESS, hash: "#THEKEY", assign });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a click on what the sheet links to", () => {
  it("moves to a heading without touching the address, since what follows its # is the key", () => {
    draw(HELD);
    expect(click("río")).toBe(true);
    expect(scrolled.map((one) => one.id)).toEqual(["rio"]);
    expect(place.location.href).toBe(ADDRESS);
    expect(assign).not.toHaveBeenCalled();
  });

  it("turns to a page, and marks it", () => {
    draw(HELD);
    expect(click("Enero")).toBe(true);
    expect(place.document.title).toBe("Enero · Folio");
    expect(root.querySelector("h1")?.id).toBe("enero");
    const marks = [...place.document.querySelectorAll("#pages button")].map((one) => one.getAttribute("aria-current"));
    expect(marks).toEqual(["page"]);
    expect(place.location.href).toBe(ADDRESS);
  });

  it("shows the way back above a page, and none above the document", () => {
    const crumb = () => place.document.getElementById("crumb");
    draw(HELD);
    expect(crumb()?.hidden).toBe(true);
    click("Enero");
    expect(crumb()?.hidden).toBe(false);
    expect(place.document.getElementById("crumb-at")?.textContent).toBe("1 de 1");
    place.document.getElementById("crumb-back")?.click();
    expect(crumb()?.hidden).toBe(true);
    expect(place.document.title).toBe(`${HELD.title} · Folio`);
  });

  it("goes to what is cited, with its own key", () => {
    draw(HELD);
    expect(click("otro")).toBe(true);
    expect(assign).toHaveBeenCalledWith("/wordsOnly#CITEDKEY");
  });

  it("does nothing with a file, which no longer looks like a link", () => {
    draw(HELD);
    expect(linkSaying("adjunto")?.hasAttribute("href")).toBe(false);
    expect(click("adjunto")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("leaves what goes elsewhere to the browser, in another tab", () => {
    draw(HELD);
    expect(click("web")).toBe(false);
    expect(linkSaying("web")?.getAttribute("target")).toBe("_blank");
  });
});

describe("where a link goes", () => {
  const whereOf = (html: string): string | null => {
    const cleaner = domPurifyCleaner(place);
    const words = finished(cleaner.clean(html), []);
    return words.querySelector(".link-where")?.textContent ?? null;
  };

  it.each([
    ["other words", '<a href="https://evil.example/x">tu banco</a>', " (evil.example)"],
    ["another address in its words", '<a href="https://evil.example/">banco.cl</a>', " (evil.example)"],
    ["a name before an at sign", '<a href="https://banco.cl@evil.example/">https://banco.cl</a>', " (evil.example)"],
    [
      "its address as part of another",
      '<a href="https://banco.cl.evil.example/">banco.cl</a>',
      " (banco.cl.evil.example)",
    ],
    ["look-alike letters", '<a href="https://xn--bnco-53d.cl/">b\u0430nco.cl</a>', " (xn--bnco-53d.cl)"],
    ["its address among other words", '<a href="https://evil.example/">mira evil.example ahora</a>', " (evil.example)"],
    [
      "a mail to someone else",
      '<a href="mailto:a@evil.example?subject=x">escríbenos</a>',
      " (a@evil.example?subject=x)",
    ],
    [
      "a mail to its own words carrying hidden copies",
      '<a href="mailto:a@b.example?bcc=c@evil.example">a@b.example</a>',
      " (a@b.example?bcc=c@evil.example)",
    ],
    [
      "a name before an at sign in its own words",
      '<a href="https://banco.cl@evil.example/">https://banco.cl@evil.example/</a>',
      " (evil.example)",
    ],
    [
      "words a reader may not see",
      '<a href="https://evil.example/"><math><mtext style="font-size:0">https://evil.example/</mtext></math>banco.cl</a>',
      " (evil.example)",
    ],
  ])("shows it for %s", (_, html, shown) => {
    expect(whereOf(html)).toBe(shown);
  });

  it.each([
    ["its own host", '<a href="https://tisty.app/x">tisty.app</a>'],
    ["its own address", '<a href="https://tisty.app/x">https://tisty.app/x</a>'],
    ["www or not", '<a href="https://www.tisty.app/">tisty.app</a>'],
    ["capitals", '<a href="https://tisty.app/">Tisty.App</a>'],
    ["a mail to that address", '<a href="mailto:a@b.example">A@b.example</a>'],
    ["what stays in the document", '<a href="tisty:file/0">x</a>'],
  ])("does not repeat it with %s", (_, html) => {
    expect(whereOf(html)).toBeNull();
  });

  it("shows it beside a drawing, where a link inside it would hide it", () => {
    const words = finished(
      domPurifyCleaner(place).clean('<svg><a href="https://evil.example/"><text>banco.cl</text></a></svg>'),
      [],
    );
    const shown = words.querySelector(".link-where");
    expect(shown?.textContent).toBe(" (evil.example)");
    expect(shown?.previousElementSibling?.localName).toBe("svg");
  });

  it("is written as words, never as markup", () => {
    const words = finished(domPurifyCleaner(place).clean('<a href="mailto:&lt;img src=x&gt;@e.example">x</a>'), []);
    expect(words.querySelector(".link-where img")).toBeNull();
    expect(words.querySelector(".link-where")?.textContent).toContain("<img");
  });
});

describe("a web link alone in its paragraph", () => {
  const cardOf = (html: string) => {
    draw({ ...HELD, html });
    return root.querySelector("a.doc-card.is-web");
  };

  it("becomes a card of its site that says where it goes, and still leaves in another tab", () => {
    const card = cardOf('<p><a href="https://www.github.com/rgdevment/Tisty/">Tisty en GitHub</a></p>');
    expect(card?.querySelector(".card-name")?.textContent).toBe("Tisty en GitHub");
    expect(card?.querySelector(".card-blurb")?.textContent).toBe("github.com/rgdevment/Tisty");
    expect(card?.querySelector(".chip")?.textContent).toBe("github.com");
    expect(card?.querySelector(".card-tile")?.textContent).toBe("G");
    expect(card?.getAttribute("target")).toBe("_blank");
    expect(card?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(root.querySelector(".link-where")).toBeNull();
  });

  it("names itself by its address when its words are the address", () => {
    const card = cardOf('<p><a href="https://tisty.app/guia">https://tisty.app/guia</a></p>');
    expect(card?.querySelector(".card-name")?.textContent).toBe("tisty.app/guia");
  });

  it("shows the real site whatever its words say", () => {
    const card = cardOf('<p><a href="https://evil.example/login">banco.cl</a></p>');
    expect(card?.querySelector(".card-name")?.textContent).toBe("banco.cl");
    expect(card?.querySelector(".chip")?.textContent).toBe("evil.example");
    expect(card?.querySelector(".card-blurb")?.textContent).toBe("evil.example/login");
  });

  it.each([
    ["inside a sentence", '<p>Mira <a href="https://tisty.app/">tisty.app</a> ahora.</p>'],
    ["with more than words inside", '<p><a href="https://tisty.app/"><b>tisty</b></a></p>'],
    ["to a mail", '<p><a href="mailto:a@b.example">a@b.example</a></p>'],
  ])("stays a link %s", (_, html) => {
    expect(cardOf(html)).toBeNull();
  });
});

describe("a card in the words", () => {
  const withWords = (html: string): Document => ({
    ...HELD,
    html,
    pages: [{ ...ENERO, html: "<h1>Enero</h1><p>Un mes tranquilo.</p><p><b>Dos</b> frases.</p>" }],
  });

  it("is drawn whole when alone in its paragraph, and still turns to its page", () => {
    draw(withWords('<p><a class="card" href="tisty:page/1">Enero</a></p>'));
    const card = root.querySelector("a.doc-card.is-page");
    expect(card?.querySelector(".card-name")?.textContent).toBe("Enero");
    expect(card?.querySelector(".card-blurb")?.textContent).toBe("Un mes tranquilo. · Dos frases.");
    expect(card?.querySelector(".chip")?.textContent).toBe("Página 1 de 1");
    card
      ?.querySelector(".card-name")
      ?.dispatchEvent(new place.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
    expect(place.document.title).toBe("Enero · Folio");
  });

  it("stays a word of the sentence it sits in", () => {
    draw(withWords('<p>Mira <a class="card" href="tisty:page/1">Enero</a> ahí.</p>'));
    expect(root.querySelector("a.doc-card")).toBeNull();
    expect(root.querySelector("a.card")?.textContent).toBe("Enero");
  });

  it("names a document shared along by its title", () => {
    const shared: Document = {
      ...withWords('<p><a class="card" href="tisty:cited/0">Otro</a></p>'),
      cited: [{ document: "wordsOnly", key: "CITEDKEY", title: "Sobre el río" }],
    };
    draw(shared);
    expect(root.querySelector("a.doc-card .card-name")?.textContent).toBe("Sobre el río");
    expect(root.querySelector("a.doc-card .chip")?.textContent).toBe("Abre otro documento");
  });

  it("is not drawn for a document that did not come along, which it could not open", () => {
    draw(withWords('<p><a class="card" href="tisty:cited/5">Otro</a></p>'));
    expect(root.querySelector("a.doc-card")).toBeNull();
  });

  const withPageWords = (html: string): Document => ({
    ...withWords('<p><a class="card" href="tisty:page/1">Enero</a></p>'),
    pages: [{ ...ENERO, html }],
  });

  it("says each thing once in its summary", () => {
    draw(withPageWords("<h1>Enero</h1><blockquote><p>Ojo</p></blockquote><ul><li><p>Uno</p></li></ul>"));
    expect(root.querySelector(".card-blurb")?.textContent).toBe("Ojo · Uno");
  });

  it("does not repeat a title that is the page's first paragraph", () => {
    draw(withPageWords("<p>Enero</p><p>Un mes tranquilo.</p>"));
    expect(root.querySelector(".card-blurb")?.textContent).toBe("Un mes tranquilo.");
  });

  it("cuts no character in half when the summary runs long", () => {
    draw(withPageWords(`<p>${"a".repeat(159)}😀b</p>`));
    expect(root.querySelector(".card-blurb")?.textContent).toBe(`${"a".repeat(159)}😀`);
  });

  it("cleans a page once for its card, however many times the reader comes back", () => {
    const cleaner = domPurifyCleaner(place);
    const wordsOf = vi.fn((html: string) => finished(cleaner.clean(html), []));
    drawFrame({ held: withWords('<p><a class="card" href="tisty:page/1">Enero</a></p>'), wordsOf, seal: SEAL });
    const cleanedOfEnero = () => wordsOf.mock.calls.filter(([html]) => html.includes("tranquilo")).length;
    expect(cleanedOfEnero()).toBe(1);
    root.querySelector<HTMLElement>("a.doc-card")?.click();
    expect(cleanedOfEnero()).toBe(2);
    place.document.getElementById("crumb-back")?.click();
    expect(cleanedOfEnero()).toBe(2);
  });

  it("writes a title as words, never as HTML", () => {
    const hostile = withWords('<p><a class="card" href="tisty:page/1">Enero</a></p>');
    draw({ ...hostile, pages: [{ ...ENERO, title: "<img src=x onerror=alert(1)>" }] });
    expect(root.querySelector(".card-name")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(root.querySelector(".card-name img")).toBeNull();
  });
});

describe("a link that lets someone edit", () => {
  const EDIT_ADDRESS = "https://tisty.cl/k7Qm2xPa#THEKEY.THETOKEN";

  beforeEach(() => {
    const dom = new JSDOM(readFileSync("src/page/index.html", "utf8"), { url: EDIT_ADDRESS });
    place = dom.window;
    const attach = place.Element.prototype.attachShadow;
    place.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      root = attach.call(this, init);
      return root;
    };
    vi.stubGlobal("window", place);
    vi.stubGlobal("document", place.document);
    vi.stubGlobal("location", place.location);
    draw(HELD);
  });

  it("takes the key out of the address before it prints, and puts it back after", () => {
    let addressPrinted = "";
    place.print = vi.fn(() => {
      addressPrinted = place.location.href;
    });
    place.document.getElementById("print")?.click();
    expect(addressPrinted).toBe("https://tisty.cl/k7Qm2xPa");
    expect(place.location.href).toBe("https://tisty.cl/k7Qm2xPa");
    place.dispatchEvent(new place.Event("afterprint"));
    expect(place.location.href).toBe(EDIT_ADDRESS);
  });

  it.each(["pointerdown", "keydown"])("puts the key back on a %s, where a browser never says it printed", (kind) => {
    place.dispatchEvent(new place.Event("beforeprint"));
    expect(place.location.hash).toBe("");
    place.dispatchEvent(new place.Event(kind));
    expect(place.location.href).toBe(EDIT_ADDRESS);
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
  ])("takes the key out when printing with %s+P, before the browser takes the address", (_key, held) => {
    let addressPrinted = "";
    place.print = vi.fn(() => {
      addressPrinted = place.location.href;
    });
    const asking = new place.KeyboardEvent("keydown", { key: "p", cancelable: true, ...held });
    place.dispatchEvent(asking);
    expect(addressPrinted).toBe("https://tisty.cl/k7Qm2xPa");
    expect(asking.defaultPrevented).toBe(true);
    place.dispatchEvent(new place.Event("afterprint"));
    expect(place.location.href).toBe(EDIT_ADDRESS);
  });

  it("leaves a key press that is not printing alone", () => {
    place.print = vi.fn();
    place.dispatchEvent(new place.KeyboardEvent("keydown", { key: "p" }));
    expect(place.print).not.toHaveBeenCalled();
    expect(place.location.href).toBe(EDIT_ADDRESS);
  });

  it("does not lose the key when printing is asked for twice", () => {
    place.print = vi.fn();
    place.document.getElementById("print")?.click();
    place.dispatchEvent(new place.Event("beforeprint"));
    place.dispatchEvent(new place.Event("afterprint"));
    expect(place.location.href).toBe(EDIT_ADDRESS);
  });

  it("offers no button to pass the link on, which is its author's to share", () => {
    expect(place.document.getElementById("copy-link")).toBeNull();
    expect(place.document.body.textContent).not.toContain("Copiar link");
  });

  it("hands Tisty the token, which is the one place it goes", () => {
    const edit = place.document.getElementById("edit-in-tisty") as HTMLAnchorElement;
    expect(edit.getAttribute("href")).toBe(`tisty://edit?link=${encodeURIComponent(EDIT_ADDRESS)}`);
  });
});

describe("on paper", () => {
  const FOLDED = { ...HELD, html: '<h1 id="paseos">Paseos</h1><details><summary>Más</summary><p>dentro</p></details>' };
  const WITH_PAGES: Document = {
    ...HELD,
    html: "<p>primera</p>",
    pages: [
      { id: "AAAAAAAA", at: 1, body: "", html: "<p>segunda</p>" },
      { id: "BBBBBBBB", at: 2, body: "", html: "<p>tercera</p>" },
    ] as unknown as Page[],
  };

  const printing = (): void => {
    place.dispatchEvent(new place.Event("beforeprint"));
  };
  const printed = (): void => {
    place.dispatchEvent(new place.Event("afterprint"));
  };
  const words = (): (string | null)[] => [...root.querySelectorAll("p")].map((one) => one.textContent);

  it("opens the folds for the paper, and closes them again after", () => {
    draw(FOLDED);
    const fold = root.querySelector("details") as HTMLDetailsElement;
    printing();
    expect(fold.hasAttribute("open")).toBe(true);
    printed();
    expect(fold.hasAttribute("open")).toBe(false);
  });

  it("leaves a fold the reader opened as it was", () => {
    draw(FOLDED);
    const fold = root.querySelector("details") as HTMLDetailsElement;
    fold.setAttribute("open", "");
    printing();
    printed();
    expect(fold.hasAttribute("open")).toBe(true);
  });

  it("prints every page in order, from the first, and takes them out after", () => {
    draw(WITH_PAGES);
    printing();
    expect(words()).toEqual(["primera", "segunda", "tercera"]);
    expect(root.querySelectorAll(".printed-page.after")).toHaveLength(2);
    printed();
    expect(words()).toEqual(["primera"]);
  });

  it("keeps the order while another page is on screen", () => {
    draw({
      ...WITH_PAGES,
      html: '<p><a href="tisty:page/1">Enero</a></p>',
    });
    const first = root.querySelector("p")?.textContent;
    (place.document.querySelector("#pages button") as HTMLButtonElement).click();
    printing();
    expect(words()).toEqual([first, "segunda", "tercera"]);
    expect(root.querySelectorAll(".printed-page.before")).toHaveLength(1);
    expect(root.querySelectorAll(".printed-page.after")).toHaveLength(1);
    printed();
    expect(words()).toEqual(["segunda"]);
  });

  it("offers no button where the browser cannot print", () => {
    (place as unknown as { print?: unknown }).print = undefined;
    draw(HELD);
    expect((place.document.getElementById("print") as HTMLElement).hidden).toBe(true);
  });

  it("asks for the paper the reader chose", () => {
    const sizes: string[] = [];
    vi.stubGlobal(
      "CSSStyleSheet",
      class {
        replaceSync(said: string) {
          sizes.push(said);
        }
      },
    );
    (place.document as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets = [];
    draw(HELD);
    expect(sizes.at(-1)).toBe("@page { size: 210mm 297mm; }");
  });
});

describe("who signed it", () => {
  const facts = () => place.document.getElementById("owner-facts") as HTMLElement;

  it("says nothing of an owner when the owner signed this version", () => {
    draw(HELD);
    expect(facts().hidden).toBe(true);
  });

  it("names the owner apart when another root signed this version", () => {
    const cleaner = domPurifyCleaner(place);
    drawFrame({
      held: { ...HELD, signed_as: "Ana", owner_name: "Mario" },
      wordsOf: (html) => finished(cleaner.clean(html), []),
      seal: { ...SEAL, ownerFingerprint: "2" },
    });
    expect(facts().hidden).toBe(false);
    expect(place.document.getElementById("signer")?.textContent).toBe("Ana");
    expect(place.document.getElementById("owner")?.textContent).toBe("Mario");
    expect(place.document.getElementById("owner-fingerprint")?.textContent).toBe("2");
  });
});

const holding = (html: string): Document => ({ ...HELD, html });

describe("widgets and files", () => {
  const HARMFUL = "&lt;script&gt;window.ran = true&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;";
  const FIXED = '&lt;div class="stat"&gt;&lt;b&gt;42&lt;/b&gt;&lt;/div&gt;';
  const widget = (caption: string, body = FIXED) =>
    `<figure class="code">${caption}<pre><code class="language-widget">${body}</code></pre></figure>`;

  it("draws a widget in a frame where nothing can run, under its name", () => {
    draw(holding(widget("<figcaption>Paseos</figcaption>")));
    const frame = root.querySelector("figure.widget iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("src")).toBe("/widget-frame");
    expect(frame.title).toBe("Paseos");
    expect(root.querySelector("figure.widget figcaption")?.textContent).toBe("Paseos");
    expect(root.querySelector("code.language-widget")).toBeNull();
  });

  it("calls a widget with no title what it is, and adds no caption", () => {
    draw(holding(widget("")));
    expect((root.querySelector("figure.widget iframe") as HTMLIFrameElement).title).toBe("Widget");
    expect(root.querySelector("figure.widget figcaption")).toBeNull();
  });

  const observing = () => {
    const seen = { told: [] as (() => void)[], stopped: 0 };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(tell: () => void) {
          seen.told.push(tell);
        }
        observe() {}
        disconnect() {
          seen.stopped += 1;
        }
      },
    );
    return seen;
  };

  const loadedFrame = (): HTMLIFrameElement => {
    const frame = root.querySelector("figure.widget iframe") as HTMLIFrameElement;
    frame.dispatchEvent(new place.Event("load"));
    return frame;
  };

  const measuring = (frame: HTMLIFrameElement, heightOf: () => number) => {
    const box = frame.contentDocument?.querySelector("main.w") as Element;
    box.getBoundingClientRect = () => ({ height: heightOf() }) as DOMRect;
  };

  it("gives the frame the contract's page, in the theme of the sheet, and sizes it to what it holds", () => {
    const { told } = observing();
    draw(holding(widget("")));
    (root.host as HTMLElement).dataset.theme = "dark";
    const frame = loadedFrame();

    const inside = frame.contentDocument as globalThis.Document;
    expect(inside.documentElement.classList.contains("dark")).toBe(true);
    expect(inside.querySelector("main.w .stat b")?.textContent).toBe("42");
    expect(inside.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toContain(
      "default-src 'none'",
    );
    expect(inside.querySelector("script")).toBeNull();
    told.at(-1)?.();
    expect(frame.style.height).toBe("40px");
  });

  it("follows a change of theme, and paper is light whatever the screen was", async () => {
    observing();
    draw(holding(widget("")));
    const host = root.host as HTMLElement;
    host.dataset.theme = "dark";
    const frame = loadedFrame();
    const isDark = () => frame.contentDocument?.documentElement.classList.contains("dark");
    host.dataset.theme = "light";
    await vi.waitFor(() => expect(isDark()).toBe(false));
    expect(frame.style.colorScheme).toBe("light");
    host.dataset.theme = "dark";
    await vi.waitFor(() => expect(isDark()).toBe(true));

    place.dispatchEvent(new place.Event("beforeprint"));
    expect(isDark()).toBe(false);
    place.dispatchEvent(new place.Event("afterprint"));
    expect(isDark()).toBe(true);
  });

  it("grows with what arrives in equal steps, however fast", () => {
    const { told } = observing();
    draw(holding(widget("")));
    const frame = loadedFrame();
    let height = 100;
    measuring(frame, () => height);
    for (const step of [100, 200, 300, 400]) {
      height = step;
      told.at(-1)?.();
      expect(frame.style.height).toBe(`${step}px`);
    }
  });

  it("stops what grows with its own frame, at the height it first asked for", () => {
    const { told } = observing();
    draw(holding(widget("")));
    const frame = loadedFrame();
    measuring(frame, () => (Number.parseFloat(frame.style.height) || 0) + 20);
    told.at(-1)?.();
    const first = frame.style.height;
    told.at(-1)?.();
    told.at(-1)?.();
    expect(frame.style.height).toBe(first);
  });

  it("never lets a frame pass the tallest, and calls nothing there a chase", () => {
    const { told } = observing();
    draw(holding(widget("")));
    const frame = loadedFrame();
    let height = 9000;
    measuring(frame, () => height);
    told.at(-1)?.();
    expect(frame.style.height).toBe("2400px");
    height = 300;
    told.at(-1)?.();
    expect(frame.style.height).toBe("300px");
  });

  it("lets go of what it watched when the reader turns the page", () => {
    const seen = observing();
    draw({ ...holding(widget("")), pages: [ENERO] });
    loadedFrame();
    expect(seen.stopped).toBe(0);
    (place.document.querySelector("#pages button") as HTMLElement).click();
    expect(seen.stopped).toBe(1);
    expect(root.querySelector("iframe")).toBeNull();
  });

  it("goes back to the code and says so when the frame's page cannot hold it", () => {
    observing();
    draw(holding(widget("<figcaption>Paseos</figcaption>")));
    const frame = root.querySelector("figure.widget iframe") as HTMLIFrameElement;
    Object.defineProperty(frame, "contentDocument", { value: null });
    frame.dispatchEvent(new place.Event("load"));
    expect(root.querySelector("figure.widget, iframe")).toBeNull();
    expect(root.querySelector("code.language-widget")?.textContent).toContain("stat");
    expect(root.querySelector(".widget-said")?.textContent).toContain("No se pudo dibujar");
  });

  it("goes back to the code when the policy refused its styles", () => {
    observing();
    draw(holding(widget("")));
    const frame = root.querySelector("figure.widget iframe") as HTMLIFrameElement;
    const inside = frame.contentDocument as globalThis.Document;
    const write = inside.write.bind(inside);
    inside.write = (said: string) => {
      write(said);
      for (const style of inside.querySelectorAll("style")) Object.defineProperty(style, "sheet", { value: null });
    };
    frame.dispatchEvent(new place.Event("load"));
    expect(root.querySelector("figure.widget, iframe")).toBeNull();
    expect(root.querySelector(".widget-said")?.textContent).toContain("No se pudo dibujar");
  });

  it("says a widget past its size is shown as code", () => {
    draw(holding(widget("", "a".repeat(512_001))));
    expect(root.querySelector("iframe")).toBeNull();
    expect(root.querySelector(".widget-said")?.textContent).toContain("512 KB");
  });

  it("does not let a name it refuses fill the sheet", () => {
    draw(holding(widget("", `&lt;${"a".repeat(5000)}&gt;`)));
    expect(root.querySelector(".widget-said")?.textContent?.length).toBeLessThan(250);
  });

  it("takes a caption of only spaces for no name", () => {
    draw(holding(widget("<figcaption>   </figcaption>")));
    expect((root.querySelector("figure.widget iframe") as HTMLIFrameElement).title).toBe("Widget");
    expect(root.querySelector("figure.widget figcaption")).toBeNull();
  });

  it("judges a widget once, however many times the reader comes back to it", () => {
    const parse = vi.fn();
    class CountingParser extends place.DOMParser {
      override parseFromString(...said: Parameters<DOMParser["parseFromString"]>) {
        parse();
        return super.parseFromString(...said);
      }
    }
    vi.stubGlobal("DOMParser", CountingParser);
    draw({ ...holding(widget("")), pages: [ENERO] });
    const judged = parse.mock.calls.length;
    (place.document.querySelector("#pages button") as HTMLElement).click();
    place.document.getElementById("crumb-back")?.click();
    expect(root.querySelector("figure.widget iframe")).not.toBeNull();
    expect(parse.mock.calls.length).toBe(judged);
  });

  it("leaves what is no widget as its code and says what is wrong, drawing none of it", () => {
    draw(holding(widget("<figcaption>Paseos</figcaption>", HARMFUL)));
    expect(root.querySelector("figure.widget, iframe, script, img")).toBeNull();
    expect(root.querySelector("code.language-widget")?.textContent).toContain("<script>");
    expect(root.querySelector(".widget-said")?.textContent).toContain("<script>");
    expect(root.querySelector(".widget-said")?.textContent).toContain("no es un widget");
  });

  const escaped = (said: string): string =>
    said.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  it.each([
    ["a script", "<script>window.ran = true</script>"],
    ["a script in other capitals", "<ScRiPt>window.ran = true</sCrIpT>"],
    ["a script split to slip past a filter", "<scr<script>ipt>window.ran = true</script>"],
    ["an event on a picture", '<img src="x" onerror="window.ran = true">'],
    ["an event on any tag", '<div onclick="window.ran = true">x</div>'],
    ["an address that runs", '<img src="javascript:window.ran = true">'],
    ["a picture from elsewhere", '<img src="https://evil.example/pixel.png">'],
    ["a link", '<a href="https://evil.example">x</a>'],
    ["a frame", '<iframe src="https://evil.example"></iframe>'],
    ["an object", '<object data="https://evil.example/x"></object>'],
    ["an embed", '<embed src="https://evil.example/x">'],
    ["a form", '<form action="https://evil.example"><input name="key"></form>'],
    ["a refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ["a base address", '<base href="https://evil.example/">'],
    ["a drawing that runs", '<svg onload="window.ran = true"></svg>'],
    ["math hiding a picture", '<math><mtext><table><mglyph><style><img src=x onerror="window.ran = true">'],
    ["a quote closed inside an attribute", '<noscript><p title="</noscript><img src=x onerror=window.ran=true>">'],
    ["a style from elsewhere", "<style>@import url(https://evil.example/x.css);</style>"],
    ["a background from elsewhere", '<div style="background: url(https://evil.example/t.png)">x</div>'],
    ["an entity in an event's name", '<img src="x" o&#110;error="window.ran = true">'],
    ["an old expression in a style", '<div style="width: expression(1)">x</div>'],
    ["a binding in a style", "<style>div { -moz-binding: none; }</style>"],
    ["a behavior in a style", '<div style="behavior: none">x</div>'],
  ])("draws nothing a fork could send as %s, and shows it as code", (_, body) => {
    draw(holding(widget("<figcaption>Paseos</figcaption>", escaped(body))));
    expect(root.querySelector("figure.widget, iframe, script, object, embed, form, base, meta")).toBeNull();
    expect(root.querySelector("code.language-widget")?.textContent).toBe(body);
    expect(root.querySelector(".widget-said")?.textContent).toContain("no es un widget");
  });

  it("serves the frame's page under the widget's own policy, and lets only this page frame it", () => {
    const headers = readFileSync("src/page/public/_headers", "utf8");
    const [, ofTheFrame] =
      /\/widget-frame\n {2}! Content-Security-Policy\n {2}Content-Security-Policy: ([^\n]+)/.exec(headers) ?? [];
    expect(ofTheFrame).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(ofTheFrame).toContain("frame-ancestors 'self'");
    expect(ofTheFrame).not.toContain("script-src");
    const [, ofThePage] = /^\/\*\n {2}Content-Security-Policy: ([^\n]+)/m.exec(headers) ?? [];
    expect(ofThePage).toContain("frame-src 'self'");
    expect(ofThePage).toContain("style-src 'self'");
    expect(ofThePage).not.toContain("unsafe-inline");
  });

  const WITH_FILES: Document = {
    ...HELD,
    html: '<p><a class="card" href="tisty:file/0">otro nombre</a></p><p><a class="card" href="tisty:file/1">c</a></p>',
    files: [
      { at: 0, name: "paseos.html", kind: "text/html", size: 40 },
      { at: 1, name: "cartilla.pdf", kind: "application/pdf", size: 40 },
    ],
    files_hash: "x",
  };

  it.each([
    ["a sound", { name: "bark.mp3", kind: "audio/mpeg" }, "Audio", "escucharlo"],
    ["a video", { name: "walk.mp4", kind: "video/mp4" }, "Video", "verlo"],
    ["a sound its kind does not say", { name: "bark.ogg" }, "Audio", "escucharlo"],
  ])("says %s can be played", (_, file, chip, verb) => {
    draw({
      ...HELD,
      html: '<p><a class="card" href="tisty:file/0">x</a></p>',
      files: [{ at: 0, ...file }],
      files_hash: "x",
    });
    const card = root.querySelector(".doc-card");
    expect(card?.querySelector(".chip")?.textContent).toBe(chip);
    expect(card?.querySelector(".card-blurb")?.textContent).toContain(verb);
  });

  it("draws an HTML file as a card like any other, and never opens it", () => {
    draw(WITH_FILES);
    const [html, pdf] = root.querySelectorAll(".doc-card");
    expect(html?.querySelector(".card-name")?.textContent).toBe("paseos.html");
    expect(html?.querySelector(".chip")?.textContent).toBe("Adjunto");
    expect(html?.querySelector(".card-blurb")?.textContent).toContain("Presiona para traerlo");
    expect(html?.hasAttribute("href")).toBe(false);
    expect(pdf?.querySelector(".card-blurb")?.textContent).toContain("Presiona para traerlo");
    expect(root.querySelector("iframe, object, embed")).toBeNull();
  });

  it("finds a file by its place, not by where it sits in the list", () => {
    draw({
      ...WITH_FILES,
      html: '<p><a class="card" href="tisty:file/5">x</a></p>',
      files: [{ at: 5, name: "cartilla.pdf", kind: "application/pdf" }],
    });
    expect(root.querySelector(".card-name")?.textContent).toBe("cartilla.pdf");
  });

  it("says the same of a file named inside a sentence, which stays a word", () => {
    draw({
      ...WITH_FILES,
      html: '<p>Mira <a href="tisty:file/0">la tabla</a> y <a href="tisty:file/1">el papel</a>.</p>',
    });
    const [html, pdf] = root.querySelectorAll("a[data-file]");
    expect(html?.getAttribute("title")).toContain("Presiona para traerlo");
    expect(pdf?.getAttribute("title")).toContain("Presiona para traerlo");
    expect(root.querySelector(".doc-card")).toBeNull();
  });

  it("draws a whole card over the rule for a card inside a sentence", () => {
    const sheet = readFileSync("src/page/ui/sheet.css", "utf8");
    expect(sheet.indexOf("a.doc-card {")).toBeGreaterThan(sheet.indexOf("a.card {"));
  });

  it("does not underline a card, a web link's included, which carries no a.card to clear it", () => {
    const sheet = readFileSync("src/page/ui/sheet.css", "utf8");
    const from = sheet.indexOf("a.doc-card {");
    expect(sheet.slice(from, sheet.indexOf("}", from))).toContain("text-decoration: none;");
  });

  it("writes a file's name as words, never as HTML", () => {
    draw({ ...WITH_FILES, files: [{ at: 0, name: "<img src=x onerror=alert(1)>", kind: "text/html" }] });
    expect(root.querySelector(".card-name img")).toBeNull();
    expect(root.querySelector(".card-name")?.textContent).toContain("onerror");
  });
});

describe("what a note says it is", () => {
  it.each([
    ["note", "Nota"],
    ["tip", "Consejo"],
    ["important", "Importante"],
    ["warning", "Aviso"],
    ["caution", "Cuidado"],
  ])("%s reads %s", (kind, said) => {
    draw(holding(`<blockquote class="callout" data-callout="${kind}"><p>x</p></blockquote>`));
    expect(root.querySelector("blockquote")?.getAttribute("data-said")).toBe(said);
  });
});

describe("editing in Tisty", () => {
  const notice = () => place.document.getElementById("opening-tisty") as HTMLElement;
  const button = () => place.document.getElementById("edit-in-tisty") as HTMLAnchorElement;
  let on: Record<string, () => void>;

  beforeEach(() => {
    on = {};
    vi.stubGlobal("addEventListener", (name: string, run: () => void) => {
      on[name] = run;
    });
    draw(HELD);
    // jsdom cannot follow a link anyway.
    button().addEventListener("click", (event) => event.preventDefault());
  });

  it("hands the whole link to Tisty, to edit it", () => {
    expect(button().getAttribute("href")).toBe(`tisty://edit?link=${encodeURIComponent(ADDRESS)}`);
    expect(button().textContent).toBe("Editar en Tisty");
  });

  it("offers Tisty on every click, since a browser never says whether it is installed", () => {
    expect(notice().hidden).toBe(true);
    button().click();
    expect(notice().hidden).toBe(false);
    expect(notice().querySelector("a")?.getAttribute("href")).toBe("https://www.tisty.app/");
  });

  it("stays while the focus is away, and closes when the reader comes back from the app", () => {
    button().click();
    on.blur?.();
    expect(notice().hidden).toBe(false);
    on.focus?.();
    expect(notice().hidden).toBe(true);
  });

  it("stays if the focus never left, and closes when asked", () => {
    button().click();
    on.focus?.();
    expect(notice().hidden).toBe(false);
    place.document.getElementById("opening-tisty-close")?.click();
    expect(notice().hidden).toBe(true);
  });

  it("does not close by itself on a later visit to the window, once it was closed by hand", () => {
    button().click();
    place.document.getElementById("opening-tisty-close")?.click();
    on.blur?.();
    on.focus?.();
    button().click();
    expect(notice().hidden).toBe(false);
  });
});

describe("turning a page", () => {
  it("leaves a keyboard on the new words, and asks nothing of it when the document first opens", () => {
    draw(HELD);
    expect(root.activeElement).toBeNull();
    click("Enero");
    expect(root.activeElement?.className).toBe("sheet");
    place.document.getElementById("crumb-back")?.click();
    expect(root.activeElement?.className).toBe("sheet");
  });
});

describe("the paper", () => {
  it("sets the width on the column, where the card of pages can see it too", () => {
    draw(HELD);
    const column = place.document.getElementById("sheet-column");
    expect(column?.style.getPropertyValue("--page-width")).toBe("820px");
    place.document.getElementById("sheets")?.click();
    expect(column?.style.getPropertyValue("--page-width")).toBe("794px");
  });

  describe("and its buttons", () => {
    const A4 = "@page { size: 210mm 297mm; }";
    const LETTER = "@page { size: 215.9mm 279.4mm; }";
    const FOLIO = "@page { size: 215.9mm 330.2mm; }";
    let sizes: string[];

    const leaf = (paper: string) => place.document.querySelector(`[data-paper="${paper}"]`) as HTMLButtonElement;
    const toggle = () => place.document.getElementById("sheets") as HTMLButtonElement;
    const landscape = () => place.document.getElementById("landscape") as HTMLButtonElement;
    const pressedPapers = () =>
      [...place.document.querySelectorAll<HTMLElement>('[data-paper][aria-pressed="true"]')].map(
        (one) => one.dataset.paper,
      );
    const printsOn = () => sizes.at(-1);

    beforeEach(() => {
      sizes = [];
      vi.stubGlobal(
        "CSSStyleSheet",
        class {
          replaceSync(said: string) {
            sizes.push(said);
          }
        },
      );
      (place.document as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets = [];
    });

    it("come after the toggle they depend on", () => {
      draw(HELD);
      expect(place.document.getElementById("panel-paper")?.firstElementChild).toBe(toggle());
    });

    it("cannot be reached or pressed out of sheets, and printing keeps the document's paper", () => {
      draw(HELD);
      const letter = leaf("letter");
      expect(letter.matches(":disabled")).toBe(true);
      letter.focus();
      expect(place.document.activeElement).not.toBe(letter);
      letter.click();
      expect(pressedPapers()).toEqual(["a4"]);
      expect(printsOn()).toBe(A4);
    });

    it("can be chosen once the toggle is pressed, and printing follows them", () => {
      draw(HELD);
      toggle().click();
      const letter = leaf("letter");
      expect(letter.matches(":disabled")).toBe(false);
      letter.focus();
      expect(place.document.activeElement).toBe(letter);
      letter.click();
      expect(pressedPapers()).toEqual(["letter"]);
      expect(printsOn()).toBe(LETTER);
    });

    it("go back to the document's paper when the toggle is released, and keep the choice for its return", () => {
      draw(HELD);
      toggle().click();
      leaf("letter").click();
      toggle().click();
      expect(leaf("letter").matches(":disabled")).toBe(true);
      expect(pressedPapers()).toEqual(["a4"]);
      expect(printsOn()).toBe(A4);
      toggle().click();
      expect(pressedPapers()).toEqual(["letter"]);
      expect(printsOn()).toBe(LETTER);
    });

    it("print and show the paper a document asked for, while they stay disabled", () => {
      draw({ ...HELD, sheet: { paper: "folio" } });
      expect(leaf("folio").matches(":disabled")).toBe(true);
      expect(pressedPapers()).toEqual(["folio"]);
      expect(printsOn()).toBe(FOLIO);
    });

    it("keep the tabloid a document asked for, which they do not offer", () => {
      draw({ ...HELD, sheet: { paper: "tabloid" } });
      expect(leaf("tabloid").hidden).toBe(false);
      expect(pressedPapers()).toEqual(["tabloid"]);
      expect(printsOn()).toBe("@page { size: 279.4mm 431.8mm; }");
    });

    it("are ready from the start in a document that opens in sheets", () => {
      draw({ ...HELD, sheet: { on: true, paper: "letter" } });
      expect(leaf("a4").matches(":disabled")).toBe(false);
      expect(pressedPapers()).toEqual(["letter"]);
    });

    it("leave no hidden turn of the page behind when the toggle is released", () => {
      draw(HELD);
      toggle().click();
      landscape().click();
      expect(printsOn()).toBe("@page { size: 297mm 210mm; }");
      toggle().click();
      expect(landscape().hidden).toBe(true);
      expect(printsOn()).toBe(A4);
    });

    it("keep a document's own turn of the page out of sheets", () => {
      draw({ ...HELD, sheet: { orientation: "landscape" } });
      expect(printsOn()).toBe("@page { size: 297mm 210mm; }");
    });
  });
});

describe("following the reading", () => {
  const LONG: Document = {
    ...HELD,
    html: [
      '<h1 id="paseos">Paseos</h1>',
      '<h2 id="uno">Uno</h2>',
      '<h2 id="dos">Dos</h2>',
      '<h2 id="tres">Tres</h2>',
    ].join(""),
  };
  let tops: Record<string, number>;
  let on: Record<string, () => void>;

  const current = () => place.document.querySelector("#index [aria-current]")?.textContent;

  beforeEach(() => {
    tops = { paseos: -500, uno: 900, dos: 1500, tres: 2100 };
    on = {};
    place.Element.prototype.getBoundingClientRect = function (this: Element) {
      return { top: tops[this.id] ?? 0 } as DOMRect;
    };
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("scrollY", 0);
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
    vi.stubGlobal("addEventListener", (name: string, run: () => void) => {
      on[name] = run;
    });
  });

  it("marks nothing while no heading has been reached", () => {
    draw(LONG);
    expect(current()).toBeUndefined();
  });

  it("marks the last heading past the upper third of the window, and only that one", () => {
    draw(LONG);
    tops = { ...tops, uno: -100, dos: 250, tres: 800 };
    on.scroll?.();
    expect(current()).toBe("Dos");
    expect(place.document.querySelectorAll("#index [aria-current]")).toHaveLength(1);
  });

  it("marks the last heading at the end of the page, however low it stayed", () => {
    draw(LONG);
    Object.defineProperty(place.document.documentElement, "scrollHeight", { value: 2000, configurable: true });
    vi.stubGlobal("scrollY", 1100);
    on.scroll?.();
    expect(current()).toBe("Tres");
  });

  it("starts the list from its top on a new page, wherever the last one had got to", () => {
    draw({ ...LONG, html: `<p><a href="tisty:page/1">Enero</a></p>${LONG.html}` });
    const list = place.document.getElementById("index") as HTMLElement;
    list.scrollTop = 400;
    click("Enero");
    expect(list.scrollTop).toBe(0);
  });

  it("leaves a row in its place in the list when the window changes", () => {
    draw(LONG);
    tops = { ...tops, uno: -100 };
    on.scroll?.();
    const list = place.document.getElementById("index") as HTMLElement;
    const row = list.querySelector<HTMLElement>("[aria-current]");
    if (row) Object.defineProperty(row, "offsetTop", { value: 500 });
    Object.defineProperty(list, "clientHeight", { value: 200 });
    on.resize?.();
    expect(list.scrollTop).toBe(400);
  });
});

describe("the panels' measures", () => {
  it("are handed to the stylesheet, which does the arithmetic", () => {
    let measure = (): void => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(run: () => void) {
          measure = run;
        }
        observe(): void {}
      },
    );
    draw(HELD);
    place.Element.prototype.getBoundingClientRect = function (this: Element) {
      return { height: this.id === "panels" ? 700 : 160 } as DOMRect;
    };
    measure();
    const style = place.document.getElementById("panels")?.style;
    expect(style?.getPropertyValue("--panels-height")).toBe("700px");
    expect(style?.getPropertyValue("--panels-rest")).toBe("540px");
  });
});

describe("the index", () => {
  const dockButton = () => place.document.querySelector<HTMLElement>('.dock [data-panel="panel-index"]');
  const panel = () => place.document.getElementById("panel-index");

  it("stays offered when there is something in it", () => {
    draw(HELD);
    expect(panel()?.hidden).toBe(false);
    expect(dockButton()?.hidden).toBe(false);
  });

  it("is not offered on the dock when it has nothing to show", () => {
    draw({ id: "k7Qm2xPa", title: "Solo", body: "", html: "<p>Sin títulos.</p>" });
    expect(panel()?.hidden).toBe(true);
    expect(dockButton()?.hidden).toBe(true);
  });
});

describe("another language in the same frame", () => {
  const JANUARY: Page = { ...ENERO, id: "p2", page_of: "enWords1", title: "January", html: "<h1>January</h1>" };
  const ENGLISH: Document = {
    id: "enWords1",
    title: "Walks",
    lang: "en",
    body: "",
    html: [
      '<h1 id="walks">Walks</h1>',
      '<p><a href="tisty:cited/0">other</a> <a href="tisty:file/0">attached</a></p>',
      '<h2 id="river">River</h2>',
    ].join(""),
    pages: [JANUARY],
    cited: [{ document: "citedEn", key: "ENKEY" }],
    files: [{ at: 0, name: "notes.txt" }],
    made: "2026-01-01T00:00:00Z",
  };
  const shownOf = (held: Document, pressFile?: (link: HTMLElement) => void, seal: Seal = SEAL) => {
    const cleaner = domPurifyCleaner(place);
    return {
      held,
      wordsOf: (html: string) => finished(cleaner.clean(html), []),
      seal,
      ...(pressFile ? { pressFile } : {}),
    };
  };
  const SPANISH: Document = { ...HELD, files: [{ at: 0, name: "notas.txt" }], made: "2026-01-01T00:00:00Z" };

  beforeEach(() => {
    vi.stubGlobal("innerHeight", 900);
  });

  it("draws the other document in the same sheet, and answers each click once", () => {
    const before = vi.fn();
    const after = vi.fn();
    place.print = vi.fn();
    const redraw = drawFrame(shownOf(SPANISH, before));
    redraw(shownOf(ENGLISH, after));
    expect(place.document.title).toBe("Walks · Folio");
    expect(root.querySelector(".sheet")?.getAttribute("lang")).toBe("en");
    expect(click("other")).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/citedEn#ENKEY");
    linkSaying("attached")?.dispatchEvent(new place.MouseEvent("click", { bubbles: true, composed: true }));
    expect(after).toHaveBeenCalledTimes(1);
    expect(before).not.toHaveBeenCalled();
    place.document.getElementById("print")?.click();
    expect(place.print).toHaveBeenCalledTimes(1);
  });

  it("lists only the new document's pages and details", () => {
    const redraw = drawFrame(shownOf(SPANISH));
    redraw(shownOf(ENGLISH));
    const pages = [...place.document.querySelectorAll("#pages button")].map((one) => one.textContent);
    expect(pages).toEqual(["January"]);
    expect(place.document.querySelectorAll("#details > div")).toHaveLength(1);
  });

  it("keeps the reader on the page in the same place, and in the section with the same count", () => {
    const LONG_ENERO: Page = { ...ENERO, html: '<h1 id="enero">Enero</h1><h2 id="uno">Uno</h2><h2 id="dos">Dos</h2>' };
    const LONG_JANUARY: Page = {
      ...JANUARY,
      html: '<h1 id="january">January</h1><h2 id="one">One</h2><h2 id="two">Two</h2>',
    };
    const tops: Record<string, number> = { enero: -500, uno: -100, dos: 600 };
    place.Element.prototype.getBoundingClientRect = function (this: Element) {
      return { top: tops[this.id] ?? 0 } as DOMRect;
    };
    const redraw = drawFrame(shownOf({ ...SPANISH, pages: [LONG_ENERO] }));
    click("Enero");
    redraw(shownOf({ ...ENGLISH, pages: [LONG_JANUARY] }));
    expect(place.document.title).toBe("January · Folio");
    expect(place.document.getElementById("crumb-title")?.textContent).toBe("Walks");
    expect(scrolled.map((one) => one.id)).toEqual(["one"]);
  });

  it("opens the other document at its start when it has no page in that place", () => {
    const redraw = drawFrame(shownOf(SPANISH));
    click("Enero");
    redraw(shownOf({ ...ENGLISH, pages: [] }));
    expect(place.document.title).toBe("Walks · Folio");
    expect(place.document.getElementById("crumb")?.hidden).toBe(true);
    expect(place.document.getElementById("pages-card")?.hidden).toBe(true);
  });
});
