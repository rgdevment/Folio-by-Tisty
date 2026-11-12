import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(name, "utf8");
const PLACE = "src/page/public";
const LANGUAGES = ["es", "en"] as const;
type Language = (typeof LANGUAGES)[number];
const HOME: Record<Language, string> = { es: read(`${PLACE}/es/index.html`), en: read(`${PLACE}/home.html`) };
const ADDRESS: Record<Language, string> = { es: "https://tisty.cl/es/", en: "https://tisty.cl/" };
const PAGES = ["home.html", "es/index.html", "404.html"];
const REDIRECTS = read(`${PLACE}/_redirects`);
const LANGUAGE = read(`${PLACE}/language.js`);
const CHOOSER = read(`${PLACE}/home-language.js`);
const SITUATIONS = read(`${PLACE}/home-situations.js`);
const MISSING = read(`${PLACE}/404.html`);
const flat = (html: string): string => html.replace(/\s+/g, " ");
const meta = (html: string, property: string): string | undefined =>
  new RegExp(`<meta\\s+(?:property|name)="${property}"\\s+content="([^"]*)"`).exec(html)?.[1];
const title = (html: string): string | undefined => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const tags = (html: string): string[] =>
  [...(html.split("<body>")[1] ?? "").matchAll(/<(\/?\w+)/g)].map(([, tag]) => tag ?? "");

const visit = (browser: string | undefined) => {
  const root = { lang: "", dataset: {} as Record<string, string> };
  const buttons = ["es", "en"].map((language) => {
    const said: Record<string, string> = {};
    const heard: (() => void)[] = [];
    return {
      dataset: { language },
      said,
      setAttribute: (name: string, value: string) => {
        said[name] = value;
      },
      addEventListener: (_name: string, listener: () => void) => heard.push(listener),
      press: () => {
        for (const listener of heard) listener();
      },
    };
  });
  const ready: (() => void)[] = [];
  const document = {
    documentElement: root,
    querySelectorAll: () => buttons,
    addEventListener: (_name: string, listener: () => void) => ready.push(listener),
  };
  runInNewContext(LANGUAGE, { document, navigator: { language: browser } });
  for (const listener of ready) listener();
  return { root, buttons };
};

