import { readFileSync } from "node:fs";
import VECTORS from "@tisty/contracts/vectors.json";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealRecords } from "../src/core/case-records";
import { proofHolds, solveProof } from "../src/core/start";
import { showCase, showLink } from "../src/page/ui/show";

// biome-ignore lint/suspicious/noExplicitAny: these are the contract's own samples, in the shape it writes them.
const SAMPLES = VECTORS as any;
const ID = "k7Qm2xPa";
const NOT_FOUND = "/404";

const hex = (said: string) => Uint8Array.from(said.match(/../g) ?? [], (one) => Number.parseInt(one, 16));
const arrived = (envelope: string) => ({ bytes: hex(envelope), arrivedAt: 1_800_000_000_000, diesOn: 21_000 });

let place: Window & typeof globalThis;
let replace: ReturnType<typeof vi.fn>;

const said = (): string => place.document.getElementById("loading-text")?.textContent ?? "";
const closed = (): string => place.document.body.dataset.state ?? "";

class SolvingWorker {
  listeners: Record<string, (event: unknown) => void> = {};
  addEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners[name] = listener;
  }
  terminate(): void {}
  postMessage({ salt, bits }: { salt: string; bits: number }): void {
    void solveProof(salt, bits).then((data) => this.listeners.message?.({ data }));
  }
}

beforeEach(() => {
  place = new JSDOM(readFileSync("src/page/index.html", "utf8"), { url: `https://tisty.cl/${ID}` }).window;
  replace = vi.fn();
  vi.stubGlobal("document", place.document);
  vi.stubGlobal("navigator", { languages: ["es-CL"] });
  place.document.documentElement.lang = "es";
  vi.stubGlobal("location", { href: place.location.href, replace, hash: "" });
  vi.stubGlobal("window", place);
  vi.stubGlobal("Worker", SolvingWorker);
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what a reader is told", () => {
  it("sends what does not exist to the 404, saying nothing of why", async () => {
    await showLink(ID, "", Promise.resolve({ refused: "missing" }), NOT_FOUND);
    expect(replace).toHaveBeenCalledWith(NOT_FOUND);
  });

  it.each([
    ["paused", "pausó"],
    ["blocked", "bloqueado"],
    ["slow", "demasiadas visitas"],
    ["unreachable", "No se pudo traer"],
    ["failed", "No se pudo traer"],
  ])("explains %s", async (refused, words) => {
    await showLink(ID, "", Promise.resolve({ refused }), NOT_FOUND);
    expect(said()).toContain(words);
    expect(closed()).toBe("closed");
  });

  it("asks for the whole link when the key is missing", async () => {
    await showLink(ID, "", Promise.resolve(arrived(SAMPLES.main.envelope)), NOT_FOUND);
    expect(said()).toContain("link completo");
  });

  it("shows no words of what the contract refuses", async () => {
    const script = SAMPLES.refused.find((one: { says: string }) => one.says === "a script in its HTML");
    await showLink("hostile", "", Promise.resolve(arrived(script.envelope)), NOT_FOUND);
    expect(said()).toContain("dañado");
    expect(place.document.getElementById("desk")?.hidden).toBe(true);
  });

  it("lets what it did not expect reach the page's entry, which still closes", async () => {
    const broken = { bytes: hex(SAMPLES.main.envelope), arrivedAt: Number.NaN, diesOn: 1 };
    await expect(showLink(ID, SAMPLES.link_key, Promise.resolve(broken), NOT_FOUND)).rejects.toThrow();
  });
});

