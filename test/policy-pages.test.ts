import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLICIES, type Policy, policyPage } from "../scripts/policy-pages";

const pageOf = (policy: Policy): string => policyPage(policy, readFileSync(`docs/${policy.source}`, "utf8"));
const linksIn = (html: string): string[] => [...html.matchAll(/\shref="([^"]+)"/g)].map(([, address]) => address ?? "");
const counterpart = (policy: Policy): Policy | undefined =>
  POLICIES.find((one) => one.kind === policy.kind && one.language !== policy.language);

describe("the policy pages of tisty.cl", () => {
  it("are the privacy policy and the terms, each in both languages", () => {
    expect(POLICIES.map(({ path }) => path).sort()).toEqual([
      "/es/privacidad/",
      "/es/terminos/",
      "/privacy/",
      "/terms/",
    ]);
    for (const policy of POLICIES) expect(counterpart(policy)).toBeDefined();
  });

  it.each(POLICIES)("$path says the repository's own words, version line included", (policy) => {
    const markdown = readFileSync(`docs/${policy.source}`, "utf8");
    const version = /^\*\*(.+)\*\*$/m.exec(markdown)?.[1];
    const html = pageOf(policy);
    expect(version).toBeDefined();
    expect(html).toContain(`<p><strong>${version}</strong></p>`);
    expect(html).toContain(`<title>${/^# (.+)$/m.exec(markdown)?.[1]}</title>`);
    expect(html).toContain(`<html lang="${policy.language}">`);
  });

  it.each(POLICIES)("$path is found at its own address, and names the other language", (policy) => {
    const html = pageOf(policy);
    const other = counterpart(policy);
    expect(html).toContain(`<link rel="canonical" href="https://tisty.cl${policy.path}" />`);
    expect(html).toContain(
      `<link rel="alternate" hreflang="${other?.language}" href="https://tisty.cl${other?.path}" />`,
    );
    expect(html).toMatch(new RegExp(`<a href="${policy.path}" hreflang="${policy.language}"[^>]*aria-current="page"`));
    expect(html).not.toMatch(/<meta\s+name="robots"/);
  });

  it.each(POLICIES)("$path keeps the policies on the site, and the rest of the repository on GitHub", (policy) => {
    const links = linksIn(pageOf(policy));
    expect(
      links.some((address) =>
        /Folio-by-Tisty\/blob\/main\/docs\/(PRIVACY|PRIVACIDAD|TERMS|TERMINOS)\.md$/.test(address),
      ),
    ).toBe(false);
    expect(links.every((address) => /^(\/|https:\/\/|mailto:)/.test(address))).toBe(true);
    expect(links).toContain(counterpart(policy)?.path);
  });

  it("sends the terms' licence to the repository", () => {
    const terms = POLICIES.find(({ path }) => path === "/terms/");
    expect(terms && linksIn(pageOf(terms))).toContain("https://github.com/rgdevment/Folio-by-Tisty/blob/main/LICENSE");
  });

  it.each(POLICIES)("$path loads nothing from anyone else and runs no script", (policy) => {
    const html = pageOf(policy);
    expect(html).not.toContain("<script");
    expect(html).toMatch(/<\/header>\s*<main class="policy">/);
    expect(html).toMatch(/<\/main>\s*<footer[\s>]/);
  });

  it("are in the sitemap, each beside its other language", () => {
    const sitemap = readFileSync("src/page/public/sitemap.xml", "utf8");
    for (const policy of POLICIES) {
      expect(sitemap).toContain(`<loc>https://tisty.cl${policy.path}</loc>`);
      expect(sitemap).toContain(`hreflang="${policy.language}" href="https://tisty.cl${policy.path}"`);
    }
  });

  it("are where the home, the missing page and the reader send a visitor", () => {
    const sent = [
      "src/page/public/home.html",
      "src/page/public/es/index.html",
      "src/page/public/404.html",
      "src/page/index.html",
    ]
      .map((page) => readFileSync(page, "utf8"))
      .join("");
    for (const policy of POLICIES) expect(sent).toContain(`href="${policy.path}"`);
    expect(sent).not.toMatch(/docs\/(PRIVACY|PRIVACIDAD|TERMS|TERMINOS)\.md/);
  });
});
