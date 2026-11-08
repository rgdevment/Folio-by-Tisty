import { existsSync, readdirSync, readFileSync } from "node:fs";
import { CONTRACTS } from "@tisty/contracts";
import { defineConfig, type Plugin } from "vite";

const TOKENS = "virtual:tisty-tokens.css";
const RESOLVED_TOKENS = `\0${TOKENS}`;

interface StyleValues {
  colors: { light: Record<string, string>; dark: Record<string, string> };
}

const variables = ({ light, dark }: StyleValues["colors"]): string =>
  Object.entries(light)
    .map(([name, value]) => `--tisty-${name}:light-dark(${value},${dark[name]});`)
    .join("");

// The colors come from the contract when building, so they change with it and no copy of them is kept here.
const tokens = (): Plugin => ({
  name: "tisty-tokens",
  resolveId: (id) => (id === TOKENS ? RESOLVED_TOKENS : null),
  load(id) {
    if (id !== RESOLVED_TOKENS) return null;
    const { colors } = (CONTRACTS.style as { values: StyleValues }).values;
    return `:root{${variables(colors)}}`;
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

const SHARDS = "docs/domains";

const domains = (): Plugin => ({
  name: "folio-domains",
  generateBundle() {
    if (!existsSync(SHARDS)) return;
    for (const name of readdirSync(SHARDS).filter((one) => /^[0-9a-f]{2}\.json$/.test(one))) {
      this.emitFile({ type: "asset", fileName: `domains/${name}`, source: readFileSync(`${SHARDS}/${name}`, "utf8") });
    }
  },
});

export default defineConfig({
  root: "src/page",
  plugins: [tokens(), licenses(), domains()],
  build: {
    outDir: "../../dist/page",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});
