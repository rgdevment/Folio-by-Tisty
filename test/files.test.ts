import { readFileSync } from "node:fs";
import type { Attachment, Document } from "@tisty/contracts";
import { playableAs } from "@tisty/contracts/check";
import VECTORS from "@tisty/contracts/vectors.json";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domPurifyCleaner } from "../src/page/ui/clean";
import { filePresser, playerFor } from "../src/page/ui/files";
import { finished } from "../src/page/ui/finish";
import { drawFrame } from "../src/page/ui/frame";

// biome-ignore lint/suspicious/noExplicitAny: these are the contract's own samples, in the shape it writes them.
const SAMPLES = VECTORS as any;
const SEAL = { verdict: "holds", fingerprint: "1", ownerFingerprint: null, diesOn: "mañana" } as const;
const ID = "k7Qm2xPa";
const LINK_KEY: string = SAMPLES.link_key;

const hex = (said: string) => Uint8Array.from(said.match(/../g) ?? [], (one) => Number.parseInt(one, 16));

const PLAYING = SAMPLES.playing as {
  document: Document;
  files: string;
  is: { at: number; says: string; is: object | null; held_back?: boolean }[];
};

let place: Window & typeof globalThis;
let root: ShadowRoot;
let blobs: Blob[];
let clicked: { name: string; href: string }[];
let answers: Response[];
let asked: string[];
let playsHere: string;

const draw = (html: string, held = PLAYING.document): void => {
  const document = { ...held, html };
  const cleaner = domPurifyCleaner(place);
  const press = filePresser({ id: ID, linkKey: LINK_KEY, held: document });
  drawFrame(document, (words) => finished(cleaner.clean(words), []), SEAL, press);
};

const fileAt = (at: number): HTMLElement => root.querySelector(`a[data-file="${at}"]`) as HTMLElement;