describe("a case link", () => {
  const TOKEN = "T".repeat(43);
  const RECORDS_KEY = "A".repeat(43);
  const served = () =>
    new Response(hex(SAMPLES.main.envelope), {
      headers: { "Folio-Arrived": "1800000000000", "Folio-Dies-On": "21000", "Folio-Version": "1" },
    });
  const button = () => place.document.getElementById("report") as HTMLButtonElement | null;

  beforeEach(() => {
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    vi.stubGlobal("DOMParser", place.DOMParser);
    vi.stubGlobal("MutationObserver", place.MutationObserver);
    vi.stubGlobal("AbortController", place.AbortController);
    vi.stubGlobal("navigator", { languages: ["es-CL"] });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
      },
    );
  });

  it("asks with its token, for the case and not the document", async () => {
    const fetched = vi.fn(async () => new Response('{"refused":"missing"}', { status: 404 }));
    vi.stubGlobal("fetch", fetched);
    await showCase(ID, { token: TOKEN });
    const [path, asked] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/cases/${ID}`);
    expect(asked.headers).toEqual({ "Folio-Case": TOKEN });
    expect(said()).toContain("caducó");
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not ask for the key of what it could not bring", async () => {
    const asking = vi.fn();
    vi.stubGlobal("prompt", asking);
    vi.stubGlobal("fetch", async () => new Response('{"refused":"slow"}', { status: 429 }));
    await showCase(ID, { token: TOKEN });
    expect(asking).not.toHaveBeenCalled();
    expect(said()).toContain("demasiadas visitas");
  });

  it("opens with the key pasted alone or inside a link, and offers neither editing nor reporting", async () => {
    vi.stubGlobal("fetch", async () => served());
    vi.stubGlobal("prompt", () => `https://tisty.cl/${ID}#${SAMPLES.link_key}`);
    await showCase(ID, { token: TOKEN });
    expect(closed()).not.toBe("closed");
    expect(place.document.getElementById("edit-in-tisty")).toBeNull();
    expect(button()).toBeNull();
  });

  it("says the link does not open when no key was given", async () => {
    vi.stubGlobal("fetch", async () => served());
    vi.stubGlobal("prompt", () => null);
    await showCase(ID, { token: TOKEN });
    expect(said()).toContain("link completo");
  });

  it("offers the records when the link brings their key, and saves them open", async () => {
    const sealed = await sealRecords('{"reports":[]}', new Uint8Array(32));
    const fetched = vi.fn(async (path: string) =>
      path.endsWith("/records") ? new Response(JSON.stringify({ sealed })) : served(),
    );
    vi.stubGlobal("fetch", fetched);
    vi.stubGlobal("prompt", () => SAMPLES.link_key);
    const kept: Blob[] = [];
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: (blob: Blob) => (kept.push(blob), "blob:x"), revokeObjectURL: () => {} }),
    );
    await showCase(ID, { token: TOKEN, recordsKey: RECORDS_KEY });
    expect(button()?.textContent).toBe("Descargar registros");
    expect(button()?.disabled).toBe(false);
    const opensTheForm = vi.fn();
    Object.assign(place.document.getElementById("report-dialog") as object, { showModal: opensTheForm });
    const before = kept.length;
    button()?.click();
    await vi.waitFor(() => expect(kept.length).toBeGreaterThan(before));
    expect(await (kept.at(-1) as Blob).text()).toBe('{"reports":[]}');
    expect(opensTheForm).not.toHaveBeenCalled();
  });

  it("says so when the records cannot be brought", async () => {
    vi.stubGlobal("fetch", async (path: string) =>
      path.endsWith("/records") ? new Response('{"refused":"missing"}', { status: 404 }) : served(),
    );
    vi.stubGlobal("prompt", () => SAMPLES.link_key);
    await showCase(ID, { token: TOKEN, recordsKey: RECORDS_KEY });
    button()?.click();
    await vi.waitFor(() => expect(button()?.textContent).toContain("No se pudieron"));
  });
});

describe("a proof of work", () => {
  it("is solved so that the server's own check takes it", async () => {
    expect(await proofHolds("a-salt", await solveProof("a-salt", 8), 8)).toBe(true);
  });

  it("is sent back, and the document asked for again", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ refused: "paused" }), { status: 403 }));
    vi.stubGlobal("fetch", fetched);
    await showLink(ID, "", Promise.resolve({ refused: "proof", salt: "a-salt", bits: 4 }), NOT_FOUND);
    const [, init] = fetched.mock.calls[0] as unknown as [string, { headers: { "Folio-Proof": string } }];
    expect(await proofHolds("a-salt", init.headers["Folio-Proof"], 4)).toBe(true);
    expect(said()).toContain("pausó");
  });

  it("is not tried twice: asked again, the reader is told to come back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ refused: "proof", salt: "b", bits: 4 }), { status: 429 })),
    );
    await showLink(ID, "", Promise.resolve({ refused: "proof", salt: "a-salt", bits: 4 }), NOT_FOUND);
    expect(said()).toContain("más tarde");
  });
});
