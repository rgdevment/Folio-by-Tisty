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
    ["r\u0261devment"],
    ["rg\u0501evment"],
    ["r\u0261\u0501evment"],
    ["rgdeevment"],
    ["rgdvment"],
    ["rgdevmnet"],
    ["rgdevvment"],
    ["rgdevments"],
    ["xgdevment"],
  ])("catches %j", (alias) => {
    expect(imitates(alias, "rgdevment")).toBe(true);
  });

  it.each([
    ["Ana"],
    ["rgdev"],
    ["devment"],
    ["rgdevmentor"],
    [""],
    ["\u96e8".repeat(9)],
    ["\u0436\u0436\u0436devment"],
    ["\u0410\u043d\u043d\u0430"],
    ["\u041c\u0430\u0440\u0456\u044f"],
  ])("lets %j be", (alias) => {
    expect(imitates(alias, "rgdevment")).toBe(false);
  });

  it("lets two unknown letters stand in, never three", () => {
    expect(imitates("r\u0261\u0501evment", "rgdevment")).toBe(true);
    expect(imitates("r\u0261\u0501\u0436vment", "rgdevment")).toBe(false);
  });

  it("asks a short name to match whole, since one slip would catch too many", () => {
    expect(imitates("anna", "ana")).toBe(false);
    expect(imitates("ANA", "ana")).toBe(true);
  });
});

describe("how a root stands", () => {
  it("is verified when the maker's root signs and its signature still speaks", () => {
    expect(standingOf(MAKER.root, "holds", "anything", MAKER)).toBe("verified");
    expect(standingOf(MAKER.root, "retired", undefined, MAKER)).toBe("verified");
  });

  it("is not verified on a doubtful signature, even from the maker's root", () => {
    expect(standingOf(MAKER.root, "doubtful", "rgdevment", MAKER)).toBe("takenBack");
  });

  it("imitates when another root goes by the maker's name or its domain", () => {
    expect(standingOf(OTHER, "holds", "rgdevrnent", MAKER)).toBe("imitates");
    expect(standingOf(OTHER, "holds", "rgdevment.dev", MAKER)).toBe("imitates");
    expect(standingOf(OTHER, "holds", "RG-DEVMENT.DEV", MAKER)).toBe("imitates");
  });

  it("goes by the domain when the maker names no name", () => {
    const nameless = { root: MAKER.root, domain: MAKER.domain };
    expect(standingOf(MAKER.root, "holds", "anything", nameless)).toBe("verified");
    expect(standingOf(OTHER, "holds", "rgdevment.dev", nameless)).toBe("imitates");
  });

  it("is plain for any other name, no name, or no named maker", () => {
    expect(standingOf(OTHER, "holds", "Ana", MAKER)).toBe("plain");
    expect(standingOf(OTHER, "holds", undefined, MAKER)).toBe("plain");
    expect(standingOf(MAKER.root, "holds", "rgdevment", { root: MAKER.root })).toBe("plain");
    expect(standingOf(OTHER, "holds", "rgdevment", undefined)).toBe("plain");
  });
});
