import { readFileSync } from "node:fs";
import type { Document } from "@tisty/contracts";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Opened, openLink } from "../src/page/read";
import { showLink } from "../src/page/ui/show";
import { refuse } from "../src/rules/envelope";

vi.mock("../src/page/read", async (original) => ({
  ...(await original<typeof import("../src/page/read")>()),
  openLink: vi.fn(),
}));

const ANCHOR = "k7Qm2xPa";
const ENGLISH = "enWords1";
const FRENCH = "frWords1";
const NOT_FOUND = "/404";
const HASH = "H".repeat(43);

const page = (id: string, title: string, lang: string): Document => ({
  id,
  title,
  lang,
  body: "",
  html: `<h1>${title}</h1><p><a class="card" href="tisty:file/0">x</a></p>`,
  files: [{ at: 0, name: "notas.txt" }],
  files_hash: HASH,
});

const translation = (id: string, title: string, lang: string, anchor: string | null = ANCHOR): Document => ({
  ...page(id, title, lang),
  ...(anchor === null ? {} : { anchor }),
});

const SPANISH: Document = {
  ...page(ANCHOR, "Paseos", "es"),
  languages: [
    { lang: "en", document: ENGLISH, key: "ENKEY" },
    { lang: "fr", document: FRENCH, key: "FRKEY" },
  ],
};

const openedOf = (held: Document, fingerprint: string, ownerFingerprint: string | null = null): Opened => ({
  held,
  pictures: [],
  signerStanding: "plain",
  ownerStanding: "plain",
  editors: [],
  verdict: "holds",
  fingerprint,
  ownerFingerprint,
  diesOn: 21_000,
});

const ARRIVED = { bytes: new Uint8Array(1), arrivedAt: 1_800_000_000_000, diesOn: 21_000, version: 1 };

const served = (version: number) =>
  new Response(new Uint8Array(1), {
    headers: { "Folio-Arrived": "1800000000000", "Folio-Dies-On": "21000", "Folio-Version": String(version) },
  });

let place: Window & typeof globalThis;
let root: ShadowRoot;
let opens: Record<string, Opened>;
let fetched: ReturnType<typeof vi.fn>;

const byId = <T extends HTMLElement>(id: string): T => place.document.getElementById(id) as T;
const askedFor = (): string[] => fetched.mock.calls.map(([path]) => path as string);

const choose = async (lang: string): Promise<void> => {
  const select = byId<HTMLSelectElement>("language");
  select.value = lang;
  select.dispatchEvent(new place.Event("change"));
  await vi.waitFor(() => expect(select.disabled).toBe(false));
};

const opened = (languages: string[]): Promise<void> => {
  vi.stubGlobal("navigator", { languages });
  return showLink(ANCHOR, "ANCHORKEY", Promise.resolve(ARRIVED), NOT_FOUND);
};