const press = async (at: number): Promise<void> => {
  fileAt(at).dispatchEvent(new place.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
  await vi.waitFor(() => expect(root.querySelector("[aria-busy]")).toBeNull());
};

const alone = (at: number) => `<p><a class="card" href="tisty:file/${at}">x</a></p>`;
const inASentence = (at: number) => `<p>Mira <a class="card" href="tisty:file/${at}">esto</a> ahora.</p>`;

beforeEach(() => {
  place = new JSDOM(readFileSync("src/page/index.html", "utf8"), { url: `https://tisty.cl/${ID}#${LINK_KEY}` }).window;
  const attach = place.Element.prototype.attachShadow;
  place.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    root = attach.call(this, init);
    return root;
  };
  blobs = [];
  clicked = [];
  asked = [];
  playsHere = "maybe";
  answers = [new Response(hex(PLAYING.files))];
  place.HTMLMediaElement.prototype.canPlayType = () => playsHere as CanPlayTypeResult;
  place.HTMLMediaElement.prototype.load = () => {};
  place.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push({ name: this.download, href: this.href });
  };
  vi.stubGlobal("document", place.document);
  vi.stubGlobal("DOMParser", place.DOMParser);
  vi.stubGlobal("MutationObserver", place.MutationObserver);
  vi.stubGlobal("AbortController", place.AbortController);
  vi.stubGlobal("location", { href: place.location.href, hash: `#${LINK_KEY}` });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
    },
  );
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      return answers.shift() as Response;
    }),
  );
  let made = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    made += 1;
    return `blob:https://tisty.cl/${made}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("what a file is, by its first bytes", () => {
  it.each(SAMPLES.first_bytes as { says: string; bytes: string; format: string | null }[])(
    "$says",
    ({ bytes, format }) => {
      expect(playableAs(hex(bytes))?.format ?? null).toBe(format);
    },
  );

  it("never lets a file's name or kind make it play", () => {
    const page = hex("3c21646f63747970652068746d6c3e");
    expect(playerFor({ at: 0, name: "rina.mp3", kind: "audio/mpeg" }, page)).toBeNull();
  });

  it("lets a name or a kind that says HTML hold back what would play", () => {
    const mp3 = hex("fffb9064");
    const asPage: Attachment[] = [
      { at: 0, name: "rina.html", kind: "audio/mpeg" },
      { at: 0, name: "rina.HTM" },
      { at: 0, name: "rina.mp3", kind: "text/html" },
    ];
    for (const file of asPage) expect(playerFor(file, mp3)).toBeNull();
    expect(playerFor({ at: 0, name: "rina.mp3" }, mp3)?.player).toBe("audio");
  });

  it.each([
    { at: 0, name: "a.mp3", kind: "TEXT/HTML" },
    { at: 0, name: "a.mp3", kind: "text/html; charset=utf-8" },
    { at: 0, name: "a.mp3", kind: " application/xhtml+xml" },
    { at: 0, name: "a.xhtml" },
    { at: 0, name: "a.html." },
    { at: 0, name: "a.html " },
  ] as Attachment[])("holds back $name of kind $kind, which also says HTML", (file) => {
    expect(playerFor(file, hex("fffb9064"))).toBeNull();
  });

  it("does not take a kind or a name that only looks like HTML for it", () => {
    const mp3 = hex("fffb9064");
    expect(playerFor({ at: 0, name: "notas.html.mp3", kind: "audio/mpeg" }, mp3)?.player).toBe("audio");
    expect(playerFor({ at: 0, name: "a.mp3", kind: "text/htmlish" }, mp3)?.player).toBe("audio");
  });
});

describe("pressing a file", () => {
  it("asks for nothing before it is pressed, and only for what its document names", async () => {
    draw(alone(0));
    expect(asked).toEqual([]);
    await press(0);
    expect(asked).toEqual([`/api/v1/docs/${ID}/files/${PLAYING.document.files_hash}`]);
  });

  it.each(PLAYING.is)("alone in its paragraph: $says", async ({ at, is, held_back: heldBack }) => {
    draw(alone(at));
    await press(at);
    const player = root.querySelector<HTMLMediaElement>("audio, video");
    if (!is || heldBack) {
      expect(player).toBeNull();
      expect(clicked).toHaveLength(1);
      expect(blobs[0]?.type).toBe("application/octet-stream");
      return;
    }
    const expected = is as { player: string; type: string };
    expect(player?.tagName.toLowerCase()).toBe(expected.player);
    expect(blobs[0]?.type).toBe(expected.type);
    expect(clicked).toEqual([]);
  });

  it("makes a player that starts only when the person presses play, with nothing the file brought", async () => {
    draw(alone(0));
    await press(0);
    const player = root.querySelector("audio") as HTMLAudioElement;
    expect(player.controls).toBe(true);
    expect(player.autoplay).toBe(false);
    expect(player.loop).toBe(false);
    expect(player.querySelectorAll("track, source")).toHaveLength(0);
    expect(player.getAttribute("aria-label")).toBe(PLAYING.document.files?.[0]?.name);
    expect(root.querySelector("a[data-file]")).toBeNull();
  });

  it("saves what would play when it is a word of a sentence, and never goes to its blob", async () => {
    draw(inASentence(0));
    await press(0);
    expect(root.querySelector("audio, video")).toBeNull();
    expect(clicked).toEqual([{ name: "rina.mp3", href: "blob:https://tisty.cl/1" }]);
    expect(blobs[0]?.type).toBe("application/octet-stream");
    expect(fileAt(0).hasAttribute("href")).toBe(false);
  });

  it("saves what this browser says it cannot play, on the same press", async () => {
    playsHere = "";
    draw(alone(0));
    await press(0);
    expect(root.querySelector("audio, video")).toBeNull();
    expect(clicked).toHaveLength(1);
  });

  it("goes back to the card when the player fails, and the card saves it without asking again", async () => {
    draw(alone(0));
    await press(0);
    root.querySelector("audio")?.dispatchEvent(new place.Event("error"));
    expect(root.querySelector("audio")).toBeNull();
    expect(fileAt(0).textContent).toContain("No se puede reproducir");
    expect(fileAt(0).textContent).not.toContain("dañado");
    await press(0);
    expect(root.querySelector("audio")).toBeNull();
    expect(clicked).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  it("does not claim it was saved, and says what to do if it did not start", async () => {
    draw(inASentence(0));
    await press(0);
    const note = root.querySelector(".file-said")?.textContent ?? "";
    expect(note).toContain("presiona otra vez");
    expect(note).not.toContain("Se descargó");
    await press(0);
    expect(clicked).toHaveLength(2);
    expect(asked).toHaveLength(1);
  });

  it("marks a word of a sentence as something to press, since it has no address", () => {
    const sheet = readFileSync("src/page/ui/sheet.css", "utf8");
    expect(sheet).toMatch(/a\[data-file\]:not\(\.card\) \{[^}]*text-decoration: underline/);
    expect(sheet.indexOf("a[data-file]:not(.card)")).toBeGreaterThan(sheet.indexOf("a:not([href])"));
  });

  it("carries the focus to the player and back, and says aloud what happened", async () => {
    draw(alone(0));
    const aloud = () => place.document.getElementById("file-said")?.textContent;
    expect(place.document.getElementById("file-said")?.getAttribute("role")).toBe("status");
    fileAt(0).focus();
    await press(0);
    const player = root.querySelector("audio") as HTMLAudioElement;
    expect(root.activeElement).toBe(player);
    expect(aloud()).toBe("Listo para reproducir.");
    player.dispatchEvent(new place.Event("error"));
    expect(root.activeElement).toBe(fileAt(0));
    expect(aloud()).toContain("No se puede reproducir");
  });

  it("uses one address however many times the reader comes back to the card", async () => {
    const page = { id: "p1", page_of: ID, at: 1, title: "Otra", html: "<p>o</p>", body: "" };
    draw(alone(0), { ...PLAYING.document, pages: [page] });
    await press(0);
    const address = root.querySelector("audio")?.getAttribute("src");
    (place.document.querySelector("#pages button") as HTMLElement).click();
    place.document.getElementById("crumb-back")?.click();
    await press(0);
    expect(root.querySelector("audio")?.getAttribute("src")).toBe(address);
    expect(blobs).toHaveLength(1);
  });

  it("presses from the keyboard too", async () => {
    draw(alone(1));
    fileAt(1).dispatchEvent(new place.KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await vi.waitFor(() => expect(root.querySelector("video")).not.toBeNull());
  });

  it("says when it has not arrived, and can ask again", async () => {
    answers = [new Response(JSON.stringify({ refused: "missing" }), { status: 404 }), new Response(hex(PLAYING.files))];
    draw(alone(0));
    await press(0);
    expect(fileAt(0).textContent).toContain("no está");
    await press(0);
    expect(root.querySelector("audio")).not.toBeNull();
  });

  it("calls damaged what its document does not answer for, and saves nothing", async () => {
    draw(alone(0), { ...PLAYING.document, files_hash: "A".repeat(43) });
    await press(0);
    expect(fileAt(0).textContent).toContain("dañado");
    expect(clicked).toEqual([]);
    expect(blobs).toEqual([]);
  });

  it("says, inside a sentence, what happened beside the word", async () => {
    answers = [new Response(JSON.stringify({ refused: "blocked" }), { status: 403 })];
    draw(inASentence(0));
    await press(0);
    expect(root.querySelector(".file-said")?.textContent).toBe("Este documento fue bloqueado.");
  });

  it("draws a file named as a page like any other, and pressing it only saves it", async () => {
    draw(alone(5));
    expect(fileAt(5).textContent).toContain("Adjunto");
    expect(fileAt(5).textContent).not.toContain("Tisty");
    expect(root.querySelector("iframe, object, embed")).toBeNull();
    await press(5);
    expect(root.querySelector("iframe, object, embed, audio, video")).toBeNull();
    expect(clicked).toEqual([{ name: "rina.html", href: "blob:https://tisty.cl/1" }]);
  });
});

describe("a widget that comes to do harm", () => {
  it("stays as words, says it is no widget, and asks for nothing", () => {
    const { id, html, body } = SAMPLES.hostile_widget as Document;
    draw(html, { id, html, body } as Document);
    expect(root.querySelector("script, iframe, figure.widget")).toBeNull();
    expect(root.querySelector("code.language-widget")?.textContent).toContain("otro.example");
    expect(root.querySelector(".widget-said")?.textContent).toContain("no es un widget");
    expect(asked).toEqual([]);
  });
});
