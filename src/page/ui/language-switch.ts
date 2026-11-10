import { element } from "./element";
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
  const missed = element("missed-the-readers");
  const couldNot = element("could-not-switch");
  select.replaceChildren(...langs.map(optionOf));
  select.value = shown;
  element("language-choice").hidden = false;
  missed.hidden = !missedTheReaders;
  let reading = shown;
  select.addEventListener("change", async () => {
    select.disabled = true;
    missed.hidden = couldNot.hidden = true;
    if (await choose(select.value)) reading = select.value;
    else {
      select.value = reading;
      couldNot.hidden = false;
    }
    select.disabled = false;
  });
};
