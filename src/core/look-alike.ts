import type { Verdict } from "@tisty/contracts";

export interface Maker {
  root: string;
  name?: string;
  domain?: string;
}

export type Standing = "verified" | "imitates" | "takenBack" | "checked" | "plain";

const LOOKS_LATIN: Record<string, string> = {
  а: "a",
  в: "b",
  г: "r",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  μ: "m",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  "0": "o",
  "1": "i",
  l: "i",
  "3": "e",
  "5": "s",
};

const UNKNOWN = "?";
const UNKNOWN_AT_MOST = 2;

const skeleton = (said: string): string =>
  [...said.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")]
    .map((letter) => LOOKS_LATIN[letter] ?? letter)
    .map((letter) => (/[a-z0-9]/.test(letter) ? letter : /[\p{L}\p{N}]/u.test(letter) ? UNKNOWN : ""))
    .join("")
    .replaceAll("rn", "m")
    .replaceAll("vv", "w");

const LONG_ENOUGH_FOR_A_SLIP = 6;

const same = (alias: string | undefined, name: string | undefined): boolean => alias === UNKNOWN || alias === name;

const slipsApart = (alias: string, name: string): number => {
  const rows = [...Array(alias.length + 1)].map((_, at) => [at, ...Array(name.length).fill(0)] as number[]);
  for (let column = 0; column <= name.length; column += 1) (rows[0] as number[])[column] = column;
  for (let row = 1; row <= alias.length; row += 1) {
    for (let column = 1; column <= name.length; column += 1) {
      const here = rows[row] as number[];
      const above = rows[row - 1] as number[];
      const cost = same(alias[row - 1], name[column - 1]) ? 0 : 1;
      here[column] = Math.min(
        (above[column] as number) + 1,
        (here[column - 1] as number) + 1,
        (above[column - 1] as number) + cost,
      );
      const swapped =
        row > 1 && column > 1 && same(alias[row - 1], name[column - 2]) && same(alias[row - 2], name[column - 1]);
      if (swapped)
        here[column] = Math.min(here[column] as number, ((rows[row - 2] as number[])[column - 2] as number) + 1);
    }
  }
  return (rows[alias.length] as number[])[name.length] as number;
};

// A letter the table does not know stands for any one letter, so an unlisted look-alike still matches; a few at most, or a name in another script would match everything.
const looksLike = (alias: string, name: string): boolean => {
  const unknown = [...alias].filter((letter) => letter === UNKNOWN).length;
  if (unknown > UNKNOWN_AT_MOST || unknown >= name.length - 1) return false;
  return slipsApart(alias, name) <= (name.length >= LONG_ENOUGH_FOR_A_SLIP ? 1 : 0);
};

export const imitates = (alias: string, name: string): boolean => looksLike(skeleton(alias), skeleton(name));

const STILL_SPEAKS: Verdict[] = ["holds", "retired"];

export const stillSpeaks = (verdict: Verdict): boolean => STILL_SPEAKS.includes(verdict);

export const shownNameOf = (maker: Maker): string | undefined => maker.name ?? maker.domain;

export const standingOf = (root: string, verdict: Verdict, alias: string | undefined, maker?: Maker): Standing => {
  if (maker === undefined || shownNameOf(maker) === undefined) return "plain";
  if (root === maker.root) return stillSpeaks(verdict) ? "verified" : "takenBack";
  const names = [maker.name, maker.domain].filter((name) => name !== undefined);
  return alias !== undefined && names.some((name) => imitates(alias, name)) ? "imitates" : "plain";
};
