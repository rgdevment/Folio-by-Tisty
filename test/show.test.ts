import { readFileSync } from "node:fs";
import VECTORS from "@tisty/contracts/vectors.json";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofHolds, solveProof } from "../src/core/start";
import { showLink } from "../src/page/ui/show";

// biome-ignore lint/suspicious/noExplicitAny: these are the contract's own samples, in the shape it writes them.
const SAMPLES = VECTORS as any;
const ID = "k7Qm2xPa";
const NOT_FOUND = "https://www.tisty.app/404";

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
