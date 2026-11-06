import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(name, "utf8");
const PLACE = "src/public/page";
const PAGES = ["index.html", "404.html"];
const HTML = read(`${PLACE}/index.html`);
const HEADERS = read(`${PLACE}/_headers`);
const LANGUAGE = read(`${PLACE}/language.js`);
const WRANGLER = read("wrangler.public.toml");
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

describe("the public page", () => {
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
      "Folio te permite compartir documentos en privado con quien quieras, con un link y cifrados de forma segura. Todavía no está disponible.",
    );
    expect(flat).toContain(
      "Folio lets you share documents privately with anyone, using an encrypted link. It isn't available yet.",
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
      .filter((address) => address !== "https://folio.tisty.app/");
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((address) => address?.startsWith("/"))).toBe(true);
  });

  it("forbids anything from anyone else", () => {
    expect(HEADERS).toContain("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';");
  });

  it("wears the same icon and mascot as the reader's page", () => {
    for (const name of ["icon.svg", "tisto.svg"]) {
      expect(read(`${PLACE}/${name}`)).toBe(read(`src/page/public/${name}`));
    }
  });

  it("is only assets on its own address, so a visit wakes no code", () => {
    expect(WRANGLER).toContain('pattern = "folio.tisty.app"');
    expect(WRANGLER).toContain('directory = "./src/public/page"');
    expect(WRANGLER).toContain("workers_dev = false");
    expect(WRANGLER).not.toMatch(/^main\s*=/m);
  });

  it("answers an unknown address as missing", () => {
    expect(WRANGLER).toContain('not_found_handling = "404-page"');
  });

  it("is named by both privacy policies", () => {
    expect(read("docs/PRIVACIDAD.md")).toContain("folio.tisty.app");
    expect(read("docs/PRIVACY.md")).toContain("folio.tisty.app");
  });
});

describe("the language of the public page", () => {
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
