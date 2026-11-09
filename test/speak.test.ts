import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnglish } from "../scripts/page-words";
import { said, speak } from "../src/page/ui/speak";
import { WORDS } from "../src/page/ui/words";

const HTML = readFileSync("src/page/index.html", "utf8");
let page: globalThis.Document;

const byId = (id: string): HTMLElement => page.getElementById(id) as HTMLElement;
const linkSaying = (words: string): HTMLAnchorElement | undefined =>
  [...page.querySelectorAll("a")].find((one) => one.textContent?.trim() === words);

const readerSays = (...languages: string[]): void => {
  vi.stubGlobal("navigator", { languages });
};

beforeEach(() => {
  page = new JSDOM(HTML).window.document;
  vi.stubGlobal("document", page);
  readerSays("en-US");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the page's words", () => {
  it("are, before anything speaks, the English ones it falls back to, in text, links and labels", () => {
    expect(withEnglish(HTML), "run npm run words").toBe(HTML);
    expect(page.documentElement.lang).toBe("en");
  });

  it("name only words both languages have, as text", () => {
    const asked = [...page.querySelectorAll("*")].flatMap((one) =>
      [...one.attributes].filter(({ name }) => name.startsWith("data-say")).map(({ value }) => value),
    );
    expect(asked.length).toBeGreaterThan(50);
    for (const key of asked) {
      expect(typeof WORDS.en[key as "print"], key).toBe("string");
      expect(typeof WORDS.es[key as "print"], key).toBe("string");
    }
  });

  it("follow a Spanish document, and the page's lang says so", () => {
    readerSays("en-US");
    speak("es");
    expect(page.documentElement.lang).toBe("es");
    expect(byId("edit-in-tisty").textContent).toBe("Editar en Tisty");
    expect(byId("panels").getAttribute("aria-label")).toBe("Sobre este documento");
    expect(said().verdicts.holds).toBe("Firma válida");
    expect(page.querySelector(".brand-beta")?.getAttribute("title")).toContain("Folio está en beta");
  });

  it("follow an English document, even for a reader whose browser prefers Spanish", () => {
    readerSays("es-CL", "es");
    speak("en");
    expect(page.documentElement.lang).toBe("en");
    expect(byId("print").textContent).toBe("Print");
    expect(page.querySelector(".brand-beta")?.getAttribute("title")).toContain("Folio is in beta");
  });

  it("follow the reader when the document is in another language, and stay English when the reader says nothing", () => {
    readerSays("fr", "es-CL");
    speak("fr");
    expect(page.documentElement.lang).toBe("es");
    readerSays();
    speak("fr");
    expect(page.documentElement.lang).toBe("en");
  });

  it("send terms, privacy and security to the version in the language spoken", () => {
    speak("es");
    expect(linkSaying("Términos")?.href).toContain("/docs/TERMINOS.md");
    expect(linkSaying("Privacidad")?.href).toContain("/docs/PRIVACIDAD.md");
    expect(linkSaying("Seguridad")?.href).toContain("/docs/SEGURIDAD.md");
    speak("en");
    expect(linkSaying("Terms")?.href).toContain("/docs/TERMS.md");
    expect(linkSaying("Privacy")?.href).toContain("/docs/PRIVACY.md");
    expect(linkSaying("Security")?.href).toContain("/docs/SECURITY.md");
  });

  it("say in the details how the document is kept, and where to read how it works", () => {
    speak("es");
    expect(page.querySelector(".trust")?.textContent).toContain(
      "Cifrado de extremo a extremo (AES-256-GCM): el servidor guarda bytes que no puede leer.",
    );
    expect(linkSaying("Cómo funciona")?.href).toContain("/docs/SEGURIDAD.md");
    expect(page.querySelector("#panel-details .facts")?.textContent).toContain("Se borra solo el");
    speak("en");
    expect(page.querySelector(".trust")?.textContent).toContain("End-to-end encrypted (AES-256-GCM)");
    expect(linkSaying("How it works")?.href).toContain("/docs/SECURITY.md");
  });

  it("invite to install Tisty from the site in the language spoken", () => {
    speak("es");
    expect(linkSaying("Descargar Tisty")?.href).toBe("https://www.tisty.app/es/#install");
    expect(linkSaying("Conoce Tisty")?.href).toBe("https://www.tisty.app/es/");
    expect(page.querySelector(".page-foot-free")?.textContent).toBe("Gratis y de código abierto · Windows y macOS");
    speak("en");
    expect(linkSaying("Download Tisty")?.href).toBe("https://www.tisty.app/#install");
    expect(linkSaying("Meet Tisty")?.href).toBe("https://www.tisty.app/");
  });
});
