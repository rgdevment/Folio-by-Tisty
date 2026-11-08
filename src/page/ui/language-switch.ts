import { element } from "./frame";
import { said } from "./speak";

export interface LanguageSwitch {
  langs: string[];
  shown: string;
  missedTheReaders: boolean;
  choose: (lang: string) => Promise<boolean>;
}

// In its own language, so a reader who does not read the page's still finds theirs.
const nameOf = (lang: string): string => {
  try {
    const name = new Intl.DisplayNames([lang], { type: "language" }).of(lang) ?? lang;
    return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
  } catch {
    return lang || said().original;
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
  const told = element("language-said");
  select.replaceChildren(...langs.map(optionOf));
  select.value = shown;
  element("language-choice").hidden = false;
  if (missedTheReaders) told.textContent = said().missedTheReaders;
  let reading = shown;
  select.addEventListener("change", async () => {
    select.disabled = true;
    told.textContent = "";
    if (await choose(select.value)) reading = select.value;
    else {
      select.value = reading;
      told.textContent = said().couldNotSwitch;
    }
    select.disabled = false;
  });
};
