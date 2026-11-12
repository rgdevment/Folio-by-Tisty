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

const WORDS = {
  en: {
    home: "/",
    tisty: "https://www.tisty.app/",
    languages: "Language",
    privacy: "Privacy",
    terms: "Terms",
    code: "Code",
  },
  es: {
    home: "/es/",
    tisty: "https://www.tisty.app/es/",
    languages: "Idioma",
    privacy: "Privacidad",
    terms: "Términos",
    code: "Código",
  },
};

const policyOf = (kind: Kind, language: Language): Policy => {
  const policy = POLICIES.find((one) => one.kind === kind && one.language === language);
  if (!policy) throw new Error(`no ${kind} policy in ${language}`);
  return policy;
};

const escaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

const addressOf = (target: string): string =>
  POLICIES.find((one) => one.source === target)?.path ?? `${REPOSITORY}/${posix.join("docs", target)}`;

const withSiteLinks = (markdown: string): string =>
  markdown.replace(/\]\((?![a-z]+:|#)([^)\s]+)\)/g, (_, target: string) => `](${addressOf(target)})`);

export const policyPage = (policy: Policy, markdown: string): string => {
  const words = WORDS[policy.language];
  const title = escaped(/^# (.+)$/m.exec(markdown)?.[1] ?? policy.source);
  const es = policyOf(policy.kind, "es");
  const en = policyOf(policy.kind, "en");
  const current = (shown: boolean): string => (shown ? ' aria-current="page"' : "");
  const article = micromark(withSiteLinks(markdown), { extensions: [gfmTable()], htmlExtensions: [gfmTableHtml()] });
  return `<!doctype html>
<html lang="${policy.language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${escaped(policy.description)}" />
    <meta name="theme-color" content="#faf8f4" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0e0d0b" media="(prefers-color-scheme: dark)" />
    <link rel="canonical" href="${SITE}${policy.path}" />
    <link rel="alternate" hreflang="es" href="${SITE}${es.path}" />
    <link rel="alternate" hreflang="en" href="${SITE}${en.path}" />
    <link rel="alternate" hreflang="x-default" href="${SITE}${en.path}" />
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="stylesheet" href="/site.css" />
  </head>
  <body>
    <header class="top">
      <a class="brand" href="${words.home}">
        <img src="/icon.svg" alt="" width="28" height="28" />
        <span>Folio <small>by Tisty</small></span>
      </a>
      <nav class="languages" aria-label="${words.languages}">
        <a href="${es.path}" hreflang="es" lang="es" aria-label="Español"${current(policy === es)}>ES</a>
        <a href="${en.path}" hreflang="en" lang="en" aria-label="English"${current(policy === en)}>EN</a>
      </nav>
    </header>

    <main class="policy">
${article}
    </main>

    <footer class="bottom">
      <a href="${words.tisty}">Tisty</a>
      <a href="${policyOf("privacy", policy.language).path}"${current(policy.kind === "privacy")}>${words.privacy}</a>
      <a href="${policyOf("terms", policy.language).path}"${current(policy.kind === "terms")}>${words.terms}</a>
      <a href="${words.tisty}">${words.code}</a>
    </footer>
  </body>
</html>
`;
};
