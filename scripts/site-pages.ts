import { posix } from "node:path";
import { micromark } from "micromark";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";

type Language = "en" | "es";
type Kind = "privacy" | "terms";

export interface Policy {
  kind: Kind;
  language: Language;
  source: string;
  path: string;
  description: string;
}

const SITE = "https://tisty.cl";
const REPOSITORY = "https://github.com/rgdevment/Folio-by-Tisty/blob/main";
const HOME: Record<Language, string> = { en: "/", es: "/es/" };

export const HOME_FILES: Record<Language, string> = {
  en: "src/page/public/home.html",
  es: "src/page/public/es/index.html",
};

export const POLICIES: Policy[] = [
  {
    kind: "privacy",
    language: "en",
    source: "PRIVACY.md",
    path: "/privacy/",
    description: "What Folio by Tisty keeps when you share or read a document, why, and for how long.",
  },
  {
    kind: "privacy",
    language: "es",
    source: "PRIVACIDAD.md",
    path: "/es/privacidad/",
    description: "Qué guarda Folio by Tisty cuando compartes o lees un documento, por qué y por cuánto tiempo.",
  },
  {
    kind: "terms",
    language: "en",
    source: "TERMS.md",
    path: "/terms/",
    description: "The terms for sharing and reading documents with Folio by Tisty.",
  },
  {
    kind: "terms",
    language: "es",
    source: "TERMINOS.md",
    path: "/es/terminos/",
    description: "Los términos para compartir y leer documentos con Folio by Tisty.",
  },
];

const policyOf = (kind: Kind, language: Language): Policy => {
  const policy = POLICIES.find((one) => one.kind === kind && one.language === language);
  if (!policy) throw new Error(`no ${kind} policy in ${language}`);
  return policy;
};

const escaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

// Throwing breaks the build when the home changes shape, instead of shipping a policy page without its header.
const swapped = (html: string, from: string, to: string): string => {
  if (!html.includes(from)) throw new Error(`the home no longer has ${from}`);
  return html.replace(from, to);
};

const partOf = (home: string, tag: "header" | "footer"): string => {
  const part = new RegExp(`<${tag} class="[^"]+">[\\s\\S]*?</${tag}>`).exec(home)?.[0];
  if (!part) throw new Error(`the home has no ${tag}`);
  return part;
};

const headerOf = (policy: Policy, home: string): string => {
  const header = partOf(home, "header");
  const inSpanish = swapped(
    header,
    '<a href="/es/" hreflang="es"',
    `<a href="${policyOf(policy.kind, "es").path}" hreflang="es"`,
  );
  return swapped(inSpanish, '<a href="/" hreflang="en"', `<a href="${policyOf(policy.kind, "en").path}" hreflang="en"`);
};

const footerOf = (policy: Policy, home: string): string =>
  swapped(partOf(home, "footer"), `<a href="${policy.path}">`, `<a href="${policy.path}" aria-current="page">`);

const addressOf = (target: string): string => {
  const [file = "", fragment] = target.split("#");
  const page = POLICIES.find((one) => one.source === file)?.path ?? `${REPOSITORY}/${posix.join("docs", file)}`;
  return fragment === undefined ? page : `${page}#${fragment}`;
};

const withSiteLinks = (html: string): string =>
  html.replace(/ href="(?![a-z][a-z0-9+.-]*:|#|\/)([^"]+)"/gi, (_, target: string) => ` href="${addressOf(target)}"`);

// As GitHub names them, so a link to a section of a policy works on both.
const slugOf = (heading: string): string =>
  heading
    .replace(/<[^>]+>|&[^;]+;/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replaceAll(" ", "-");

const withHeadingIds = (html: string): string => {
  const seen = new Map<string, number>();
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level: string, inner: string) => {
    const slug = slugOf(inner);
    const before = seen.get(slug) ?? 0;
    seen.set(slug, before + 1);
    return `<h${level} id="${before ? `${slug}-${before}` : slug}">${inner}</h${level}>`;
  });
};

const withScrollingTables = (html: string): string =>
  html.replaceAll("<table>", '<div class="table"><table>').replaceAll("</table>", "</table></div>");

export const policyPage = (policy: Policy, markdown: string, home: string): string => {
  const title = escaped(/^# (.+)$/m.exec(markdown)?.[1] ?? policy.source);
  const es = policyOf(policy.kind, "es");
  const en = policyOf(policy.kind, "en");
  const rendered = micromark(markdown, { extensions: [gfmTable()], htmlExtensions: [gfmTableHtml()] });
  return `<!doctype html>
<html lang="${policy.language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${escaped(policy.description)}" />
    <meta name="theme-color" content="#faf8f4" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0e0d0b" media="(prefers-color-scheme: dark)" />
    <meta name="referrer" content="same-origin" />
    <link rel="canonical" href="${SITE}${policy.path}" />
    <link rel="alternate" hreflang="es" href="${SITE}${es.path}" />
    <link rel="alternate" hreflang="en" href="${SITE}${en.path}" />
    <link rel="alternate" hreflang="x-default" href="${SITE}${en.path}" />
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="stylesheet" href="/site.css" />
  </head>
  <body>
    ${headerOf(policy, home)}

    <main class="policy">
${withScrollingTables(withHeadingIds(withSiteLinks(rendered)))}
    </main>

    ${footerOf(policy, home)}
  </body>
</html>
`;
};

const PAIRS: Record<Language, string>[] = [
  HOME,
  ...(["privacy", "terms"] as const).map((kind) => ({ en: policyOf(kind, "en").path, es: policyOf(kind, "es").path })),
];

export const sitemap = (): string => {
  const entries = PAIRS.flatMap((pair) =>
    [pair.en, pair.es].map(
      (path) => `  <url>
    <loc>${SITE}${path}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${SITE}${pair.en}"/>
    <xhtml:link rel="alternate" hreflang="es" href="${SITE}${pair.es}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${pair.en}"/>
  </url>`,
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join("\n")}
</urlset>
`;
};
