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
      sealedContact: "contact1.opaque",
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
      sealedContact: null,
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
      versionToOpen: 1,
      mayHandOver: false,
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
      versionToOpen: 1,
      mayHandOver: false,
      signers: [{ n: 1, byOwner: false }],
    },
    {
      id: "YzAbCdEf",
      latest: 1,
      blockedAt: 20_000,
      appealedAt: null,
      waitsForOperator: false,
      mayCorrect: false,
      versionToOpen: 1,
      mayHandOver: true,
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
  doing = {
    accept: vi.fn(),
    reject: vi.fn(),
    reportWasFalse: vi.fn(),
    opened: vi.fn(),
    copy: vi.fn(),
    panic: vi.fn(),
    verifyLink: vi.fn(),
    handedOver: vi.fn(),
    forgetContact: vi.fn(),
  };
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

describe("a case in the panel", () => {
  const CASE_LINK = () => page.getElementById("case-link-code")?.textContent ?? "";
  const answering = (over: Record<string, () => Response> = {}) =>
    vi.fn(async (path: string, _asked?: RequestInit) => {
      const answer = Object.entries(over).find(([end]) => path.endsWith(end));
      if (answer) return answer[1]();
      if (path === "/api/queue") return new Response(JSON.stringify(QUEUE));
      if (path.endsWith("/panic")) return new Response(JSON.stringify({ records: { id: "AbCdEfGh" } }));
      return new Response(JSON.stringify({ done: true }));
    });
  const opened = async (fetching: ReturnType<typeof answering>, reason: string | null = "looks real") => {
    vi.resetModules();
    vi.stubGlobal("document", page);
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal("prompt", () => reason);
    vi.stubGlobal("fetch", fetching);
    await import("../src/admin/page/main");
    await vi.waitFor(() => expect(page.getElementById("reports")?.querySelector("button")).not.toBeNull());
  };
  const paths = (fetching: ReturnType<typeof answering>) => fetching.mock.calls.map(([path]) => path);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("panics first, then makes the link for the authority with its records sealed", async () => {
    const fetching = answering();
    await opened(fetching);
    pressing("reports", "Botón de pánico");
    await vi.waitFor(() => expect(CASE_LINK()).toContain("#caso."));
    expect(CASE_LINK().split("#")[1]?.split(".")).toHaveLength(3);
    const sent = paths(fetching).filter((path) => path !== "/api/queue");
    expect(sent).toEqual(["/api/docs/AbCdEfGh/panic", "/api/docs/AbCdEfGh/case"]);
    const made = JSON.parse(fetching.mock.calls.at(-1)?.[1]?.body as string);
    expect(made.version).toBe(2);
    expect(made.sealedRecords).toMatch(/^case1\./);
    expect(page.getElementById("case-link")?.hidden).toBe(false);
  });

  it("does nothing without a reason", async () => {
    const fetching = answering();
    await opened(fetching, "  ");
    pressing("reports", "Botón de pánico");
    expect(paths(fetching).filter((path) => path !== "/api/queue")).toEqual([]);
  });

  it("makes no link when the panic did not hold", async () => {
    const fetching = answering({ "/panic": () => new Response("{}", { status: 500 }) });
    await opened(fetching);
    pressing("reports", "Botón de pánico");
    await vi.waitFor(() => expect(page.getElementById("said")?.textContent).toContain("No se pudo"));
    expect(paths(fetching).some((path) => path.endsWith("/case"))).toBe(false);
  });

  it("says it stayed held when only the link failed", async () => {
    const fetching = answering({ "/case": () => new Response("{}", { status: 400 }) });
    await opened(fetching);
    pressing("reports", "Botón de pánico");
    await vi.waitFor(() => expect(page.getElementById("said")?.textContent).toContain("Quedó bloqueado y retenido"));
    expect(page.getElementById("case-link")?.hidden).toBe(true);
  });

  it("keeps the link on screen through the next action, and copies it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const fetching = answering();
    await opened(fetching);
    pressing("reports", "Link para verificar");
    await vi.waitFor(() => expect(CASE_LINK()).toContain("#caso."));
    const link = CASE_LINK();
    expect(link.split("#")[1]?.split(".")).toHaveLength(2);
    pressing("appeals", "Rechazar");
    await vi.waitFor(() => expect(paths(fetching).some((path) => path.endsWith("/reject"))).toBe(true));
    await vi.waitFor(() => expect(page.getElementById("said")?.textContent).toBe(""));
    expect(CASE_LINK()).toBe(link);
    page.getElementById("case-link-copy")?.click();
    expect(writeText).toHaveBeenCalledWith(link);
  });
});

