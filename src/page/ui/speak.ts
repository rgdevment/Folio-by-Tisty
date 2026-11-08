import { readerSpeech } from "../languages";
import { WORDS, type Words } from "./words";

type Said = { [K in keyof Words]: Words[K] extends string ? K : never }[keyof Words];

// The page's own lang is the one record of the language chosen, which the reader's tools need anyway.
export const said = (page: Document = document): Words => WORDS[page.documentElement.lang === "es" ? "es" : "en"];

const fill = (words: Words, attribute: string, put: (one: HTMLElement, word: string) => void): void => {
  for (const one of document.querySelectorAll<HTMLElement>(`[data-say${attribute}]`)) {
    put(one, words[one.getAttribute(`data-say${attribute}`) as Said]);
  }
};

export const onSpeechChange = (run: () => void): void => {
  new MutationObserver(run).observe(document.documentElement, { attributeFilter: ["lang"] });
};

export const speak = (documentLang?: string): void => {
  const speech = readerSpeech(documentLang, navigator.languages ?? []);
  const words = WORDS[speech];
  if (document.documentElement.lang !== speech) document.documentElement.lang = speech;
  fill(words, "", (one, word) => {
    one.textContent = word;
  });
  fill(words, "-label", (one, word) => one.setAttribute("aria-label", word));
  fill(words, "-title", (one, word) => one.setAttribute("title", word));
  fill(words, "-href", (one, word) => one.setAttribute("href", word));
};
