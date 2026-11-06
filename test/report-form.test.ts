import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_CATEGORIES } from "../src/core/limits";
import { offerReport } from "../src/page/ui/report";
import { solved } from "../src/page/ui/solve";

vi.mock("../src/page/ui/solve", () => ({ solved: vi.fn(async () => "the proof") }));

const ID = "k7Qm2xPa";
const LINK_KEY = "nlt35tFEpAhP5bWJr2p2hIFCFml15FNS5LD2AsBbd2s";

const answer = (status: number, body: object) => new Response(JSON.stringify(body), { status });

let place: Window & typeof globalThis;
let asked: ReturnType<typeof vi.fn>;
let operatorKey: string;

const element = <T extends HTMLElement>(id: string): T => place.document.getElementById(id) as T;

const choose = (category: string): void => {
  const radio = place.document.querySelector<HTMLInputElement>(`input[value="${category}"]`) as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new place.Event("change", { bubbles: true }));
};

const submitted = async (): Promise<void> => {
  element("report-form").dispatchEvent(new place.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(element("report-said").textContent).not.toBe("Enviando…"));
};

const bodySent = (at: number): Record<string, string> => JSON.parse(asked.mock.calls[at]?.[1].body);

beforeEach(async () => {
  place = new JSDOM(readFileSync("src/page/index.html", "utf8")).window as unknown as Window & typeof globalThis;
  place.HTMLDialogElement.prototype.showModal = vi.fn();
  place.HTMLDialogElement.prototype.close = vi.fn();
  vi.stubGlobal("document", place.document);
  vi.stubGlobal("FormData", place.FormData);
  asked = vi.fn(async () => answer(202, { received: true }));
  vi.stubGlobal("fetch", asked);
  vi.mocked(solved).mockClear();
  const pair = (await crypto.subtle.generateKey("X25519", true, ["deriveBits"])) as CryptoKeyPair;
  operatorKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
  offerReport({ id: ID, linkKey: LINK_KEY, operatorKey, version: 3 });
});

afterEach(() => vi.unstubAllGlobals());

describe("the report form", () => {
  it("offers every category the server takes, and no other", () => {
    const offered = [...place.document.querySelectorAll<HTMLInputElement>('input[name="category"]')].map(
      (one) => one.value,
    );
    expect(offered.sort()).toEqual([...REPORT_CATEGORIES].sort());
  });

  it("is enabled only once there is a document, and opens on the button", () => {
    expect(element<HTMLButtonElement>("report").disabled).toBe(false);
    element("report").click();
    expect(place.HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
  });

  it("sends no link unless the reader agrees", async () => {
    choose("threat");
    await submitted();
    expect(bodySent(0)).toEqual({ category: "threat", version: 3 });
    expect(element("report-said").textContent).toContain("Recibimos");
    expect(element<HTMLButtonElement>("report-send").disabled).toBe(true);
  });

  it("seals the link when the reader agrees, and never sends the key", async () => {
    choose("phishing");
    element<HTMLInputElement>("report-hand-over").checked = true;
    await submitted();
    const body = bodySent(0);
    expect(body.sealedLink).toMatch(/^sealed1\./);
    expect(JSON.stringify(asked.mock.calls[0])).not.toContain(LINK_KEY);
  });

  it("does not offer the link on a light report, and takes back the choice", async () => {
    choose("threat");
    element<HTMLInputElement>("report-hand-over").checked = true;
    choose("spam");
    expect(element("report-consent").hidden).toBe(true);
    await submitted();
    expect(bodySent(0)).toEqual({ category: "spam", version: 3 });
    choose("scam");
    expect(element("report-consent").hidden).toBe(false);
  });

  it.each([`https://tisty.cl/${ID}#${LINK_KEY}`, `la llave es ${LINK_KEY}`])(
    "sends nothing while the message carries the link: %s",
    async (written) => {
      choose("threat");
      (place.document.querySelector("textarea") as HTMLTextAreaElement).value = written;
      await submitted();
      expect(asked).not.toHaveBeenCalled();
      expect(element("report-said").textContent).toContain("Quita el link");
      expect(element<HTMLButtonElement>("report-send").disabled).toBe(false);
    },
  );

  it("does the work it is asked for, and sends again with it", async () => {
    asked.mockResolvedValueOnce(answer(429, { refused: "proof", salt: "s", bits: 4 }));
    choose("spam");
    await submitted();
    expect(solved).toHaveBeenCalledWith("s", 4);
    expect(asked.mock.calls[1]?.[1].headers).toMatchObject({ "Folio-Proof": "the proof" });
    expect(element("report-said").textContent).toContain("Recibimos");
  });

  it("says why it could not, and lets the reader try again", async () => {
    asked.mockResolvedValueOnce(answer(429, { refused: "proof", salt: "s", bits: 4 }));
    asked.mockResolvedValueOnce(answer(429, { refused: "quota", until: 1 }));
    choose("spam");
    await submitted();
    expect(element("report-said").textContent).toContain("muchas denuncias");
    expect(element<HTMLButtonElement>("report-send").disabled).toBe(false);
    asked.mockRejectedValueOnce(new Error("no network"));
    await submitted();
    expect(element("report-said").textContent).toContain("No se pudo");
  });
});
