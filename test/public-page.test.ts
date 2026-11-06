import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(name, "utf8");
const PLACE = "src/public/page";
const HTML = read(`${PLACE}/index.html`);
const HEADERS = read(`${PLACE}/_headers`);
const WRANGLER = read("wrangler.public.toml");
const flat = HTML.replace(/\s+/g, " ");

describe("the public page", () => {
  it("says everything in both languages", () => {
    const inLanguage = (language: string) => HTML.match(new RegExp(`\\slang="${language}"`, "g"))?.length ?? 0;
    expect(inLanguage("en") + 1).toBe(inLanguage("es"));
  });

  it("does not contradict what Tisty says about Folio", () => {
    expect(flat).toContain(
      "Folio te permite compartir documentos en privado con quien quieras, con un link y cifrados de forma segura. Todavía no está disponible.",
    );
    expect(flat).toContain(
      "Folio lets you share documents privately with anyone, using an encrypted link. It isn't available yet.",
    );
  });

  it("loads nothing from anyone else", () => {
    const loaded = [...HTML.matchAll(/<(?:script|img)[^>]*\ssrc="([^"]+)"|<link[^>]*\shref="([^"]+)"/g)]
      .map(([, source, linked]) => source ?? linked)
      .filter((address) => address !== "https://folio.tisty.app/");
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((address) => address?.startsWith("/"))).toBe(true);
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
});
