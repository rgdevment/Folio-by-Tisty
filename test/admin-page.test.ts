import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Doing, drawQueue } from "../src/admin/page/draw";
import type { Queue } from "../src/core/queue";

const HARM = '<img src=x onerror="alert(1)">';
const QUEUE: Queue = {
  stage: "warned",
  newKeys: 7,
  reportsTotal: 2,
  reports: [
    {
      doc: "AbCdEfGh",
      net: "n1",
      category: "csam",
      level: "grave",
      detail: HARM,
      sealedLink: "sealed1.opaque",
      version: 2,
      at: 20_000,
      asn: 3,
      fromFalseNet: false,
    },
    {
      doc: "IjKlMnOp",
      net: "n2",
      category: "phishing",
      level: "medium",
      detail: null,
      sealedLink: null,
      version: 1,
      at: 20_000,
      asn: 4,
      fromFalseNet: true,
    },
  ],
  docs: [
    {
      id: "AbCdEfGh",
      latest: 2,
      blockedAt: 20_000,
      appealedAt: 20_001,
      waitsForOperator: true,
      mayCorrect: false,
      signers: [
        { n: 1, byOwner: true },
        { n: 2, byOwner: false },
      ],
    },
    {
      id: "QrStUvWx",
      latest: 1,
      blockedAt: 20_000,
      appealedAt: 20_001,
      waitsForOperator: false,
      mayCorrect: true,
      signers: [{ n: 1, byOwner: false }],
    },
    {
      id: "YzAbCdEf",
      latest: 1,
      blockedAt: 20_000,
      appealedAt: null,
      waitsForOperator: false,
      mayCorrect: false,
      signers: [{ n: 1, byOwner: true }],
    },
  ],
};

let page: Document;
let doing: { [K in keyof Doing]: ReturnType<typeof vi.fn> };

const pressing = (place: string, said: string, at = 0): void => {
  const found = [...(page.getElementById(place) as Element).querySelectorAll("button")].filter(
    (one) => one.textContent === said,
  );
  (found[at] as HTMLButtonElement).click();
};

beforeEach(() => {
  page = new JSDOM(readFileSync("src/admin/page/index.html", "utf8")).window.document;
  doing = { accept: vi.fn(), reject: vi.fn(), reportWasFalse: vi.fn(), opened: vi.fn(), copy: vi.fn() };
  drawQueue(page, QUEUE, doing as unknown as Doing);
});

describe("the page when no answer comes, as when the session of Access ended", () => {
  const SAID_OF = () => page.getElementById("said")?.textContent;

  const opened = async (fetching: ReturnType<typeof vi.fn>): Promise<void> => {
    vi.resetModules();
    vi.stubGlobal("document", page);
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal("fetch", fetching);
    await import("../src/admin/page/main");
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says it could not load, and does not stay on loading", async () => {
    await opened(vi.fn().mockRejectedValue(new TypeError("refused by the browser")));
    await vi.waitFor(() => expect(SAID_OF()).toContain("No se pudo traer el panel"));
  });

  it("says it could not act, and does not stay working", async () => {
    await opened(
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(QUEUE)))
        .mockRejectedValue(new TypeError("refused by the browser")),
    );
    await vi.waitFor(() => expect(page.getElementById("appeals")?.querySelector("button")).not.toBeNull());
    pressing("appeals", "Rechazar");
    await vi.waitFor(() => expect(SAID_OF()).toContain("No se pudo. Recarga"));
  });
});

describe("the panel", () => {
  it("says the state of the service", () => {
    expect(page.getElementById("state")?.textContent).toBe("Servicio con aviso de gasto. Llaves nuevas hoy: 7.");
  });

  it("writes what a report brought as words, never as HTML", () => {
    const reports = page.getElementById("reports") as Element;
    expect(reports.textContent).toContain(HARM);
    expect(reports.querySelector("img")).toBeNull();
  });

  it("puts what waits for the operator apart, and offers to accept or reject it", () => {
    pressing("appeals", "Aceptar y desbloquear");
    pressing("appeals", "Rechazar");
    expect(doing.accept).toHaveBeenCalledWith("AbCdEfGh");
    expect(doing.reject).toHaveBeenCalledWith("AbCdEfGh");
    expect(page.getElementById("appeals")?.textContent).toContain("No las firmó su dueño: 2.");
  });

  it("offers nothing to lift a block whose appeal was accepted on its own", () => {
    const blocked = page.getElementById("blocked") as Element;
    const cards = blocked.querySelectorAll(".card");
    expect(cards[0]?.textContent).toContain("espera una versión de su dueño");
    expect(cards[0]?.querySelector("button")).toBeNull();
    pressing("blocked", "Desbloquear");
    expect(doing.accept).toHaveBeenCalledWith("YzAbCdEf");
  });

  it("hands over a sealed link only as a command for the operator's own machine", () => {
    pressing("reports", "Copiar para abrir");
    expect(doing.copy).toHaveBeenCalledWith("node scripts/report-key.mjs open <llave> AbCdEfGh sealed1.opaque");
    pressing("reports", "Anotar apertura");
    expect(doing.opened).toHaveBeenCalledWith("AbCdEfGh");
  });

  it("offers to mark any report false, and opening only where a link came", () => {
    pressing("reports", "Era falsa", 1);
    expect(doing.reportWasFalse).toHaveBeenCalledWith("IjKlMnOp", "n2");
    const second = (page.getElementById("reports") as Element).querySelectorAll(".card")[1];
    expect(second?.textContent).not.toContain("Copiar para abrir");
  });

  it("says which reports come from a network already marked false", () => {
    const [first, second] = (page.getElementById("reports") as Element).querySelectorAll(".card");
    expect(first?.textContent).not.toContain("denuncia falsa");
    expect(second?.textContent).toContain("denuncia falsa");
  });

  it("says when some reports did not fit, and not otherwise", () => {
    expect(page.getElementById("reports")?.textContent).not.toContain("Se ven las");
    drawQueue(page, { ...QUEUE, reportsTotal: 900 }, doing as unknown as Doing);
    expect(page.getElementById("reports")?.textContent).toContain("Se ven las 2 más graves y recientes de 900.");
  });

  it("says when there is nothing", () => {
    drawQueue(page, { stage: "open", newKeys: 0, reportsTotal: 0, reports: [], docs: [] }, doing as unknown as Doing);
    expect(page.getElementById("reports")?.textContent).toBe("Ninguna.");
    expect(page.getElementById("appeals")?.textContent).toBe("Ninguno.");
  });

  it("is served under a policy that lets nothing else run or leave", () => {
    const headers = readFileSync("src/admin/page/public/_headers", "utf8");
    expect(headers).toContain("default-src 'none'");
    expect(headers).toContain("script-src 'self'");
    expect(headers).not.toContain("unsafe");
    expect(headers).toContain("no-transform");
  });
});
