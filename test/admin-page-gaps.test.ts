import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawHealth, drawNets, type Overlook } from "../src/admin/page/board";
import { madeCase } from "../src/admin/page/case";
import { type Doing, drawQueue } from "../src/admin/page/draw";
import { drawKey } from "../src/admin/page/key";
import { ago, when } from "../src/admin/page/say";
import type { KeyView } from "../src/core/dashboard";
import type { Queue } from "../src/core/queue";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8, 12);
const SANTIAGO = "America/Santiago";

const OVERLOOK: Overlook = {
  stage: "open",
  docs: { open: 1, newToday: 0, withLanguages: 0 },
  readers: { today: 0, yesterday: null },
  keys: { total: 1, newToday: 0, newADay: 5 },
  uploads: { today: 0, newDocs: 0 },
  stored: { gb: 1, heldBytes: 1, newKeysBytesToday: 0, atMostGb: 100, newKeysStopGb: 80 },
  reports: { grave: 0, medium: 0, light: 0 },
  spend: { bill: 1, line: 8, capUsd: 20, at: NOW },
  beats: { sweptHour: Math.floor(NOW / HOUR), spentAt: NOW, digestedHour: null },
  sharingOpen: true,
  termsVersion: "14",
  limitsSerial: 25,
  operator: "",
};

const fresh = (): Document => new JSDOM(readFileSync("src/admin/page/index.html", "utf8")).window.document;
const fillOf = (place: Element): string => place.querySelector(".bar-fill")?.className ?? "";

describe("the times the panel writes for an operator who is not in UTC", () => {
  let zone: string | undefined;

  beforeEach(() => {
    zone = process.env.TZ;
    process.env.TZ = SANTIAGO;
  });

  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("calls hoy what happened earlier on the operator's own day", () => {
    const now = Date.UTC(2026, 10, 7, 1, 0);
    const earlier = Date.UTC(2026, 10, 6, 23, 0);
    const day = (ms: number) => new Date(ms).toLocaleDateString("es-CL", { timeZone: SANTIAGO });
    expect(day(earlier)).toBe(day(now));
    expect(when(earlier, now)).toMatch(/^hoy /);
  });

  it("does not write a date where it writes hours, a minute before the day is up", () => {
    expect(ago(NOW - 23.6 * HOUR, NOW)).toBe("hace 24 h");
  });
});

describe("the words for how long ago", () => {
  it.each([
    [29_000, "recién"],
    [MINUTE, "hace 1 min"],
    [59 * MINUTE, "hace 59 min"],
    [60 * MINUTE, "hace 1 h"],
    [23 * HOUR, "hace 23 h"],
  ])("says %i ms ago as %s", (past, said) => {
    expect(ago(NOW - past, NOW)).toBe(said);
  });

  it("calls ayer a day and a half back, and not three days", () => {
    expect(ago(NOW - 30 * HOUR, NOW)).toBe("ayer");
    expect(ago(NOW - 72 * HOUR, NOW)).not.toBe("ayer");
  });

  it("calls ayer only what happened the day before", () => {
    expect(when(NOW - DAY, NOW)).toMatch(/^ayer /);
    expect(when(NOW - 2 * DAY, NOW)).not.toMatch(/^(ayer|hoy) /);
  });
});

