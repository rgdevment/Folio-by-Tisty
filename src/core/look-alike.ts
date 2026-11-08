import type { Verdict } from "@tisty/contracts";

export interface Maker {
  root: string;
  name?: string;
  domain?: string;
}

export type Standing = "verified" | "imitates" | "takenBack" | "plain";

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

// A letter the table does not know stands for any one letter, so an unlisted look-alike still matches; a few at most, or a name in another script would match everything.
const sameShape = (alias: string, name: string): boolean => {
  const unknown = [...alias].filter((letter) => letter === UNKNOWN).length;
  return (
    alias.length === name.length &&
    unknown <= UNKNOWN_AT_MOST &&
    unknown < name.length &&
    [...alias].every((letter, at) => letter === UNKNOWN || letter === name[at])
  );
};

export const imitates = (alias: string, name: string): boolean => sameShape(skeleton(alias), skeleton(name));

const STILL_SPEAKS: Verdict[] = ["holds", "retired"];

export const standingOf = (root: string, verdict: Verdict, alias: string | undefined, maker?: Maker): Standing => {
  if (maker?.name === undefined) return "plain";
  if (root === maker.root) return STILL_SPEAKS.includes(verdict) ? "verified" : "takenBack";
  const names = [maker.name, ...(maker.domain === undefined ? [] : [maker.domain])];
  return alias !== undefined && names.some((name) => imitates(alias, name)) ? "imitates" : "plain";
};
