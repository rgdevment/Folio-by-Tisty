import { element } from "./frame";

export interface LanguageSwitch {
  langs: string[];
  shown: string;
  missedTheReaders: boolean;
  choose: (lang: string) => Promise<boolean>;
}

const MISSED_THE_READERS = "No se pudo abrir el documento en tu idioma, así que lo ves en el idioma del link.";
const COULD_NOT_SWITCH = "No se pudo abrir ese idioma, así que sigues en este.";

// In its own language, so a reader who does not read the page's still finds theirs.
const nameOf = (lang: string): string => {
  try {
    const name = new Intl.DisplayNames([lang], { type: "language" }).of(lang) ?? lang;
    return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
  } catch {
    return lang || "Original";
  }
};

const optionOf = (lang: string): HTMLOptionElement => {
  const option = document.createElement("option");
  option.value = lang;
  option.textContent = nameOf(lang);
  return option;
};

export const offerLanguages = ({ langs, shown, missedTheReaders, choose }: LanguageSwitch): void => {
  const select = element<HTMLSelectElement>("language");
  const said = element("language-said");
  select.replaceChildren(...langs.map(optionOf));
  select.value = shown;
  element("language-choice").hidden = false;
  if (missedTheReaders) said.textContent = MISSED_THE_READERS;
  let reading = shown;
  select.addEventListener("change", async () => {
    select.disabled = true;
    said.textContent = "";
    if (await choose(select.value)) reading = select.value;
    else {
      select.value = reading;
      said.textContent = COULD_NOT_SWITCH;
    }
    select.disabled = false;
  });
};
