import { readFileSync } from "node:fs";

export interface OwnFont {
  name: string;
  package?: string;
  version?: string;
  falls_to?: string;
}

export type Packaged = OwnFont & { package: string; version: string; falls_to: string };

const SUBSETS = ["latin", "latin-ext"];

export const familyOf = (key: string): string => `own-${key}`;

const fileIn = (name: string, file: string): string => readFileSync(`node_modules/${name}/${file}`, "utf8");

const isPackaged = (font: OwnFont): font is Packaged =>
  font.package !== undefined && font.version !== undefined && font.falls_to !== undefined;

export const packaged = (fonts: Record<string, OwnFont>): [string, Packaged][] =>
  Object.entries(fonts).filter((one): one is [string, Packaged] => isPackaged(one[1]));

const said = (block: string, property: string): string => {
  const [, value] = new RegExp(`${property}:\\s*([^;]+);`).exec(block) ?? [];
  if (value === undefined) throw new Error(`a font face says no ${property}`);
  return value;
};

const faceOf = (key: string, { package: name }: Packaged, subset: string): string => {
  const file = `${name.slice(name.indexOf("/") + 1)}-${subset}-wght-normal`;
  const [, block] = new RegExp(`/\\* ${file} \\*/\\s*@font-face \\{([^}]+)\\}`).exec(fileIn(name, "index.css")) ?? [];
  if (block === undefined) throw new Error(`${name} has no ${file}`);
  return [
    `@font-face{font-family:${familyOf(key)};font-display:swap;font-weight:${said(block, "font-weight")};`,
    `src:url("${name}/files/${file}.woff2") format("woff2");unicode-range:${said(block, "unicode-range")}}`,
  ].join("");
};

// Declared in the page, since a shadow root ignores the fonts declared inside it.
export const fontFaces = (fonts: Record<string, OwnFont>): string =>
  packaged(fonts)
    .map(([key, font]) => {
      const { version } = JSON.parse(fileIn(font.package, "package.json")) as { version: string };
      if (version !== font.version)
        throw new Error(`${font.package} is ${version}, and the contract says ${font.version}`);
      return SUBSETS.map((subset) => faceOf(key, font, subset)).join("");
    })
    .join("");

export const fontLicenses = (fonts: Record<string, OwnFont>): string =>
  packaged(fonts)
    .map(([, { name, package: from, version }]) => `${name} (${from} ${version})\n\n${fileIn(from, "LICENSE")}`)
    .join("\n\n");
