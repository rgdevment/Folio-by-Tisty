import type { Translation } from "@tisty/contracts";
import { describe, expect, it } from "vitest";
import { preferredTranslation } from "../src/page/languages";

const ENGLISH: Translation = { lang: "en", document: "enWords1", key: "ENKEY" };
const BRAZILIAN: Translation = { lang: "pt-BR", document: "ptWords1" };
const FRENCH: Translation = { lang: "fr", document: "frWords1" };
const GROUP = [ENGLISH, BRAZILIAN, FRENCH];

describe("the language a reader is shown", () => {
  it("is the first the reader prefers that the group has, in the browser's order", () => {
    expect(preferredTranslation(["de", "fr", "en"], "es", GROUP)).toBe(FRENCH);
  });

  it("stays the anchor's when the anchor comes first in the reader's order", () => {
    expect(preferredTranslation(["es", "en"], "es", GROUP)).toBeUndefined();
  });

  it("is found by its primary subtag, either way round", () => {
    expect(preferredTranslation(["en-GB"], "es", GROUP)).toBe(ENGLISH);
    expect(preferredTranslation(["pt"], "es", GROUP)).toBe(BRAZILIAN);
    expect(preferredTranslation(["es-CL", "en"], "es", GROUP)).toBeUndefined();
  });

  it("takes the exact tag over one that only shares its primary subtag", () => {
    const portuguese: Translation = { lang: "pt-PT", document: "ptWords2" };
    expect(preferredTranslation(["pt-PT"], "es", [BRAZILIAN, portuguese])).toBe(portuguese);
  });

  it("ignores case, as language tags do", () => {
    expect(preferredTranslation(["PT-br"], "es", GROUP)).toBe(BRAZILIAN);
  });

  it("falls back to the anchor when the group has none of the reader's", () => {
    expect(preferredTranslation(["de", "it"], "es", GROUP)).toBeUndefined();
  });

  it("falls back to the anchor when there are no other languages, or no preferences", () => {
    expect(preferredTranslation(["en"], "es", [])).toBeUndefined();
    expect(preferredTranslation([], "es", GROUP)).toBeUndefined();
  });

  it("still finds a translation when the anchor says no language", () => {
    expect(preferredTranslation(["en"], undefined, GROUP)).toBe(ENGLISH);
  });
});