describe("the tones that warn the operator", () => {
  it.each([
    [0.79, "is-accent"],
    [0.8, "is-warn"],
  ])("draws a network at %f of its cupo as %s", (share, tone) => {
    const page = fresh();
    const where = page.getElementById("nets") as Element;
    const limits = { docs: 50, bytes: 2e8, keys: 5, uploadsAnHour: 60 };
    drawNets(page, where, {
      limits,
      nets: [{ net: "N".repeat(43), docs: 1, bytes: 1, keys: 1, uploadsThisHour: 1, share }],
    });
    expect(fillOf(where)).toContain(tone);
  });

  it.each([
    [5.9, "is-accent"],
    [6, "is-warn"],
    [7.9, "is-warn"],
    [8, "is-danger"],
  ])("draws a bill of %f against a line of 8 as %s", (bill, tone) => {
    const page = fresh();
    const where = page.getElementById("health") as Element;
    drawHealth(page, where, { ...OVERLOOK, spend: { ...OVERLOOK.spend, bill } }, NOW);
    expect(fillOf(page.querySelector(".meter") as Element)).toContain(tone);
  });

  it.each([
    [26 * HOUR, "✓"],
    [26 * HOUR + 1, "✗"],
  ])("calls a sweep %i ms old %s", (old, mark) => {
    const page = fresh();
    const seen = { ...OVERLOOK, beats: { ...OVERLOOK.beats, sweptHour: (NOW - old) / HOUR } };
    drawHealth(page, page.getElementById("health") as Element, seen, NOW);
    expect(page.querySelector(".beats")?.textContent).toContain(`limpieza diaria ${mark}`);
  });

  it.each([
    [HOUR, "✓"],
    [HOUR + 1, "✗"],
  ])("calls a spend check %i ms old %s", (old, mark) => {
    const page = fresh();
    const seen = { ...OVERLOOK, beats: { ...OVERLOOK.beats, spentAt: NOW - old } };
    drawHealth(page, page.getElementById("health") as Element, seen, NOW);
    expect(page.querySelector(".beats")?.textContent).toContain(`gasto ${mark}`);
  });

  it.each([
    [0.89, "is-accent"],
    [0.9, "is-warn"],
  ])("draws a key holding %f of its room as %s", (share, tone) => {
    const page = fresh();
    const where = page.getElementById("key") as HTMLElement;
    const view: KeyView = {
      root: "K".repeat(43),
      firstDay: null,
      blockedAt: null,
      termsVersion: null,
      termsHour: null,
      holds: share * 1000,
      holdsAtMost: 1000,
      docs: { open: 0, expired: 0, blocked: 0 },
      versions: 0,
      asEditor: 0,
      reports: { grave: 0, medium: 0, light: 0 },
      listed: [],
    };
    drawKey(page, where, view, NOW, { blockKey: vi.fn(), unblockKey: vi.fn(), exportKey: vi.fn() });
    expect(fillOf(where)).toContain(tone);
  });
});

describe("a case link", () => {
  it("carries a token the server will read, of 43 letters, and a new one each time", async () => {
    const made = await madeCase("AbCdEfGh", 1);
    expect(made.link).toMatch(/^https:\/\/tisty\.cl\/AbCdEfGh#caso\.[A-Za-z0-9_-]{43}$/);
    expect(made.body.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await madeCase("AbCdEfGh", 1)).link).not.toBe(made.link);
  });

  it("carries the key of the records after the token, of 43 letters", async () => {
    const made = await madeCase("AbCdEfGh", 1, { reports: [] });
    expect(made.link).toMatch(/#caso\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  });
});

describe("the commands the panel hands over", () => {
  it("holds nothing a shell would run, whatever a stored report says", () => {
    const page = fresh();
    const queue: Queue = {
      stage: "open",
      blockedKeys: [],
      newKeys: 0,
      reportsTotal: 1,
      reportsFrom: 0,
      warned: [],
      docs: [],
      reports: [
        {
          doc: "AbCdEfGh",
          ownerToBlock: null,
          net: "n1",
          category: "csam",
          level: "grave",
          detail: null,
          sealedLink: 'sealed1.x"; touch /tmp/pwned; echo "',
          sealedContact: null,
          version: 1,
          at: 20_000,
          asn: 1,
          fromFalseNet: false,
          overCap: false,
        },
      ],
    };
    const openReport = vi.fn();
    const copy = vi.fn();
    const doing = new Proxy({ openReport, copy }, { get: (one, name) => one[name as "copy"] ?? vi.fn() });
    drawQueue(page, queue, doing as unknown as Doing);
    for (const said of ["Abrir denuncia", "Comprobar sin abrir"]) {
      [...page.querySelectorAll("button")].find((one) => one.textContent === said)?.click();
    }
    const commands = [openReport.mock.calls[0]?.[1], copy.mock.calls[0]?.[0]].map(String);
    for (const command of commands) expect(command).not.toContain(";");
  });
});