beforeEach(() => {
  place = new JSDOM(readFileSync("src/page/index.html", "utf8"), { url: `https://tisty.cl/${ANCHOR}` }).window;
  const attach = place.Element.prototype.attachShadow;
  place.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    root = attach.call(this, init);
    return root;
  };
  place.HTMLDialogElement.prototype.showModal = vi.fn();
  place.Element.prototype.scrollIntoView = vi.fn();
  opens = {
    [ANCHOR]: openedOf(SPANISH, "owner"),
    [ENGLISH]: openedOf(translation(ENGLISH, "Walks", "en"), "editor", "owner"),
    [FRENCH]: openedOf(translation(FRENCH, "Promenades", "fr"), "owner"),
  };
  vi.mocked(openLink).mockImplementation(async (id) => opens[id] ?? refuse("unsigned", "not in this test"));
  fetched = vi.fn(async (path: string) => {
    if (path.endsWith("/report")) return new Response('{"received":true}', { status: 202 });
    if (path.includes("/files/")) return new Response('{"refused":"missing"}', { status: 404 });
    return served(path.endsWith(ENGLISH) ? 7 : 3);
  });
  vi.stubGlobal("fetch", fetched);
  vi.stubGlobal("document", place.document);
  vi.stubGlobal("window", place);
  vi.stubGlobal("location", { href: place.location.href, replace: vi.fn(), hash: "" });
  vi.stubGlobal("FormData", place.FormData);
  vi.stubGlobal("DOMParser", place.DOMParser);
  vi.stubGlobal("MutationObserver", place.MutationObserver);
  vi.stubGlobal("AbortController", place.AbortController);
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("localStorage", place.localStorage);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a document in several languages", () => {
  it("opens in the first language of the reader's that the group has", async () => {
    await opened(["de-DE", "en-US", "es"]);
    expect(place.document.title).toBe("Walks · Folio");
    expect(askedFor()).toEqual([`/api/v1/docs/${ENGLISH}`]);
    expect(vi.mocked(openLink)).toHaveBeenLastCalledWith(ENGLISH, "ENKEY", expect.anything());
    expect(byId<HTMLSelectElement>("language").value).toBe("en");
  });

  it("stays in the anchor's language when the reader prefers it, asking for nothing else", async () => {
    await opened(["es-CL", "en"]);
    expect(place.document.title).toBe("Paseos · Folio");
    expect(askedFor()).toEqual([]);
    expect(byId("language-choice").hidden).toBe(false);
    expect([...byId<HTMLSelectElement>("language").options].map((one) => one.value)).toEqual(["es", "en", "fr"]);
  });

  it("offers no switch when the document has only its own language", async () => {
    opens[ANCHOR] = openedOf({ ...SPANISH, languages: [] }, "owner");
    await opened(["en"]);
    expect(byId("language-choice").hidden).toBe(true);
  });

  it("stays on the anchor and says so when the reader's language cannot be brought", async () => {
    fetched.mockImplementation(async () => new Response('{"refused":"paused"}', { status: 403 }));
    await opened(["en"]);
    expect(place.document.title).toBe("Paseos · Folio");
    expect(byId<HTMLSelectElement>("language").value).toBe("es");
    expect(byId("missed-the-readers").hidden).toBe(false);
  });

  it("never shows a translation whose envelope does not open", async () => {
    delete opens[ENGLISH];
    await opened(["en"]);
    expect(place.document.title).toBe("Paseos · Folio");
    expect(root.textContent).not.toContain("Walks");
    expect(byId("missed-the-readers").hidden).toBe(false);
  });

  it("switches in place, and back without asking again", async () => {
    await opened(["es"]);
    await choose("en");
    expect(place.document.title).toBe("Walks · Folio");
    await choose("es");
    expect(place.document.title).toBe("Paseos · Folio");
    await choose("en");
    expect(askedFor()).toEqual([`/api/v1/docs/${ENGLISH}`]);
  });

  it("keeps the language being read when the chosen one cannot be opened", async () => {
    delete opens[FRENCH];
    await opened(["en"]);
    await choose("fr");
    expect(place.document.title).toBe("Walks · Folio");
    expect(byId<HTMLSelectElement>("language").value).toBe("en");
    expect(byId("could-not-switch").hidden).toBe(false);
  });

  it.each([
    ["no anchor", () => openedOf(translation(FRENCH, "Promenades", "fr", null), "owner")],
    ["another anchor", () => openedOf(translation(FRENCH, "Promenades", "fr", "otroAncl"), "owner")],
    ["another language than it says", () => openedOf(translation(FRENCH, "Spaziergänge", "de"), "owner")],
  ])("refuses a translation that names %s, and stays on what was shown", async (_, opening) => {
    opens[FRENCH] = opening();
    await opened(["es"]);
    await choose("fr");
    expect(place.document.title).toBe("Paseos · Folio");
    expect(byId<HTMLSelectElement>("language").value).toBe("es");
    expect(byId("could-not-switch").hidden).toBe(false);
  });

  it("does not open a translation that names another anchor, even in the reader's language", async () => {
    opens[FRENCH] = openedOf(translation(FRENCH, "Promenades", "fr", "otroAncl"), "owner");
    await opened(["fr"]);
    expect(place.document.title).toBe("Paseos · Folio");
  });

  it.each([
    ["another owner", () => openedOf(translation(FRENCH, "Promenades", "fr"), "stranger")],
    [
      "another owner who let the anchor's owner sign",
      () => openedOf(translation(FRENCH, "Promenades", "fr"), "owner", "stranger"),
    ],
  ])(
    "opens a language with %s, saying beside it and in the switch that its owner has not reviewed it",
    async (_, opening) => {
      opens[FRENCH] = opening();
      await opened(["fr"]);
      expect(place.document.title).toBe("Promenades · Folio");
      expect(byId("unreviewed").hidden).toBe(false);
      expect(byId("unreviewed").querySelector('[lang="es"]')?.textContent).toBe(
        "Este idioma lo sumó alguien que edita, y su dueño todavía no lo revisa.",
      );
      expect(byId("unreviewed").querySelector('[lang="en"]')?.textContent).toBe(
        "This language was added by someone who edits, and its owner has not reviewed it yet.",
      );
      const french = [...byId<HTMLSelectElement>("language").options].find((one) => one.value === "fr");
      expect(french?.text).toMatch(/⚠$/);
      await choose("es");
      expect(byId("unreviewed").hidden).toBe(true);
      await choose("fr");
      expect(french?.text.match(/⚠/g)).toHaveLength(1);
    },
  );

  it("says nothing of a language its owner added", async () => {
    await opened(["fr"]);
    expect(byId("unreviewed").hidden).toBe(true);
    expect([...byId<HTMLSelectElement>("language").options].map((one) => one.text).join()).not.toContain("⚠");
  });

  it("takes a translation an editor signed for the same owner", async () => {
    await opened(["en"]);
    expect(place.document.title).toBe("Walks · Folio");
  });

  it.each([
    ["opened in", ["en"], []],
    ["switched to", ["es"], ["en"]],
  ])("reports the document %s, with its own version", async (_how, languages, chosen) => {
    await opened(languages);
    for (const lang of chosen) await choose(lang);
    const spam = place.document.querySelector<HTMLInputElement>('input[value="spam"]') as HTMLInputElement;
    spam.checked = true;
    byId("report-form").dispatchEvent(new place.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(askedFor().at(-1)).toBe(`/api/v1/docs/${ENGLISH}/report`));
    const [, sent] = fetched.mock.calls.at(-1) as [string, RequestInit];
    expect(JSON.parse(sent.body as string)).toMatchObject({ category: "spam", version: 7 });
  });

  it("keeps the language the reader chooses, only in their browser and only for this link", async () => {
    await opened(["es"]);
    await choose("fr");
    expect(place.localStorage.getItem(`language ${ANCHOR}`)).toBe("fr");
  });

  it("opens the language the reader last chose in this link, before their browser's", async () => {
    place.localStorage.setItem(`language ${ANCHOR}`, "fr");
    await opened(["en"]);
    expect(place.document.title).toBe("Promenades · Folio");
    expect(vi.mocked(openLink)).toHaveBeenLastCalledWith(FRENCH, "FRKEY", expect.anything());
  });

  it("stays in the anchor's language when the reader chose it in this link, asking for nothing else", async () => {
    place.localStorage.setItem(`language ${ANCHOR}`, "es");
    await opened(["en"]);
    expect(place.document.title).toBe("Paseos · Folio");
    expect(askedFor()).toEqual([]);
  });

  it("takes no choice the reader made in another link", async () => {
    place.localStorage.setItem("language otroAncl", "fr");
    await opened(["en"]);
    expect(place.document.title).toBe("Walks · Folio");
  });

  it("asks for the files of the document being shown", async () => {
    await opened(["es"]);
    await choose("en");
    const file = root.querySelector("a[data-file]");
    file?.dispatchEvent(new place.MouseEvent("click", { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(askedFor().at(-1)).toBe(`/api/v1/docs/${ENGLISH}/files/${HASH}`));
    await vi.waitFor(() => expect(file?.getAttribute("aria-busy")).toBeNull());
    expect(askedFor().filter((one) => one.includes(ANCHOR))).toEqual([]);
  });
});
