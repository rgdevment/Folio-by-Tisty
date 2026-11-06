import type { Revocation } from "@tisty/contracts";
import VECTORS from "@tisty/contracts/vectors.json";
import { describe, expect, it } from "vitest";
import type { Bytes } from "../src/core/bytes";
import { keyOfFragment, readingLink } from "../src/page/link";
import { openLink } from "../src/page/read";
import { worseOf } from "../src/page/verdict";
import { EnvelopeRefused } from "../src/rules/envelope";

// biome-ignore lint/suspicious/noExplicitAny: these are the contract's own samples, in the shape it writes them.
const SAMPLES = VECTORS as any;

const hex = (said: string): Bytes => Uint8Array.from(said.match(/../g) ?? [], (one) => Number.parseInt(one, 16));

const ID = "k7Qm2xPa";
const arrivedWith = (envelope: string) => ({ bytes: hex(envelope), arrivedAt: 1_800_000_000_123, diesOn: 21_000 });
const MAIN = arrivedWith(SAMPLES.main.envelope);

const refusalOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "opened",
    (error) => (error instanceof EnvelopeRefused ? error.refusal : `broke: ${error}`),
  );

describe("opening a link", () => {
  it("gives the document, its pictures and what the page says of its signature", async () => {
    const { held, pictures, verdict, fingerprint, diesOn } = await openLink(ID, SAMPLES.link_key, MAIN);
    expect(held.title).toBe("Paseos");
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toEqual(hex(SAMPLES.main.pictures[0]));
    expect(verdict).toBe("holds");
    expect(fingerprint).toBe(SAMPLES.identity.fingerprint);
    expect(diesOn).toBe(21_000);
  });

  it("names the owner apart when an editor signed this version", async () => {
    const { editing } = SAMPLES;
    const editorSigned = editing.opens.find((one: { signer: string }) => one.signer !== editing.owner);
    const opened = await openLink(editing.id, SAMPLES.link_key, arrivedWith(editorSigned.envelope));
    expect(opened.ownerFingerprint).not.toBeNull();
    expect(opened.ownerFingerprint).not.toBe(opened.fingerprint);
  });

  it("says what its server says of a machine taken back", async () => {
    const said = SAMPLES.revocation;
    const after = await openLink(ID, SAMPLES.link_key, { ...MAIN, revocations: [said] });
    expect(after.verdict).toBe("doubtful");
    const arrivedAt = Date.parse(said.at) - 1000;
    const before = await openLink(ID, SAMPLES.link_key, { ...MAIN, arrivedAt, revocations: [said] });
    expect(before.verdict).toBe("retired");
  });

  it("opens the document whatever comes in place of a note", async () => {
    const revocations = [null, 5, "x", [], {}] as unknown as Revocation[];
    expect((await openLink(ID, SAMPLES.link_key, { ...MAIN, revocations })).verdict).toBe("holds");
  });

  it("does not believe a note that does not hold", async () => {
    const forged = { ...SAMPLES.revocation, signed: "A".repeat(86) };
    expect((await openLink(ID, SAMPLES.link_key, { ...MAIN, revocations: [forged] })).verdict).toBe("holds");
  });

  it("names no owner apart when the owner signed this version", async () => {
    const { ownerFingerprint } = await openLink(ID, SAMPLES.link_key, MAIN);
    expect(ownerFingerprint).toBeNull();
  });

  it("shows the worse of the signer's verdict and the owner's", async () => {
    expect(worseOf("holds", "doubtful")).toBe("doubtful");
    expect(worseOf("retired", "holds")).toBe("retired");
    expect(worseOf("retired", "doubtful")).toBe("doubtful");
    expect(worseOf("holds", "holds")).toBe("holds");
    expect(worseOf("holds", "refused")).toBe("refused");
    expect(worseOf("unreadable", "doubtful")).toBe("unreadable");
  });

  it("takes the key from an edit link, and the token opens nothing", () => {
    const [, fragment] = SAMPLES.editing.link.split("#");
    expect(keyOfFragment(fragment)).toBe(SAMPLES.link_key);
    expect(keyOfFragment(SAMPLES.link_key)).toBe(SAMPLES.link_key);
    expect(keyOfFragment("")).toBe("");
  });

  it("writes the link to read as it was, with no token and no stray mark", () => {
    const address = { origin: "https://tisty.cl", pathname: "/k7Qm2xPa" };
    expect(readingLink({ ...address, hash: "#THEKEY.THETOKEN" })).toBe("https://tisty.cl/k7Qm2xPa#THEKEY");
    expect(readingLink({ ...address, hash: "#THEKEY" })).toBe("https://tisty.cl/k7Qm2xPa#THEKEY");
    expect(readingLink({ ...address, hash: "" })).toBe("https://tisty.cl/k7Qm2xPa");
  });

  it("opens what is public with nothing after the #", async () => {
    const { held } = await openLink("wordsOnly", "", arrivedWith(SAMPLES.public.envelope));
    expect(held.id).toBe("wordsOnly");
  });

  it("asks for the key when it brings none", async () => {
    expect(await refusalOf(openLink(ID, "", MAIN))).toBe("key");
  });

  it("says the link is wrong, and not that the document is damaged", async () => {
    expect(await refusalOf(openLink(ID, "A".repeat(43), MAIN))).toBe("key");
    expect(await refusalOf(openLink(ID, "not*base64", MAIN))).toBe("key");
  });

  it("does not open another document than the one the address names", async () => {
    expect(await refusalOf(openLink("anotherO", SAMPLES.link_key, MAIN))).toBe("damaged");
  });

  it("refuses all the contract refuses", async () => {
    for (const { says, envelope } of SAMPLES.refused) {
      const refused = await refusalOf(openLink("hostile", "", arrivedWith(envelope)));
      expect(["newer", "older", "damaged", "unsigned", "key"], says).toContain(refused);
    }
  });
});
