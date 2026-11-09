import { type Document, type Editor, type Served, VERSION } from "@tisty/contracts";
import VECTORS from "@tisty/contracts/vectors.json";
import { describe, expect, it, vi } from "vitest";
import { words } from "../src/core/bytes";
import { documentIn, type OpenEnvelope } from "../src/page/open";
import { editorsOf } from "../src/page/read";
import { editorHolds } from "../src/rules/envelope";

vi.mock("../src/page/maker", () => ({
  MAKER: { root: "F8t5-ytBIPKx7GXkGY1uCLKOgT_rAeSkAIObheGAgM4", name: "rgdevment", domain: "rgdevment.dev" },
}));

interface Sample {
  says: string;
  holds: boolean;
  entry: Editor;
}

const SAMPLES = VECTORS.editors as Sample[];
const IN_A_DOCUMENT = VECTORS.editors_in_a_document as { id: string; editors: Editor[]; kept: Editor[] };
const entry = (says: string): Editor => (SAMPLES.find((one) => one.says === says) as Sample).entry;
const MARIO = entry("the owner, who signed its first version");
const ANA = entry("someone who edited it through its link");
const FORGED_ANA = entry("a signature that does not hold");

const documentWith = (editors: Editor[], id = "editado"): Document => ({ id, editors, body: "", html: "" });
const shownIn = (editors: Editor[], served: Served = {}) => editorsOf(documentWith(editors), served);
const servedBy = (says: string): Served => (VECTORS.verdicts.find((one) => one.says === says)?.served ?? {}) as Served;

const openedWith = (editors: unknown[]): OpenEnvelope =>
  ({
    manifest: { contract: VERSION, id: "editado", sealed: true },
    opened: [
      words(JSON.stringify({ id: "editado", html: "<p>Hola</p>", editors })),
      words(JSON.stringify({ body: "Hola" })),
    ],
  }) as unknown as OpenEnvelope;

describe("an entry of who edited it", () => {
  it.each(SAMPLES.map((one) => [one.says, one] as const))("%s, as the contract says", async (_, { entry, holds }) => {
    expect(await editorHolds(entry)).toBe(holds);
  });

  it("fails without breaking when what it says cannot even be read", async () => {
    expect(await editorHolds({ ...ANA, signed: "not*base64" })).toBe(false);
    expect(await editorHolds({ ...ANA, root: "A".repeat(43) })).toBe(false);
  });
});

describe("whom the page names as having edited it", () => {
  it("only those whose entry holds and was signed for this document", async () => {
    const shown = await editorsOf(documentWith(IN_A_DOCUMENT.editors, IN_A_DOCUMENT.id), {});
    expect(shown.map((one) => one.name)).toEqual(IN_A_DOCUMENT.kept.map((one) => one.name));
  });

  it("nobody when no entry holds", async () => {
    expect(await shownIn(SAMPLES.filter((one) => !one.holds).map((one) => one.entry))).toEqual([]);
  });

  it("each root once, and a forged entry that comes first does not hide the real one", async () => {
    const shown = await shownIn([FORGED_ANA, ANA, MARIO, ANA]);
    expect(shown.map((one) => one.name)).toEqual(["Ana", "Mario"]);
  });

  it("marks as verified only the maker's root", async () => {
    const shown = await shownIn([MARIO, ANA]);
    expect(shown).toEqual([
      { name: "Mario", standing: "verified" },
      { name: "Ana", standing: "plain" },
    ]);
  });

  it("leaves aside a machine its server says was taken back before it arrived", async () => {
    const retired = servedBy("it arrived before the revocation's at");
    const doubtful = servedBy("it arrived after it");
    expect((await shownIn([MARIO, ANA], retired)).map((one) => one.name)).toEqual(["Mario", "Ana"]);
    expect((await shownIn([MARIO, ANA], doubtful)).map((one) => one.name)).toEqual(["Ana"]);
  });
});

describe("a document with entries out of shape", () => {
  it("still opens, and leaves those entries aside", async () => {
    const held = await documentIn(openedWith([ANA, { ...ANA, name: "" }, { ...MARIO, in: "not an id" }, "nobody"]));
    expect(held.editors).toEqual([ANA]);
  });

  it("is still damaged when what it says of its editors is not a list", async () => {
    await expect(documentIn(openedWith("Ana" as unknown as unknown[]))).rejects.toMatchObject({ refusal: "damaged" });
  });
});
