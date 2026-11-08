import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drawHealth, drawNets, drawTiles, type Overlook } from "../src/admin/page/board";
import { drawKey } from "../src/admin/page/key";
import { drawTop, signalText } from "../src/admin/page/top";
import type { KeyView, TopDoc } from "../src/core/dashboard";

const NOW = Date.UTC(2026, 10, 8, 12);
const TODAY = Math.floor(NOW / 86_400_000);
const HARM = '<img src=x onerror="alert(1)">';

const OVERLOOK: Overlook = {
  stage: "warned",
  docs: { open: 184, newToday: 12, withLanguages: 61 },
  readers: { today: 2431, yesterday: 2060 },
  keys: { total: 96, newToday: 7, newADay: 5 },
  uploads: { today: 312, newDocs: 40 },
  stored: { gb: 3.4, heldBytes: 1, newKeysBytesToday: 600_000_000, atMostGb: 100, newKeysStopGb: 80 },
  reports: { grave: 1, medium: 2, light: 3 },
  spend: { bill: 4.12, line: 6.3, capUsd: 20, at: NOW - 60_000 },
  beats: { sweptHour: null, spentAt: NOW - 60_000, digestedHour: null },
  sharingOpen: true,
  termsVersion: "14",
  limitsSerial: 25,
  operator: "mario@…",
};

const doc = (id: string, over: Partial<TopDoc> = {}): TopDoc => ({
  id,
  owner: "O".repeat(43),
  keyDay: TODAY - 2,
  languages: 0,
  today: { nets: 10, proved: 0, hours: 4, peak: 4 },
  yesterday: null,
  ownerAtTop: false,
  bytes: 400_000,
  latest: 3,
  latestAt: NOW - 7_200_000,
  firstDay: TODAY - 1,
  ttlDays: 1,
  diesOn: TODAY + 3,
  blocked: false,
  paused: false,
  stopped: false,
  signals: [],
  ...over,
});

const VIEW: KeyView = {
  root: "K".repeat(43),
  firstDay: TODAY - 2,
  blockedAt: null,
  termsVersion: "14",
  termsHour: Math.floor(NOW / 3_600_000) - 3,
  holds: 23_400_000,
  holdsAtMost: 25_000_000,
  docs: { open: 2, expired: 5, blocked: 1 },
  versions: 14,
  asEditor: 3,
  reports: { grave: 1, medium: 0, light: 2 },
  listed: [
    {
      id: HARM.slice(0, 8),
      anchor: null,
      latest: 2,
      bytes: 11_200_000,
      firstDay: TODAY - 1,
      diesOn: TODAY + 2,
      blockedAt: null,
      pausedAt: null,
      legalUntil: null,
      alive: true,
    },
  ],
};

let page: Document;
const place = (id: string): HTMLElement => page.getElementById(id) as HTMLElement;

beforeEach(() => {
  page = new JSDOM(readFileSync("src/admin/page/index.html", "utf8")).window.document;
});

describe("the signal of a document", () => {
  it("says normal when nothing is flagged", () => {
    expect(signalText([])).toEqual({ said: "Normal", tone: "ok" });
  });

  it("names a farm of readers in one line, as an alarm", () => {
    expect(signalText([{ kind: "cap" }, { kind: "proved" }, { kind: "even" }])).toEqual({
      said: "Bots: tope de lectores, casi todo con prueba, parejo las 24 h",
      tone: "danger",
    });
  });

  it("warns of one network that keeps it alive, and alarms at many keys from one network or a grave report", () => {
    expect(signalText([{ kind: "lone", days: 57, byUploader: true }])).toEqual({
      said: "Solo la lee la red que la sube · 57 días viva",
      tone: "warn",
    });
    expect(signalText([{ kind: "keys", keys: 5, docs: 31 }]).tone).toBe("danger");
    expect(signalText([{ kind: "report", level: "grave" }]).tone).toBe("danger");
    expect(
      signalText([
        { kind: "edits", edits: 28 },
        { kind: "report", level: "medium" },
      ]),
    ).toEqual({
      said: "28 ediciones en un día · Denuncia de engaño",
      tone: "warn",
    });
  });
});