describe("the panel", () => {
  it("says the state of the service", () => {
    expect(page.getElementById("state")?.textContent).toBe("Servicio con aviso de gasto. Llaves nuevas hoy: 7.");
  });

  it("says when only old keys can upload", () => {
    drawQueue(page, { ...QUEUE, stage: "new_keys_off" }, doing as unknown as Doing);
    expect(page.getElementById("state")?.textContent).toContain("subidas solo de llaves antiguas");
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
    const offered = [...(cards[0] as Element).querySelectorAll("button")].map((one) => one.textContent);
    expect(offered).toEqual(["Link para verificar", "Botón de pánico"]);
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

  it("warns that nobody checked the address, and offers to erase it", () => {
    expect(page.getElementById("reports")?.textContent).toContain("correo sin comprobar");
    pressing("reports", "Borrar su correo");
    expect(doing.forgetContact).toHaveBeenCalledWith("AbCdEfGh", "n1");
    const offered = [...(page.getElementById("reports") as Element).querySelectorAll("button")];
    expect(offered.filter((one) => one.textContent === "Borrar su correo")).toHaveLength(1);
  });

  it("hands over a sealed email only as a command, on the report that brought one", () => {
    pressing("reports", "Copiar para leer su correo");
    expect(doing.copy).toHaveBeenCalledWith(
      expect.stringContaining("report-key.mjs open <llave> AbCdEfGh contact1.opaque"),
    );
    expect(page.getElementById("reports")?.textContent).not.toContain("contact1.opaque");
    const offered = [...(page.getElementById("reports") as Element).querySelectorAll("button")];
    expect(offered.filter((one) => one.textContent === "Copiar para leer su correo")).toHaveLength(1);
  });

  it("offers a report's own version to verify and to panic", () => {
    pressing("reports", "Link para verificar");
    expect(doing.verifyLink).toHaveBeenCalledWith("AbCdEfGh", 2);
    pressing("reports", "Botón de pánico", 1);
    expect(doing.panic).toHaveBeenCalledWith("IjKlMnOp", 1);
    expect(page.getElementById("reports")?.textContent).not.toContain("Ya lo entregué");
  });

  it("offers a blocked document's reported version, and says which it is", () => {
    pressing("appeals", "Botón de pánico");
    expect(doing.panic).toHaveBeenCalledWith("AbCdEfGh", 1);
    pressing("appeals", "Link para verificar");
    expect(doing.verifyLink).toHaveBeenCalledWith("AbCdEfGh", 1);
    expect(page.getElementById("appeals")?.textContent).toContain("abre la versión 1");
  });

  it("offers to hand over only what is ready for it", () => {
    const buttons = [...(page.getElementById("blocked") as Element).querySelectorAll("button")];
    expect(buttons.filter((one) => one.textContent === "Ya lo entregué")).toHaveLength(1);
    pressing("blocked", "Ya lo entregué");
    expect(doing.handedOver).toHaveBeenCalledWith("YzAbCdEf");
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
    const rule = headers.split("\n\n")[0] ?? "";
    expect(rule.startsWith("/*\n")).toBe(true);
    expect(rule).toContain("no-transform");
  });
});
