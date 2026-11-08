import { describe, expect, it } from "vitest";
import { type Lookup, recordName } from "../scripts/dns";
import { domainFaults, makerFaults } from "../scripts/limits-maker";

const ROOT = "A".repeat(43);
const MAKER = { root: ROOT, name: "rgdevment", domain: "rgdevment.dev" };
const answering =
  (texts: string[] | null, other: string[] | null = texts): Lookup =>
  async (resolver) =>
    resolver === "1.1.1.1" ? texts : other;

describe("the maker in the limits", () => {
  it("may be missing, or say only its root", () => {
    expect(makerFaults(undefined)).toEqual([]);
    expect(makerFaults({ root: ROOT })).toEqual([]);
    expect(makerFaults(MAKER)).toEqual([]);
  });

  it.each([["A".repeat(42)], [`${"A".repeat(42)}=`], [""], [1]])("refuses %j as its root", (root) => {
    expect(makerFaults({ root })).toEqual(["maker.root is not a root"]);
  });

  it.each([["RGdevment"], ["rg devment"], ["-rgdevment"], ["rgdevment-"], ["a".repeat(33)], [""]])(
    "refuses %j as its name",
    (name) => {
      expect(makerFaults({ root: ROOT, name })).toEqual(["maker.name is not a name"]);
    },
  );

  it.each([
    ["RGdevment.dev"],
    ["rgdevment"],
    ["rgdévment.dev"],
    ["rgdevment.dev."],
    ["-rg.dev"],
    ["https://rgdevment.dev"],
  ])("refuses %j as its domain", (domain) => {
    expect(makerFaults({ root: ROOT, domain })).toEqual(["maker.domain is not a lowercase ASCII domain"]);
  });

  it("takes a domain under a two-part suffix, and one in punycode", () => {
    expect(makerFaults({ root: ROOT, domain: "rgdevment.com.cl" })).toEqual([]);
    expect(makerFaults({ root: ROOT, domain: "xn--rgdvment-k1a.dev" })).toEqual([]);
  });

  it("refuses what is not an object, and what a maker does not have", () => {
    expect(makerFaults("rgdevment")).toEqual(["maker is not an object"]);
    expect(makerFaults({ root: ROOT, mail: "x" })).toEqual(["maker.mail is not something the maker has"]);
  });
});

describe("the maker's domain", () => {
  it("holds when both resolvers find the one record naming its root", async () => {
    expect(await domainFaults(MAKER, answering([`tisty-root=${ROOT}`, "v=spf1 -all"]))).toEqual([]);
  });

  it("asks nothing when the maker names no domain", async () => {
    const never: Lookup = async () => {
      throw new Error("asked");
    };
    expect(await domainFaults({ root: ROOT }, never)).toEqual([]);
  });

  it("does not hold with no record, another root, or two roots", async () => {
    expect(await domainFaults(MAKER, answering([]))).toHaveLength(2);
    expect((await domainFaults(MAKER, answering([`tisty-root=${"B".repeat(43)}`])))[0]).toContain("does not name");
    const two = [`tisty-root=${ROOT}`, `tisty-root=${"B".repeat(43)}`];
    expect((await domainFaults(MAKER, answering(two)))[0]).toContain("more than one root");
  });

  it("does not hold when a resolver cannot be asked, or the two disagree", async () => {
    expect(await domainFaults(MAKER, answering(null))).toEqual([
      `1.1.1.1 could not be asked about ${recordName("rgdevment.dev")}`,
      `8.8.8.8 could not be asked about ${recordName("rgdevment.dev")}`,
    ]);
    expect(await domainFaults(MAKER, answering([`tisty-root=${ROOT}`], []))).toHaveLength(1);
  });

  it("never repeats what the record says", async () => {
    const faults = await domainFaults(MAKER, answering(["tisty-root=::error::injected"]));
    expect(faults.join(" ")).not.toContain("injected");
  });
});
