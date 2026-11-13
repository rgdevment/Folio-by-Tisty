import { existsSync, readdirSync, readFileSync } from "node:fs";
import { CONTRACTS } from "@tisty/contracts";
import { defineConfig, type Plugin } from "vite";
import { HOME_FILES, POLICIES, policyPage, sitemap } from "./scripts/site-pages";

const TOKENS = "virtual:tisty-tokens.css";
const RESOLVED_TOKENS = `\0${TOKENS}`;

type Theme = "light" | "dark";
type Themed<T> = Record<Theme, T>;

interface Idea {
  fill: Themed<Record<string, string>>;
  ink: Themed<string>;
  pins: Themed<string[]>;
  tape: Themed<string>;
}

interface StyleValues {
  colors: Themed<Record<string, string>>;
  callouts: { idea: Idea };
}

const variables = ({ light, dark }: StyleValues["colors"]): string =>
  Object.entries(light)
    .map(([name, value]) => {
      const night = dark[name];
      if (night === undefined) throw new Error(`the style contract gives --tisty-${name} no dark colour`);
      return `--tisty-${name}:light-dark(${value},${night});`;
    })
    .join("");

const ideaColors = ({ fill, ink, pins, tape }: Idea, theme: Theme): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(fill[theme]).map(([hue, value]) => [`idea-${hue}`, value])),
  ...Object.fromEntries(pins[theme].map((value, at) => [`idea-pin-${at}`, value])),
  "idea-ink": ink[theme],
  "idea-tape": tape[theme],
});

const colorsOf = ({ colors, callouts }: StyleValues): StyleValues["colors"] => ({
  light: { ...colors.light, ...ideaColors(callouts.idea, "light") },
  dark: { ...colors.dark, ...ideaColors(callouts.idea, "dark") },
});

// The colors come from the contract when building, so they change with it and no copy of them is kept here.
const tokens = (): Plugin => ({
  name: "tisty-tokens",
  resolveId: (id) => (id === TOKENS ? RESOLVED_TOKENS : null),
  load(id) {
    if (id !== RESOLVED_TOKENS) return null;
    return `:root{${variables(colorsOf((CONTRACTS.style as { values: StyleValues }).values))}}`;
  },
});

const dompurifyFile = (name: string): string => readFileSync(`node_modules/dompurify/${name}`, "utf8");
const contractFile = (name: string): string => readFileSync(`node_modules/@tisty/contracts/${name}`, "utf8");

// Folio, DOMPurify and the contract travel minified in what every reader downloads, and their licenses ask for their notices to go with them.
const licenses = (): Plugin => ({
  name: "folio-licenses",
  generateBundle() {
    const { version } = JSON.parse(dompurifyFile("package.json")) as { version: string };
    const contract = JSON.parse(contractFile("package.json")) as { version: string };
    this.emitFile({
      type: "asset",
      fileName: "licenses.txt",
      source: `Folio by Tisty, Copyright 2026 Mario Hidalgo G. (rgdevment)\nUnder FSL-1.1-ALv2: https://github.com/rgdevment/Folio-by-Tisty/blob/main/LICENSE\n\nDOMPurify ${version}, (c) Cure53 and other contributors\nUnder Apache-2.0 or MPL-2.0, at your choice.\nSource: https://github.com/cure53/DOMPurify\n\n${dompurifyFile("LICENSE")}\n${dompurifyFile("LICENSE-MPL")}\n\n@tisty/contracts ${contract.version}, (c) Mario Hidalgo G. (rgdevment)\nUnder AGPL-3.0-only, with the additional permission that lets Folio include it.\nSource: https://github.com/rgdevment/Tisty\n\n${contractFile("ADDITIONAL-PERMISSION.md")}\n${contractFile("LICENSE")}`,
    });
  },
});

// A checkout of the domains branch, made only by deploy.yml; without one the page carries no shard.
const SHARDS = process.env.FOLIO_DOMAINS;

const shardNames = (): string[] =>
  SHARDS && existsSync(SHARDS) ? readdirSync(SHARDS).filter((one) => /^[0-9a-f]{2}\.json$/.test(one)) : [];

const domains = (): Plugin => ({
  name: "folio-domains",
  generateBundle() {
    for (const name of shardNames()) {
      this.emitFile({ type: "asset", fileName: `domains/${name}`, source: readFileSync(`${SHARDS}/${name}`, "utf8") });
    }
  },
});

// Rendered from docs/ at every build, so the site cannot say other words than the policies in the repository.
const sitePages = (): Plugin => ({
  name: "folio-site-pages",
  generateBundle() {
    for (const policy of POLICIES) {
      this.emitFile({
        type: "asset",
        fileName: `${policy.path.slice(1)}index.html`,
        source: policyPage(
          policy,
          readFileSync(`docs/${policy.source}`, "utf8"),
          readFileSync(HOME_FILES[policy.language], "utf8"),
        ),
      });
    }
    this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap() });
  },
});

export default defineConfig({
  root: "src/page",
  plugins: [tokens(), licenses(), domains(), sitePages()],
  define: { __FOLIO_SHARDS__: JSON.stringify(shardNames().map((name) => name.slice(0, 2))) },
  build: {
    outDir: "../../dist/page",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});
