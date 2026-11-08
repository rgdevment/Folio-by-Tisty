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
  const detail = place.document.querySelector('textarea[name="detail"]') as HTMLTextAreaElement;
  const light = ["spam", "offensive"].some(
    (one) => (place.document.querySelector(`input[value="${one}"]`) as HTMLInputElement).checked,
  );
  if (detail.value === "" && !light) detail.value = "imita a un banco";
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
  offerReport(() => ({ id: ID, linkKey: LINK_KEY, operatorKey, version: 3 }));
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

  it.each(["threat", "doxxing", "intimate", "csam"])("always hands over the link on %s", async (category) => {
    choose(category);
    const handOver = element<HTMLInputElement>("report-hand-over");
    expect(handOver.checked).toBe(true);
    expect(handOver.disabled).toBe(true);
    await submitted();
    expect(bodySent(0).sealedLink).toMatch(/^sealed1\./);
  });

  it("keeps the link box hidden until a category says what it means", () => {
    expect(element("report-consent").hidden).toBe(true);
    choose("phishing");
    expect(element("report-consent").hidden).toBe(false);
    expect(element("report-consent-said").textContent).toContain("Lo cifras aquí");
  });

  it("sends the link on a grave report whatever the box says, as after a browser restores the form", async () => {
    (place.document.querySelector('input[value="threat"]') as HTMLInputElement).checked = true;
    expect(element<HTMLInputElement>("report-hand-over").checked).toBe(false);
    await submitted();
    expect(bodySent(0).sealedLink).toMatch(/^sealed1\./);
  });

  describe("why it is reported", () => {
    const detail = () => place.document.querySelector('textarea[name="detail"]') as HTMLTextAreaElement;
    const sending = () => element("report-form").dispatchEvent(new place.Event("submit", { cancelable: true }));

    it("says it is optional only on a light report", () => {
      expect(element("report-detail-optional").hidden).toBe(false);
      choose("spam");
      expect(element("report-detail-optional").hidden).toBe(false);
      choose("phishing");
      expect(element("report-detail-optional").hidden).toBe(true);
    });

    it.each(["", "corto", "   espacios   "])("asks for it before sending, with %j", (said) => {
      choose("phishing");
      detail().value = said;
      sending();
      expect(element("report-said").textContent).toContain("Cuenta en una frase");
      expect(asked).not.toHaveBeenCalled();
      expect(element<HTMLButtonElement>("report-send").disabled).toBe(false);
    });

    it("sends a light report without it", async () => {
      choose("spam");
      await submitted();
      expect(bodySent(0)).not.toHaveProperty("detail");
    });
  });

  describe("the email", () => {
    const contact = () => place.document.querySelector('input[name="contact"]') as HTMLInputElement;

    it("is offered only on what someone can read", () => {
      expect(element("report-contact").hidden).toBe(true);
      choose("spam");
      expect(element("report-contact").hidden).toBe(true);
      choose("phishing");
      expect(element("report-contact").hidden).toBe(false);
      choose("csam");
      expect(element("report-contact").hidden).toBe(false);
    });

    it("is not offered for the browser to fill in or remember", () => {
      expect(contact().autocomplete).toBe("off");
    });

    it("goes sealed under its own label, and not when it was left empty", async () => {
      choose("phishing");
      contact().value = "  quien@example.test ";
      await submitted();
      expect(bodySent(0).sealedContact).toMatch(/^contact1\./);
      expect(asked.mock.calls[0]?.[1].body).not.toContain("quien@example.test");
      contact().value = "";
      element<HTMLButtonElement>("report-send").disabled = false;
      await submitted();
      expect(bodySent(1)).not.toHaveProperty("sealedContact");
    });

    it("does not leave on a light report, even if the browser restored it", async () => {
      contact().value = "quien@example.test";
      choose("spam");
      await submitted();
      expect(bodySent(0)).not.toHaveProperty("sealedContact");
    });
  });

  it("gives the choice back when the reader moves off a grave report", () => {
    choose("threat");
    choose("phishing");
    const handOver = element<HTMLInputElement>("report-hand-over");
    expect(handOver.checked).toBe(false);
    expect(handOver.disabled).toBe(false);
  });

  it("says what happens to the link, which nobody opens on child abuse", () => {
    choose("csam");
    expect(element("report-consent-said").textContent).toContain("autoridades pertinentes");
    choose("threat");
    expect(element("report-consent-said").textContent).toContain("siempre entrega el link");
  });

  it("points a holder of rights to the mail before anything else", () => {
    const form = element("report-form");
    expect(form.querySelector(".report-copyright a")?.getAttribute("href")).toBe("mailto:abuso@tisty.app");
    expect(form.firstElementChild?.nextElementSibling?.className).toBe("report-copyright");
  });

  it("says a report is made in good faith before it is sent", () => {
    expect(element("report-form").textContent).toContain("buena fe");
  });

  it("sends no link unless the reader agrees", async () => {
    choose("phishing");
    await submitted();
    expect(bodySent(0)).toEqual({ category: "phishing", detail: "imita a un banco", version: 3 });
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
    choose("phishing");
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

  it("says it is about reports when its network is going too fast, not about visits", async () => {
    asked.mockResolvedValueOnce(answer(429, { refused: "slow", until: 1 }));
    choose("spam");
    await submitted();
    expect(element("report-said").textContent).toContain("en poco tiempo");
    expect(element("report-said").textContent).not.toContain("visitas");
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
