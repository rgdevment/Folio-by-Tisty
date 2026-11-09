import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(name, "utf8");
const PLACE = "src/page/public";
const PAGES = ["home.html"];
const HTML = read(`${PLACE}/home.html`);
const REDIRECTS = read(`${PLACE}/_redirects`);
const LANGUAGE = read(`${PLACE}/language.js`);
const flat = HTML.replace(/\s+/g, " ");

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
  it.each(PAGES)("%s says everything in both languages, in pairs", (page) => {
    const body = read(`${PLACE}/${page}`).split("<body>")[1] ?? "";
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

  it("does not contradict what Tisty says about Folio", () => {
    expect(flat).toContain(
      "Folio te permite compartir documentos en privado con quien quieras, con un link y cifrados de forma segura. Se comparte desde Tisty.",
    );
    expect(flat).toContain(
      "Folio lets you share documents privately with anyone, using an encrypted link. You share from Tisty.",
    );
  });

  it("says what the policy says about reports and orders", () => {
    expect(flat).toContain("hasta 180 días");
    expect(flat).toContain("up to 180 days");
    expect(flat).toContain("docs/PRIVACIDAD.md");
    expect(flat).toContain("docs/PRIVACY.md");
  });

  it.each(PAGES)("%s loads nothing from anyone else", (page) => {
    const loaded = [
      ...read(`${PLACE}/${page}`).matchAll(/<(?:script|img)[^>]*\ssrc="([^"]+)"|<link[^>]*\shref="([^"]+)"/g),
    ]
      .map(([, source, linked]) => source ?? linked)
      .filter((address) => address !== "https://tisty.cl/");
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((address) => address?.startsWith("/"))).toBe(true);
  });

  it("is what tisty.cl shows at its root, without sending anyone away", () => {
    expect(REDIRECTS).toBe("/ /home 200\n");
    expect(HTML).toContain('<link rel="canonical" href="https://tisty.cl/" />');
  });

  it("is where the reader's name leads", () => {
    expect(read("src/page/index.html")).toContain('<a class="brand" href="/">');
  });
});

describe("the language of the home page", () => {
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
