import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offerThemes } from "../src/page/ui/theme";

const KEY = "theme";

let place: Window & typeof globalThis;
let kept: Map<string, string>;
let followers: (() => void)[];
let systemIsDark: boolean;

const root = () => place.document.documentElement;
const toggle = () => place.document.getElementById("theme") as HTMLButtonElement;
const sheet = () => place.document.getElementById("sheet") as HTMLElement;

beforeEach(() => {
  place = new JSDOM('<!doctype html><button id="theme"></button><div id="sheet"></div>').window as never;
  kept = new Map();
  followers = [];
  systemIsDark = false;
  vi.stubGlobal("document", place.document);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
    removeItem: (key: string) => kept.delete(key),
  });
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return systemIsDark;
    },
    addEventListener: (_: string, follow: () => void) => followers.push(follow),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the theme", () => {
  it("follows the system until the reader chooses, and keeps nothing", () => {
    systemIsDark = true;
    offerThemes();
    expect(sheet().dataset.theme).toBe("dark");
    expect(root().dataset.theme).toBeUndefined();
    expect(kept.size).toBe(0);
  });

  it("keeps what differs from the system", () => {
    offerThemes();
    toggle().click();
    expect(root().dataset.theme).toBe("dark");
    expect(sheet().dataset.theme).toBe("dark");
    expect(kept.get(KEY)).toBe("dark");
    expect(toggle().title).toBe("Usar el modo claro");
  });

  it("forgets the choice on going back to the system's theme, and follows it again", () => {
    offerThemes();
    toggle().click();
    toggle().click();
    expect(root().dataset.theme).toBeUndefined();
    expect(kept.has(KEY)).toBe(false);
    systemIsDark = true;
    for (const follow of followers) follow();
    expect(sheet().dataset.theme).toBe("dark");
  });

  it("stays with the reader's choice when the system changes", () => {
    root().dataset.theme = "light";
    systemIsDark = true;
    offerThemes();
    for (const follow of followers) follow();
    expect(sheet().dataset.theme).toBe("light");
  });

  it("still changes when the browser keeps nothing", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    offerThemes();
    toggle().click();
    expect(root().dataset.theme).toBe("dark");
  });
});