describe("the top documents", () => {
  it("shows ten first, then all of them, and opens a key from its row", () => {
    const showKey = vi.fn();
    const docs = Array.from({ length: 12 }, (_, at) => doc(`Doc${String(at).padStart(5, "0")}`));
    drawTop(page, place("top"), { order: "readers", flaggedOnly: false, docs }, NOW, { showKey });
    const rows = () => [...place("top").querySelectorAll("tbody tr")].filter((row) => !(row as HTMLElement).hidden);
    expect(place("top").querySelectorAll("th")).toHaveLength(13);
    expect(rows()).toHaveLength(10);
    expect(place("top").textContent).toContain("Se ven 10 de 12.");
    const all = [...place("top").querySelectorAll("button")].find((one) => one.textContent === "Ver los 12");
    all?.click();
    expect(rows()).toHaveLength(12);
    (place("top").querySelector("tbody button") as HTMLButtonElement).click();
    expect(showKey).toHaveBeenCalledWith("O".repeat(43));
  });

  it("says a document's ceiling, its original expiry and its signal", () => {
    const flagged = doc("K4pQx9Lm", { ownerAtTop: true, today: { nets: 5000, proved: 4750, hours: 24, peak: 220 } });
    drawTop(
      page,
      place("top"),
      { order: "readers", flaggedOnly: false, docs: [{ ...flagged, signals: [{ kind: "cap" }] }] },
      NOW,
      {
        showKey: vi.fn(),
      },
    );
    const cells = [...place("top").querySelectorAll("tbody td")].map((one) => one.textContent);
    expect(cells[2]).toBe("5.000 · tope");
    expect(cells[4]).toBe("24/24");
    expect(cells[10]).toBe("8 nov");
    expect(cells[11]).toBe("11 nov");
    expect(cells[12]).toBe("Bots: tope de lectores");
  });

  it("says which documents are no longer served, and which a report still holds", () => {
    const docs = [
      doc("StOpPeD1", { stopped: true, paused: true }),
      doc("HeLdGrv1", { stopped: true, signals: [{ kind: "report", level: "grave" }] }),
      doc("LiGhTrp1", { stopped: true, signals: [{ kind: "report", level: "light" }] }),
      doc("PaUsEd01", { paused: true }),
      doc("OpEnNow1"),
    ];
    drawTop(page, place("top"), { order: "readers", flaggedOnly: false, docs }, NOW, { showKey: vi.fn() });
    const firsts = [...place("top").querySelectorAll("tbody tr")].map((one) => one.querySelector("td")?.textContent);
    expect(firsts).toEqual([
      "StOpPeD1 ya no se sirve · se borra en la próxima limpieza",
      "HeLdGrv1 ya no se sirve · lo retiene su denuncia",
      "LiGhTrp1 ya no se sirve · se borra en la próxima limpieza",
      "PaUsEd01 en pausa",
      "OpEnNow1",
    ]);
  });

  it("says when nothing is flagged", () => {
    drawTop(page, place("top"), { order: "readers", flaggedOnly: true, docs: [] }, NOW, { showKey: vi.fn() });
    expect(place("top").textContent).toBe("Ningún documento marcado.");
  });
});

describe("a key in the panel", () => {
  const keying = () => ({ blockKey: vi.fn(), unblockKey: vi.fn(), exportKey: vi.fn() });
  const press = (said: string) =>
    ([...place("key").querySelectorAll("button")].find((one) => one.textContent === said) as HTMLButtonElement).click();

  it("says what it holds and offers to block it, export it and see its documents as words", () => {
    const doing = keying();
    drawKey(page, place("key"), VIEW, NOW, doing);
    const shown = place("key").textContent ?? "";
    expect(shown).toContain("nueva por 28 días más");
    expect(shown).toContain("23,4 MB de 25,0 MB en 2 documentos abiertos");
    expect(shown).toContain("2 abiertos · 5 caducados · 1 bloqueados");
    expect(place("key").querySelector("img")).toBeNull();
    expect(place("key").querySelector(".key-docs")?.hasAttribute("hidden")).toBe(true);
    press("Ver documentos");
    expect(place("key").querySelector(".key-docs")?.hasAttribute("hidden")).toBe(false);
    press("Exportar para autoridad");
    expect(doing.exportKey).toHaveBeenCalledWith(VIEW.root);
    press("Bloquear llave");
    expect(doing.blockKey).toHaveBeenCalledWith(VIEW.root);
  });

  it("offers to lift a blocked one instead", () => {
    const doing = keying();
    drawKey(page, place("key"), { ...VIEW, blockedAt: TODAY }, NOW, doing);
    press("Desbloquear llave");
    expect(doing.unblockKey).toHaveBeenCalledWith(VIEW.root);
  });
});

describe("the state of the service", () => {
  it("puts the bill against its cut line and says which beat is missing", () => {
    drawHealth(page, place("health"), OVERLOOK, NOW);
    const shown = place("health").textContent ?? "";
    expect(shown).toContain("4,12 de 20 USD · corte en la línea de hoy 6,30");
    expect(shown).toContain("3,4 de 100 GB · llaves nuevas paran en 80");
    expect(shown).toContain("limpieza diaria: sin latido");
    expect(place("health").querySelector("[aria-current]")?.textContent).toBe("Aviso");
    expect(place("health").querySelector(".bar-mark")?.getAttribute("style")).toContain("left: 31.5%");
  });

  it("says the bill was never reviewed rather than showing nothing", () => {
    drawHealth(page, place("health"), { ...OVERLOOK, spend: { ...OVERLOOK.spend, bill: null, line: null } }, NOW);
    expect(place("health").textContent).toContain("la revisión del gasto aún no anota nada");
  });

  it("fills the six tiles", () => {
    drawTiles(page, place("tiles"), OVERLOOK);
    expect(place("tiles").children).toHaveLength(6);
    expect(place("tiles").textContent).toContain("2.431");
    expect(place("tiles").textContent).toContain("1 graves · 2 de engaño · 3 leves");
  });

  it("says when no network is near its quota", () => {
    drawNets(page, place("nets"), { limits: { docs: 50, bytes: 2e8, keys: 5, uploadsAnHour: 60 }, nets: [] });
    expect(place("nets").textContent).toBe("Ninguna red pasa de la mitad de su cupo hoy.");
  });
});
