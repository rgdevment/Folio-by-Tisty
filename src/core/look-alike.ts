import type { Verdict } from "@tisty/contracts";

export interface Maker {
  root: string;
  name?: string;
  domain?: string;
}

export type Standing = "verified" | "imitates" | "plain";

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

const skeleton = (said: string): string =>
  [...said.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")]
    .map((letter) => LOOKS_LATIN[letter] ?? letter)
    .join("")
    .replace(/[^a-z0-9]/g, "")
    .replaceAll("rn", "m")
    .replaceAll("vv", "w");

export const imitates = (alias: string, name: string): boolean => skeleton(alias) === skeleton(name);

const STILL_SPEAKS: Verdict[] = ["holds", "retired"];

export const standingOf = (root: string, verdict: Verdict, alias: string | undefined, maker?: Maker): Standing => {
  if (maker?.name === undefined) return "plain";
  if (root === maker.root) return STILL_SPEAKS.includes(verdict) ? "verified" : "plain";
  return alias !== undefined && imitates(alias, maker.name) ? "imitates" : "plain";
};
