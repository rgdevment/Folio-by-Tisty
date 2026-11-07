import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newKeys, signedFile } from "../scripts/limits-key";
import { type Published, publishedFaults } from "../scripts/limits-published";

const NOW = Date.UTC(2026, 10, 7);
const ES = Buffer.from("# Términos\n");
const EN = Buffer.from("# Terms\n");
const sha256 = (said: Buffer): string => createHash("sha256").update(said).digest("hex");
const { secret, publicKey } = newKeys();

const publishing = (over: { serial?: number; es?: Buffer; en?: Buffer } = {}): Published => {
  const limits = Buffer.from(
    JSON.stringify({ serial: over.serial ?? 20, terms: { version: "13", es: sha256(ES), en: sha256(EN) } }),
  );
  return { limits, signature: signedFile(limits, "limits.json", secret, NOW), es: over.es ?? ES, en: over.en ?? EN };
};

describe("what Tisty reads from GitHub", () => {
  it("holds when the file is signed, as new as main, and names both texts", () => {
    expect(publishedFaults(publishing(), publicKey, 20)).toEqual([]);
  });

  it("says an older serial, which a cache can still be serving", () => {
    expect(publishedFaults(publishing({ serial: 19 }), publicKey, 20)).toEqual([
      "limits.json says serial 19, and main has 20",
    ]);
  });

  it("says which text is not the one the file names", () => {
    expect(publishedFaults(publishing({ es: Buffer.from("# Otros\n") }), publicKey, 20)).toEqual([
      "TERMINOS.md is not the text limits.json names",
    ]);
    expect(publishedFaults(publishing({ en: Buffer.from("# Other\n") }), publicKey, 20)).toEqual([
      "TERMS.md is not the text limits.json names",
    ]);
  });

  it("says a signature that does not hold, as when the file and its signature come from different caches", () => {
    const other = publishing({ serial: 21 });
    expect(publishedFaults({ ...publishing(), signature: other.signature }, publicKey, 20)).toEqual([
      "limits.json does not hold to its signature under docs/limits.pub",
    ]);
  });

  it("says a file that is not JSON", () => {
    expect(publishedFaults({ ...publishing(), limits: Buffer.from("<html>") }, publicKey, 20)).toEqual([
      "limits.json is not JSON",
    ]);
  });
});
