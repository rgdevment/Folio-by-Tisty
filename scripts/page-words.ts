import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORDS } from "../src/page/ui/words.ts";

const PAGE = resolve(fileURLToPath(new URL("../src/page/index.html", import.meta.url)));
const ATTRIBUTES: Record<string, string> = {
  "data-say-href": "href",
  "data-say-label": "aria-label",
  "data-say-title": "title",
};
const TAG_ASKING = /<\w+\b[^>]*\bdata-say[-\w]*="\w+"[^>]*>/g;
const TEXT_ASKED = /(<(\w+)\b[^>]*\bdata-say="(\w+)"[^>]*>)[^<]*(<\/\2>)/g;

const escaped = (said: string): string =>
  said.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const englishOf = (key: string): string => {
  const word = (WORDS.en as Record<string, unknown>)[key];
  if (typeof word !== "string") throw new Error(`words.ts has no English text for ${key}`);
  return escaped(word);
};

const withAttributes = (tag: string): string =>
  Object.entries(ATTRIBUTES).reduce((written, [asking, attribute]) => {
    const asked = new RegExp(`\\b${asking}="(\\w+)"`).exec(written);
    if (!asked) return written;
    const without = written.replace(new RegExp(`\\s${attribute}="[^"]*"`), "");
    return without.replace(asked[0], `${attribute}="${englishOf(asked[1] as string)}" ${asked[0]}`);
  }, tag);

export const withEnglish = (html: string): string =>
  html
    .replace(TAG_ASKING, withAttributes)
    .replace(
      TEXT_ASKED,
      (_all, open: string, _tag: string, key: string, close: string) => `${open}${englishOf(key)}${close}`,
    );

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(PAGE, withEnglish(readFileSync(PAGE, "utf8")));
  console.log(`wrote the English words into ${PAGE}`);
}
