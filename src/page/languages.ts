import type { Translation } from "@tisty/contracts";

type Matching = (lang: string, wanted: string) => boolean;

const primaryOf = (lang: string): string => lang.toLowerCase().split("-")[0] ?? "";

const sameLanguage: Matching = (lang, wanted) => lang.toLowerCase() === wanted.toLowerCase();

const sameFamily: Matching = (lang, wanted) => primaryOf(lang) === primaryOf(wanted);

export const preferredTranslation = (
  wanted: readonly string[],
  anchorLang: string | undefined,
  translations: readonly Translation[],
): Translation | undefined => {
  for (const one of wanted) {
    for (const matches of [sameLanguage, sameFamily]) {
      if (anchorLang !== undefined && matches(anchorLang, one)) return undefined;
      const found = translations.find(({ lang }) => matches(lang, one));
      if (found) return found;
    }
  }
  return undefined;
};
