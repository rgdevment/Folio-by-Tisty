import { describe, expect, it } from "vitest";
import { imitates, standingOf } from "../src/core/look-alike";

const MAKER = { root: "R".repeat(43), name: "rgdevment", domain: "rgdevment.dev" };
const OTHER = "O".repeat(43);

describe("a name that imitates the maker's", () => {
  it.each([
    ["rgdevment"],
    ["RGDEVMENT"],
    ["rg-devment"],
    ["rg devment"],
    ["rgdevrnent"],
    ["rgd\u0435vment"],
    ["rgdevm\u0435nt"],
    ["rgdev\u03bdment".replace("v\u03bd", "\u03bd")],
    ["rgdevm\u00e9nt"],
    ["rgdevment\u200b"],
  ])("catches %j", (alias) => {
    expect(imitates(alias, "rgdevment")).toBe(true);
  });

  it.each([["Ana"], ["rgdev"], ["rgdevments"], ["devment"], [""]])("lets %j be", (alias) => {
    expect(imitates(alias, "rgdevment")).toBe(false);
  });
});

describe("how a root stands", () => {
  it("is verified when the maker's root signs and its signature still speaks", () => {
    expect(standingOf(MAKER.root, "holds", "anything", MAKER)).toBe("verified");
    expect(standingOf(MAKER.root, "retired", undefined, MAKER)).toBe("verified");
  });

  it("is not verified on a doubtful signature, even from the maker's root", () => {
    expect(standingOf(MAKER.root, "doubtful", "rgdevment", MAKER)).toBe("plain");
  });

  it("imitates when another root goes by the maker's name", () => {
    expect(standingOf(OTHER, "holds", "rgdevrnent", MAKER)).toBe("imitates");
  });

  it("is plain for any other name, no name, or no named maker", () => {
    expect(standingOf(OTHER, "holds", "Ana", MAKER)).toBe("plain");
    expect(standingOf(OTHER, "holds", undefined, MAKER)).toBe("plain");
    expect(standingOf(MAKER.root, "holds", "rgdevment", { root: MAKER.root })).toBe("plain");
    expect(standingOf(OTHER, "holds", "rgdevment", undefined)).toBe("plain");
  });
});