describe("the home page", () => {
  it.each(LANGUAGES)("in %s is a page of its own, written in that language", (language) => {
    expect(HOME[language]).toContain(`<html lang="${language}">`);
    expect(HOME[language].match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it("is built the same in both languages, tag for tag", () => {
    expect(tags(HOME.es).length).toBeGreaterThan(0);
    expect(tags(HOME.en)).toEqual(tags(HOME.es));
  });

  it("does not contradict what Tisty says about Folio", () => {
    expect(flat(HOME.es)).toContain(
      "Folio te permite compartir documentos en privado con quien quieras, con un link y cifrados de forma segura. Se comparte desde Tisty.",
    );
    expect(flat(HOME.en)).toContain(
      "Folio lets you share documents privately with anyone, using an encrypted link. You share from Tisty.",
    );
  });

  it("says what the policy says about reports and orders", () => {
    expect(flat(HOME.es)).toContain("hasta 180 días");
    expect(flat(HOME.en)).toContain("up to 180 days");
    expect(HOME.es).toContain('href="/es/privacidad/"');
    expect(HOME.en).toContain('href="/privacy/"');
  });

  it.each(PAGES)("%s loads nothing from anyone else", (page) => {
    const loaded = [
      ...read(`${PLACE}/${page}`).matchAll(
        /<(?:script|img)[^>]*\ssrc="([^"]+)"|<link(?![^>]*\srel="(?:canonical|alternate)")[^>]*\shref="([^"]+)"/g,
      ),
    ].map(([, source, linked]) => source ?? linked);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((address) => address?.startsWith("/"))).toBe(true);
  });

  it.each(PAGES)("%s keeps everything between its header and its footer in its main content", (page) => {
    const html = read(`${PLACE}/${page}`);
    expect(html).toMatch(/<\/header>\s*<main[\s>]/);
    expect(html).toMatch(/<\/main>\s*<footer[\s>]/);
    expect(html.match(/<main[\s>]/g)).toHaveLength(1);
  });

  it("is at tisty.cl's root in English, as on Tisty's site, and the old English address leads there", () => {
    expect(REDIRECTS).toBe("/ /home 200\n/en/ / 301\n/en / 301\n/es /es/ 301\n");
    for (const language of LANGUAGES) {
      expect(HOME[language]).toContain(`<link rel="canonical" href="${ADDRESS[language]}" />`);
    }
  });

  it.each(LANGUAGES)("in %s leads its code link to Tisty's site, in that language", (language) => {
    const site = language === "es" ? "https://www.tisty.app/es/" : "https://www.tisty.app/";
    expect(HOME[language]).toContain(`<a href="${site}">${language === "es" ? "Código" : "Code"}</a>`);
  });

  it("is where the reader's name leads", () => {
    expect(read("src/page/index.html")).toContain('<a class="brand" href="/">');
  });

  it.each(LANGUAGES)("in %s can be found, and tells search engines where the other language lives", (language) => {
    const html = HOME[language];
    expect(html).not.toMatch(/<meta\s+name="robots"/);
    expect(html).toContain('<link rel="alternate" hreflang="es" href="https://tisty.cl/es/" />');
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://tisty.cl/" />');
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://tisty.cl/" />');
  });

  it.each(LANGUAGES)("in %s is described in its own words when found or shared", (language) => {
    const html = HOME[language];
    expect(title(html)).toMatch(/^Folio by Tisty: .{20,}/);
    expect(meta(html, "og:title")).toBe(title(html));
    expect(meta(html, "description")?.length).toBeGreaterThan(80);
    expect(meta(html, "og:description")).toBe(meta(html, "description"));
    expect(meta(html, "og:url")).toBe(ADDRESS[language]);
    expect(meta(html, "og:site_name")).toBe("Folio by Tisty");
    expect(meta(html, "og:image")).toBe("https://tisty.cl/preview.png");
    expect(meta(html, "og:image:alt")).toMatch(/^Folio by Tisty: /);
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
  });

  it.each(LANGUAGES)("in %s changes language with links, so the choice stays in the address", (language) => {
    const html = HOME[language];
    expect(html).toMatch(/<nav class="languages" aria-label="[^"]+">/);
    expect(html).toMatch(/<a href="\/es\/" hreflang="es" lang="es" aria-label="Español"/);
    expect(html).toMatch(/<a href="\/" hreflang="en" lang="en" aria-label="English"/);
    expect(/<a href="([^"]+)"[^>]*aria-current="page"/.exec(html)?.[1]).toBe(new URL(ADDRESS[language]).pathname);
    expect([...html.matchAll(/<script(?! type="application\/ld\+json")[^>]*>/g)].map(([tag]) => tag)).toEqual([
      '<script src="/home-language.js">',
      '<script src="/home-situations.js" defer>',
    ]);
  });

  it.each(LANGUAGES)("in %s tells search engines and assistants what Folio is and who runs it", (language) => {
    const data = JSON.parse(/<script type="application\/ld\+json">([^<]+)<\/script>/.exec(HOME[language])?.[1] ?? "{}");
    const app = data["@graph"]?.find((one: { "@type": string }) => one["@type"] === "WebApplication");
    expect(app?.["@id"]).toBe("https://tisty.cl/#folio");
    expect(app?.url).toBe(ADDRESS[language]);
    expect(app?.provider?.["@id"]).toBe("https://rgdevment.dev/#person");
  });

  it("is named by both privacy policies", () => {
    expect(read("docs/PRIVACY.md")).toContain("The home of tisty.cl");
    expect(read("docs/PRIVACIDAD.md")).toContain("La portada de tisty.cl");
  });

  it("is no longer sent to folio.tisty.app by what the repository tells", () => {
    for (const told of [
      "README.md",
      "README.es.md",
      "PRIVACY.md",
      "PRIVACIDAD.md",
      "SECURITY.md",
      "SEGURIDAD.md",
      "TERMS.md",
      "TERMINOS.md",
    ]) {
      expect(read(told.startsWith("README") ? told : `docs/${told}`)).not.toContain("folio.tisty.app");
    }
  });
});

describe("the home in the browser's language", () => {
  const SITE = "https://tisty.cl";
  const arrive = (page: Language, browser: string | undefined, referrer = "", address = "") => {
    const root = { lang: page, dataset: {} as Record<string, string> };
    const sent: string[] = [];
    const [search = "", hash = ""] = address.split(/(?=#)/);
    const location = { origin: SITE, search, hash, replace: (to: string) => sent.push(to) };
    runInNewContext(CHOOSER, {
      document: { documentElement: root, referrer },
      navigator: { language: browser },
      location,
    });
    return { sent, offer: root.dataset.offer ?? "nothing" };
  };

  it.each(["es-CL", "ES", "es"])("sends a browser in %s from the root to the page in Spanish", (browser) => {
    expect(arrive("en", browser)).toEqual({ sent: ["/es/"], offer: "nothing" });
  });

  it("keeps the query and the section a visitor came for", () => {
    expect(arrive("en", "es-CL", "", "?from=tisty#facts").sent).toEqual(["/es/?from=tisty#facts"]);
  });

  it("leaves a browser in Spanish that chose English on this site, and still offers Spanish", () => {
    expect(arrive("en", "es-CL", `${SITE}/`)).toEqual({ sent: [], offer: "es" });
  });

  it("sends a browser in Spanish that came from another site", () => {
    expect(arrive("en", "es-CL", "https://tisty.cl.example.com/").sent).toEqual(["/es/"]);
  });

  it.each([
    ["en", "en-GB", "nothing"],
    ["en", "pt-BR", "nothing"],
    ["en", undefined, "nothing"],
    ["es", "en-US", "en"],
    ["es", "pt-BR", "en"],
    ["es", undefined, "en"],
    ["es", "es-CL", "nothing"],
  ] as const)("on the page in %s, for a browser in %s, stays and offers %s", (page, browser, offer) => {
    expect(arrive(page, browser)).toEqual({ sent: [], offer });
  });

  it.each(LANGUAGES)("in %s offers the other page, in the other language", (language) => {
    const other = language === "es" ? "en" : "es";
    expect(HOME[language]).toMatch(
      new RegExp(
        `<p class="offer" lang="${other}" data-nosnippet><a href="${new URL(ADDRESS[other]).pathname}" hreflang="${other}"[ >]`,
      ),
    );
  });

  it.each(LANGUAGES)(
    "in %s sends this site as referrer from every link to English, and only from those",
    (language) => {
      const toEnglish = [...HOME[language].matchAll(/<a href="\/"[^>]*>/g)].map(([tag]) => tag);
      expect(toEnglish.length).toBeGreaterThan(0);
      expect(toEnglish.every((tag) => tag.includes('referrerpolicy="origin"'))).toBe(true);
      expect(HOME[language].match(/referrerpolicy=/g)).toHaveLength(toEnglish.length);
    },
  );

  it("keeps the offer hidden until the browser asks for it, and keeps nothing in the browser", () => {
    const site = read(`${PLACE}/site.css`);
    expect(site).toMatch(/\.offer \{\s+display: none;/);
    expect(site).toMatch(/html\[data-offer\] \.offer \{\s+display: block;/);
    expect(CHOOSER).not.toMatch(/Storage|cookie/);
  });
});

describe("the situations the home tells", () => {
  const hiddenAt = (html: string): boolean[] =>
    [
      ...(/<span class="situations">([\s\S]*?)<\/span>\s+Folio/.exec(html)?.[1] ?? "").matchAll(
        /<span( aria-hidden="true")?>/g,
      ),
    ].map(([, hidden]) => hidden !== undefined);

  const watch = ({ reduced = false, hidden = false, hovered = false } = {}) => {
    const situations = [0, 1, 2].map((at) => {
      const said = new Set(at === 0 ? [] : ["aria-hidden"]);
      return {
        said,
        setAttribute: (name: string) => said.add(name),
        removeAttribute: (name: string) => said.delete(name),
      };
    });
    let tick: (() => void) | undefined;
    let stopped = false;
    runInNewContext(SITUATIONS, {
      document: { querySelector: () => ({ children: situations, matches: () => hovered }), hidden },
      matchMedia: () => ({ matches: reduced }),
      setInterval: (listener: () => void) => {
        tick = listener;
      },
      clearInterval: () => {
        stopped = true;
      },
    });
    const shown = () => situations.findIndex((one) => !one.said.has("aria-hidden"));
    return { tick: () => tick?.(), shown, stopped: () => stopped, moves: () => tick !== undefined };
  };

  it("are as many in both languages, and only the first is shown before any script runs", () => {
    const es = hiddenAt(HOME.es);
    expect(es.length).toBeGreaterThan(1);
    expect(es).toEqual([false, ...Array(es.length - 1).fill(true)]);
    expect(hiddenAt(HOME.en)).toEqual(es);
  });

  it("show each one once and end on the first", () => {
    const home = watch();
    const seen = [1, 2, 3].map(() => {
      expect(home.stopped()).toBe(false);
      home.tick();
      return home.shown();
    });
    expect(seen).toEqual([1, 2, 0]);
    expect(home.stopped()).toBe(true);
  });

  it.each([{ hovered: true }, { hidden: true }])("wait while %o", (state) => {
    const home = watch(state);
    home.tick();
    expect(home.shown()).toBe(0);
  });

  it("stay on the first when the system asks for less motion", () => {
    expect(watch({ reduced: true }).moves()).toBe(false);
  });

  it("share one place, so the page does not jump when one changes", () => {
    const site = read(`${PLACE}/site.css`);
    expect(site).toMatch(/\.situations > \* \{\s+grid-area: 1 \/ 1;/);
    expect(site).toMatch(/\.situations > \[aria-hidden="true"\] \{\s+visibility: hidden;/);
  });
});

describe("the page of a link that is gone", () => {
  it("says everything in both languages, in pairs", () => {
    const body = MISSING.split("<body>")[1] ?? "";
    const said = [...body.matchAll(/<(\w+)[^>]*\slang="(es|en)"/g)].map(([, tag, language]) => `${tag} ${language}`);
    expect(said.length).toBeGreaterThan(0);
    expect(said.length % 2).toBe(0);
    said.forEach((one, at) => {
      const [tag, language] = one.split(" ");
      const [firstTag] = (said[at - (at % 2)] ?? "").split(" ");
      expect(language).toBe(at % 2 === 0 ? "es" : "en");
      expect(tag).toBe(firstTag);
    });
  });

  it("is tisty.cl's own, where the reader sends a missing link", () => {
    expect(read("src/page/ui/main.ts")).toContain('const NOT_FOUND = "/404";');
  });

  it("says what Tisty's site says when a shared link is gone", () => {
    const words = flat(MISSING);
    expect(words).toContain("Esta nota se fue a descansar.");
    expect(words).toContain("This note has gone to rest.");
    expect(words).toContain("pídele a quien te lo envió un enlace nuevo");
    expect(words).toContain("ask whoever sent it for a fresh link");
  });

  it("leads to Tisty's site in either language", () => {
    for (const address of [
      "https://www.tisty.app/",
      "https://www.tisty.app/es/",
      "https://www.tisty.app/docs/",
      "https://www.tisty.app/es/ayuda/",
    ]) {
      expect(MISSING).toContain(`href="${address}"`);
    }
  });

  it("is kept out of every search", () => {
    expect(MISSING).toContain('<meta name="robots" content="noindex" />');
  });

  it("names its language switch, and each of its buttons", () => {
    expect(MISSING).toMatch(/<fieldset class="languages" aria-label="[^"]+">/);
    expect(MISSING).toContain('lang="es" aria-label="Español">ES</button>');
    expect(MISSING).toContain('lang="en" aria-label="English">EN</button>');
  });
});

describe("the stylesheet of the home and the missing page", () => {
  const SITE = read(`${PLACE}/site.css`);

  it("rings the focus in the ink that stands out on either background", () => {
    expect(SITE).toMatch(/:focus-visible \{\s+outline: 2px solid var\(--flame-ink\);/);
  });

  it("lays the hero, the facts and the reasons in a single column on a phone", () => {
    const phone = /@media \(max-width: 48rem\) \{([\s\S]*?)\n\}/.exec(SITE)?.[1] ?? "";
    expect(phone).toMatch(/\.hero \{\s+grid-template-columns: minmax\(0, 1fr\);/);
    expect(phone).toMatch(/\.facts,\s+\.reasons \{\s+grid-template-columns: minmax\(0, 1fr\);/);
  });

  it("moves nothing in a loop, so every animation ends on its own", () => {
    expect(SITE).toContain("animation");
    expect(SITE).not.toContain("infinite");
  });
});

describe("the language of the page of a link that is gone", () => {
  it.each([
    ["es-CL", "es"],
    ["ES", "es"],
    ["en-US", "en"],
    ["pt-BR", "en"],
    [undefined, "en"],
  ])("for a browser in %s is %s", (browser, language) => {
    const { root, buttons } = visit(browser);
    expect(root.lang).toBe(language);
    expect(root.dataset.shown).toBe(language);
    expect(buttons.find((one) => one.dataset.language === language)?.said["aria-pressed"]).toBe("true");
    expect(buttons.find((one) => one.dataset.language !== language)?.said["aria-pressed"]).toBe("false");
  });

  it("changes with its buttons, and keeps nothing in the browser", () => {
    const { root, buttons } = visit("en-US");
    buttons[0]?.press();
    expect(root.lang).toBe("es");
    expect(buttons[0]?.said["aria-pressed"]).toBe("true");
    buttons[1]?.press();
    expect(root.lang).toBe("en");
    expect(LANGUAGE).not.toContain("Storage");
  });
});
