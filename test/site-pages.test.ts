import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOME_FILES, POLICIES, type Policy, policyPage, sitemap } from "../scripts/site-pages";

const read = (name: string): string => readFileSync(name, "utf8");
const homeOf = (policy: Policy): string => read(HOME_FILES[policy.language]);
const pageOf = (policy: Policy): string => policyPage(policy, read(`docs/${policy.source}`), homeOf(policy));
const linksIn = (html: string): string[] => [...html.matchAll(/\shref="([^"]+)"/g)].map(([, address]) => address ?? "");
const counterpart = (policy: Policy): Policy | undefined =>
  POLICIES.find((one) => one.kind === policy.kind && one.language !== policy.language);
const partOf = (html: string, tag: string): string =>
  new RegExp(`<${tag} class="[^"]+">[\\s\\S]*?</${tag}>`).exec(html)?.[0] ?? "";
const policyAt = (path: string): Policy => {
  const policy = POLICIES.find((one) => one.path === path);
  if (!policy) throw new Error(`no policy at ${path}`);
  return policy;
};

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
    const markdown = read(`docs/${policy.source}`);
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

  it.each(POLICIES)("$path takes its header and footer from the home in its language", (policy) => {
    const html = pageOf(policy);
    const other = counterpart(policy);
    const home = homeOf(policy);
    const homePath = policy.language === "es" ? "/es/" : "/";
    const otherHomePath = policy.language === "es" ? "/" : "/es/";
    expect(partOf(html, "header")).toBe(
      partOf(home, "header")
        .replace(
          `<a href="${homePath}" hreflang="${policy.language}"`,
          `<a href="${policy.path}" hreflang="${policy.language}"`,
        )
        .replace(
          `<a href="${otherHomePath}" hreflang="${other?.language}"`,
          `<a href="${other?.path}" hreflang="${other?.language}"`,
        ),
    );
    expect(partOf(html, "footer")).toBe(
      partOf(home, "footer").replace(`<a href="${policy.path}">`, `<a href="${policy.path}" aria-current="page">`),
    );
  });

  it("break the build when the home no longer has the header they take", () => {
    const policy = policyAt("/terms/");
    expect(() => policyPage(policy, "# Terms\n", "<main></main>")).toThrow(/header/);
  });

  it.each(POLICIES)("$path keeps the policies on the site, and the rest of the repository on GitHub", (policy) => {
    const links = linksIn(pageOf(policy));
    expect(
      links.some((address) =>
        /Folio-by-Tisty\/blob\/main\/docs\/(PRIVACY|PRIVACIDAD|TERMS|TERMINOS)\.md/.test(address),
      ),
    ).toBe(false);
    expect(links.every((address) => /^(\/|https:\/\/|mailto:|#)/.test(address))).toBe(true);
    expect(links).toContain(counterpart(policy)?.path);
  });

  it("sends the terms' licence to the repository", () => {
    expect(linksIn(pageOf(policyAt("/terms/")))).toContain(
      "https://github.com/rgdevment/Folio-by-Tisty/blob/main/LICENSE",
    );
  });

  it("follows a policy's links in every form Markdown writes them, and leaves code as written", () => {
    const policy = policyAt("/es/privacidad/");
    const markdown = [
      "# Privacidad",
      '[secciones](TERMINOS.md#reportes-y-retiro), [con título](TERMS.md "Terms") y [por referencia][ref].',
      "[seguridad](SEGURIDAD.md#fallas) y [aquí](#qué-guarda).",
      "`[sin tocar](TERMINOS.md)`",
      "[ref]: PRIVACY.md",
    ].join("\n\n");
    const html = policyPage(policy, markdown, homeOf(policy));
    expect(linksIn(html)).toEqual(
      expect.arrayContaining([
        "/es/terminos/#reportes-y-retiro",
        "/terms/",
        "/privacy/",
        "https://github.com/rgdevment/Folio-by-Tisty/blob/main/docs/SEGURIDAD.md#fallas",
        "#qu%C3%A9-guarda",
      ]),
    );
    expect(html).toContain("<code>[sin tocar](TERMINOS.md)</code>");
  });

  it("names each section as GitHub does, so a link to one works on both", () => {
    const policy = policyAt("/es/privacidad/");
    const html = policyPage(
      policy,
      "# Privacidad\n\n## Qué guarda, y por cuánto tiempo\n\n## Notas\n\n## Notas\n",
      homeOf(policy),
    );
    expect(html).toContain('<h2 id="qué-guarda-y-por-cuánto-tiempo">');
    expect(html).toContain('<h2 id="notas">');
    expect(html).toContain('<h2 id="notas-1">');
  });

  it.each(POLICIES)("$path lists its sections beside the text, in order, each leading to its own", (policy) => {
    const html = pageOf(policy);
    const contents = /<nav class="contents"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    const article = /<article>([\s\S]*?)<\/article>/.exec(html)?.[1] ?? "";
    const headings = [...article.matchAll(/<h2 id="([^"]+)">/g)].map(([, id]) => `#${id}`);
    expect(headings.length).toBeGreaterThan(3);
    expect(linksIn(contents)).toEqual(headings);
    expect(contents).toContain(policy.language === "es" ? "En esta página" : "On this page");
    expect(html).toMatch(/<main class="policy">\s*<nav class="contents"[\s\S]*<\/nav>\s*<article>/);
  });

  it.each(POLICIES)("$path keeps each table a table, inside a box that scrolls on a narrow screen", (policy) => {
    const html = pageOf(policy);
    const tables = html.match(/<table>/g)?.length ?? 0;
    expect(html.match(/<div class="table"><table>/g)?.length ?? 0).toBe(tables);
    expect(read("src/page/public/site.css")).not.toMatch(/\.policy table \{[^}]*display:/);
  });

  it.each(POLICIES)("$path loads nothing from anyone else and runs no script", (policy) => {
    const html = pageOf(policy);
    const loaded = [
      ...html.matchAll(
        /<(?:script|img)[^>]*\ssrc="([^"]+)"|<link(?![^>]*\srel="(?:canonical|alternate)")[^>]*\shref="([^"]+)"/g,
      ),
    ].map(([, source, linked]) => source ?? linked);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((address) => address?.startsWith("/"))).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).toContain('<meta name="referrer" content="same-origin" />');
    expect(html).toMatch(/<\/header>\s*<main class="policy">/);
    expect(html).toMatch(/<\/main>\s*<footer[\s>]/);
  });

  it("are where the home, the missing page and the reader send a visitor", () => {
    const sent = [
      "src/page/public/home.html",
      "src/page/public/es/index.html",
      "src/page/public/404.html",
      "src/page/index.html",
    ]
      .map(read)
      .join("");
    for (const policy of POLICIES) expect(sent).toContain(`href="${policy.path}"`);
    expect(sent).not.toMatch(/docs\/(PRIVACY|PRIVACIDAD|TERMS|TERMINOS)\.md/);
  });
});

describe("the sitemap of tisty.cl", () => {
  const map = sitemap();

  it.each([
    ["/", "/es/"],
    ["/privacy/", "/es/privacidad/"],
    ["/terms/", "/es/terminos/"],
  ])("lists %s and %s, each beside the other", (english, spanish) => {
    for (const path of [english, spanish]) {
      const entry = new RegExp(`<url>\\s*<loc>https://tisty.cl${path}</loc>([\\s\\S]*?)</url>`).exec(map)?.[1] ?? "";
      expect(entry).toContain(`hreflang="en" href="https://tisty.cl${english}"`);
      expect(entry).toContain(`hreflang="es" href="https://tisty.cl${spanish}"`);
      expect(entry).toContain(`hreflang="x-default" href="https://tisty.cl${english}"`);
    }
  });

  it("is the one robots.txt names, and the build makes it", () => {
    expect(read("src/page/public/robots.txt")).toContain("Sitemap: https://tisty.cl/sitemap.xml");
    expect(read("vite.config.ts")).toContain('fileName: "sitemap.xml", source: sitemap()');
    expect(map.match(/<url>/g)).toHaveLength(6);
  });
});
