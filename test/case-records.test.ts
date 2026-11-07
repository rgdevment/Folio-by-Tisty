import { describe, expect, it } from "vitest";
import { madeCase } from "../src/admin/page/case";
import { fromBase64Url } from "../src/core/bytes";
import { isSealedRecords, openRecords, sealRecords } from "../src/core/case-records";
import { tokenHash } from "../src/core/start";
import { caseOfFragment, keyOfFragment } from "../src/page/link";

const KEY = new Uint8Array(32).fill(7);

describe("the sealed records", () => {
  it("open with their key and not with another", async () => {
    const sealed = await sealRecords('{"said":"ñandú"}', KEY);
    expect(isSealedRecords(sealed)).toBe(true);
    expect(sealed).not.toContain("said");
    expect(await openRecords(sealed, KEY)).toBe('{"said":"ñandú"}');
    await expect(openRecords(sealed, new Uint8Array(32).fill(8))).rejects.toThrow();
  });

  it.each([
    ["no text", 1],
    ["another format", "sealed1.abc"],
    ["another prefix", "other1abc"],
    ["what is not encoded", "case1.a b"],
    ["nothing inside", "case1."],
    ["too much", `case1.${"a".repeat(1_000_000)}`],
  ])("are not %s", (_, said) => {
    expect(isSealedRecords(said)).toBe(false);
  });
});

describe("a case made in the panel", () => {
  const partsOf = (link: string) => link.slice(link.indexOf("#") + 1);

  it("brings a token whose hash is all the server gets", async () => {
    const { link, body } = await madeCase("AbCdEfGh", 3);
    const read = caseOfFragment(partsOf(link));
    expect(link.startsWith("https://tisty.cl/AbCdEfGh#caso.")).toBe(true);
    expect(body).toEqual({ version: 3, tokenHash: await tokenHash(read?.token ?? "") });
    expect(JSON.stringify(body)).not.toContain(read?.token);
    expect(read?.recordsKey).toBeUndefined();
  });

  it("seals the records with a key only the link carries", async () => {
    const { link, body } = await madeCase("AbCdEfGh", 3, { reports: ["one"] });
    const read = caseOfFragment(partsOf(link));
    expect(JSON.stringify(body)).not.toContain(read?.recordsKey);
    expect(body.tokenHash).toBe(await tokenHash(read?.token ?? ""));
    const opened = await openRecords(body.sealedRecords ?? "", fromBase64Url(read?.recordsKey ?? ""));
    expect(JSON.parse(opened)).toEqual({ reports: ["one"] });
  });

  it("is new each time", async () => {
    expect((await madeCase("AbCdEfGh", 1)).link).not.toBe((await madeCase("AbCdEfGh", 1)).link);
  });
});

describe("a fragment", () => {
  it("reads as a case only when it says so", () => {
    expect(caseOfFragment("caso.tok")).toEqual({ token: "tok" });
    expect(caseOfFragment("caso.tok.key")).toEqual({ token: "tok", recordsKey: "key" });
    expect(caseOfFragment("caso")).toBeNull();
    expect(caseOfFragment("")).toBeNull();
    expect(caseOfFragment(`${"k".repeat(43)}.token`)).toBeNull();
  });

  it("leaves a reader's link as it was", () => {
    expect(keyOfFragment(`${"k".repeat(43)}.token`)).toBe("k".repeat(43));
  });
});
