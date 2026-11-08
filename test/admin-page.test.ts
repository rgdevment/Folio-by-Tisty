import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Doing, drawQueue } from "../src/admin/page/draw";
import { dayText } from "../src/admin/page/say";
import type { Queue } from "../src/core/queue";

const HARM = '<img src=x onerror="alert(1)">';
const QUEUE: Queue = {
  stage: "warned",
  blockedKeys: [{ root: "BLOCKEDROOT", blockedAt: 20400 }],
  newKeys: 7,
  reportsTotal: 2,
  reportsFrom: 0,
  warned: [{ id: "WaRnEdDc", fixBy: 20_003, nets: 12 }],
  reports: [
    {
      doc: "AbCdEfGh",
      ownerToBlock: "OWNERROOT",
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
      overCap: false,
    },
    {
      doc: "IjKlMnOp",
      ownerToBlock: null,
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
      overCap: false,
    },
  ],
  docs: [
    {
      id: "AbCdEfGh",
      ownerToBlock: "OWNERROOT",
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
      ownerToBlock: null,
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
      ownerToBlock: "OWNERROOT",
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
    blockKey: vi.fn(),
    unblockKey: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    reportWasFalse: vi.fn(),
    openReport: vi.fn(),
    copy: vi.fn(),
    panic: vi.fn(),
    purgeOwner: vi.fn(),
    verifyLink: vi.fn(),
    handedOver: vi.fn(),
    forgetContact: vi.fn(),
    reportsPage: vi.fn(),
    networkWasFalse: vi.fn(),
    clearWarning: vi.fn(),
    showKey: vi.fn(),
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

describe("blocking a key from the panel", () => {
  const posted = async (press: () => void) => {
    const fetching = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(QUEUE)));
    vi.resetModules();
    vi.stubGlobal("document", page);
    vi.stubGlobal("fetch", fetching);
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal("prompt", () => "granja de spam");
    await import("../src/admin/page/main");
    await vi.waitFor(() => expect(page.getElementById("blocked-keys")?.querySelector("button")).not.toBeNull());
    press();
    await vi.waitFor(() => expect(fetching.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    return fetching.mock.calls.filter(([, init]) => init?.method === "POST");
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the owner's key with its reason", async () => {
    const sent = await posted(() => pressing("reports", "Bloquear llave del dueño"));
    expect(sent[0]?.[0]).toBe("/api/keys/OWNERROOT/block");
    expect(JSON.parse(String(sent[0]?.[1]?.body))).toEqual({ note: "granja de spam" });
  });

  it("lifts a blocked key", async () => {
    const sent = await posted(() => pressing("blocked-keys", "Desbloquear llave"));
    expect(sent[0]?.[0]).toBe("/api/keys/BLOCKEDROOT/unblock");
  });
});

describe("erasing a key from the panel", () => {
  const SAID_OF = () => page.getElementById("said")?.textContent;
  const BUTTON = "Borrar todo de esta llave";

  const opened = async (typed: Array<string | null>, preview = { purged: 3, kept: 1 }) => {
    const questions: string[] = [];
    const answers = [...typed];
    const fetching = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/queue")) return new Response(JSON.stringify(QUEUE));
      const said = init?.method === "POST" ? { purged: 3, kept: 1 } : preview;
      return new Response(JSON.stringify(said));
    });
    vi.resetModules();
    vi.stubGlobal("document", page);
    vi.stubGlobal("fetch", fetching);
    vi.stubGlobal("prompt", (asked: string) => {
      questions.push(asked);
      return answers.shift() ?? null;
    });
    await import("../src/admin/page/main");
    await vi.waitFor(() => expect(fetching).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 0));
    const erasing = () =>
      fetching.mock.calls.filter(([path, init]) => path.endsWith("/purge_owner") && init?.method === "POST");
    return { questions, erasing };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says how many first, and erases only with that number and a reason", async () => {
    const { questions, erasing } = await opened(["3", "granja de spam"]);
    pressing("reports", BUTTON);
    await vi.waitFor(() => expect(erasing()).toHaveLength(1));
    expect(questions[0]).toContain("Se borrarán 3 documentos");
    expect(questions[0]).toContain("se conservan 1");
    expect(JSON.parse(String(erasing()[0]?.[1]?.body))).toEqual({ note: "granja de spam" });
    await vi.waitFor(() => expect(SAID_OF()).toContain("Dejaron de servirse 3"));
    expect(SAID_OF()).toContain("espera si el servicio está cortado");
  });

  it.each<[Array<string | null>]>([[["2"]], [[""]], [[null]], [["3", ""]], [["3", null]]])(
    "erases nothing when told %j",
    async (typed) => {
      const { questions, erasing } = await opened(typed);
      pressing("reports", BUTTON);
      await vi.waitFor(() => expect(questions).toHaveLength(typed.length));
      await new Promise((done) => setTimeout(done, 0));
      expect(erasing()).toHaveLength(0);
    },
  );

  it("asks nothing when there is nothing to erase", async () => {
    const { questions, erasing } = await opened([], { purged: 0, kept: 2 });
    pressing("reports", BUTTON);
    await vi.waitFor(() => expect(SAID_OF()).toContain("Se conservan 2"));
    expect(questions).toEqual([]);
    expect(erasing()).toHaveLength(0);
  });
});

describe("a warning by light reports", () => {
  it("shows how many networks and until when, and can be removed", () => {
    const shown = page.getElementById("warned")?.textContent;
    expect(shown).toContain("WaRnEdDc");
    expect(shown).toContain("12 redes");
    expect(shown).toContain(dayText(20_003));
    pressing("warned", "Quitar aviso");
    expect(doing.clearWarning).toHaveBeenCalledWith("WaRnEdDc");
  });

  it("says when there is none", () => {
    drawQueue(page, { ...QUEUE, warned: [] }, doing as unknown as Doing);
    const part = page.getElementById("warned")?.closest(".queue-part") as HTMLElement;
    expect(part.hidden).toBe(true);
    expect(page.getElementById("warned")?.textContent).toBe("");
  });
});

describe("a network past its documents", () => {
  it("says so on its report, and only there", () => {
    expect(page.getElementById("reports")?.textContent).not.toContain("pasó su tope");
    const [first, ...rest] = QUEUE.reports;
    drawQueue(
      page,
      { ...QUEUE, reports: [{ ...(first as (typeof QUEUE.reports)[number]), overCap: true }, ...rest] },
      doing as unknown as Doing,
    );
    expect(page.getElementById("reports")?.textContent).toContain("pasó su tope");
  });
});

describe("checking a key", () => {
  it("copies a command that opens nothing, only where a link came", () => {
    pressing("reports", "Comprobar sin abrir");
    expect(doing.copy).toHaveBeenCalledWith(
      'node scripts/report-key.mjs check ~/folio-reports.key AbCdEfGh sealed1.opaque "<link para verificar>"',
      "Cambia <link para verificar> por uno del panel, entre las comillas. Dice si la llave abre ese documento, sin leer nada.",
      expect.anything(),
    );
    const buttons = [...(page.getElementById("reports") as Element).querySelectorAll("button")];
    expect(buttons.filter((one) => one.textContent === "Comprobar sin abrir")).toHaveLength(1);
  });
});

describe("a network found false", () => {
  it("offers to discard all its reports, only on its own", () => {
    const offered = [...(page.getElementById("reports") as Element).querySelectorAll("button")];
    expect(offered.filter((one) => one.textContent === "Descartar todas las de esta red")).toHaveLength(1);
    pressing("reports", "Descartar todas las de esta red");
    expect(doing.networkWasFalse).toHaveBeenCalledWith("IjKlMnOp", "n2");
  });
});

describe("pages of reports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const drawn = (reportsFrom: number, reportsTotal: number) =>
    drawQueue(page, { ...QUEUE, reportsFrom, reportsTotal }, doing as unknown as Doing);

  it("offers nothing when all of them are in sight", () => {
    expect(page.getElementById("reports")?.textContent).not.toContain("Se ven de");
  });

  it("offers the next ones when some did not fit, and says which are in sight", () => {
    drawn(0, 450);
    expect(page.getElementById("reports")?.textContent).toContain("Se ven de la 1 a la 2 de 450.");
    pressing("reports", "Ver las siguientes");
    expect(doing.reportsPage).toHaveBeenCalledWith(2);
    expect(page.getElementById("reports")?.textContent).not.toContain("Volver al inicio");
  });

  it("offers the way back from further in, and nothing further at the end", () => {
    drawn(448, 450);
    pressing("reports", "Volver al inicio");
    expect(doing.reportsPage).toHaveBeenCalledWith(0);
    expect(page.getElementById("reports")?.textContent).not.toContain("Ver las siguientes");
  });

  it("goes back to the start when acting left the page empty", async () => {
    const fetching = vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path === "/api/queue" ? { ...QUEUE, reportsTotal: 450 } : { ...QUEUE, reports: [], reportsFrom: 2 },
          ),
        ),
    );
    vi.resetModules();
    vi.stubGlobal("document", page);
    vi.stubGlobal("fetch", fetching);
    await import("../src/admin/page/main");
    await vi.waitFor(() => expect(page.getElementById("reports")?.textContent).toContain("Se ven de"));
    pressing("reports", "Ver las siguientes");
    await vi.waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe("/api/queue"));
    await vi.waitFor(() => expect(page.getElementById("reports")?.textContent).toContain("Se ven de la 1 a la 2"));
  });

  it("asks the server for that page, and stays on it after acting", async () => {
    const fetching = vi.fn(async (_path: string) => new Response(JSON.stringify({ ...QUEUE, reportsTotal: 450 })));
    vi.resetModules();
    vi.stubGlobal("document", page);
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal("fetch", fetching);
    await import("../src/admin/page/main");
    await vi.waitFor(() => expect(page.getElementById("reports")?.textContent).toContain("Se ven de"));
    pressing("reports", "Ver las siguientes");
    await vi.waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe("/api/queue?from=2"));
    pressing("appeals", "Rechazar");
    await vi.waitFor(() => expect(fetching.mock.calls.filter(([path]) => path === "/api/queue?from=2").length).toBe(2));
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
    pressing("reports", "Bloquear documento");
    await vi.waitFor(() => expect(CASE_LINK()).toContain("#caso."));
    expect(CASE_LINK().split("#")[1]?.split(".")).toHaveLength(3);
    const sent = paths(fetching).filter((path) => path.startsWith("/api/docs/"));
    expect(sent).toEqual(["/api/docs/AbCdEfGh/panic", "/api/docs/AbCdEfGh/case"]);
    const made = JSON.parse(fetching.mock.calls.at(-1)?.[1]?.body as string);
    expect(made.version).toBe(2);
    expect(made.sealedRecords).toMatch(/^case1\./);
    expect(page.getElementById("case-link")?.hidden).toBe(false);
  });

  it("opens a report with one button: notes why, then copies what gives its link", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const fetching = answering();
    await opened(fetching, "verificar la denuncia");
    pressing("reports", "Abrir denuncia");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    const noted = fetching.mock.calls.find(([path]) => path === "/api/docs/AbCdEfGh/opened");
    expect(JSON.parse(String(noted?.[1]?.body))).toEqual({ note: "verificar la denuncia" });
    expect(writeText).toHaveBeenCalledWith(
      "node scripts/report-key.mjs open ~/folio-reports.key AbCdEfGh sealed1.opaque",
    );
    const card = (page.getElementById("reports") as Element).querySelector(".card") as Element;
    await vi.waitFor(() => expect(card.querySelector(".card-steps")).not.toBeNull());
    const steps = card.querySelector(".card-steps") as Element;
    expect(steps.textContent).toContain("Copiado.");
    expect(steps.textContent).toContain("Imprime el link de la denuncia");
    expect(steps.querySelector("code")?.textContent).toBe(
      "node scripts/report-key.mjs open ~/folio-reports.key AbCdEfGh sealed1.opaque",
    );
    expect(page.getElementById("said")?.textContent).toBe("");
  });

  it("shows the command on its card when the copy fails, once however many times it is asked", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await opened(answering(), "verificar");
    pressing("reports", "Comprobar sin abrir");
    pressing("reports", "Comprobar sin abrir");
    const card = (page.getElementById("reports") as Element).querySelector(".card") as Element;
    await vi.waitFor(() => expect(card.textContent).toContain("Dice si la llave abre"));
    expect(card.querySelectorAll(".card-steps")).toHaveLength(1);
    expect(card.querySelector(".card-steps")?.textContent).toContain("No se pudo copiar: cópialo de aquí.");
    expect(card.querySelector(".card-steps code")?.textContent).toContain("report-key.mjs check");
  });

  it("copies nothing when the opening could not be noted, or had no reason", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const refusing = answering({ "/opened": () => new Response("{}", { status: 500 }) });
    await opened(refusing);
    pressing("reports", "Abrir denuncia");
    await vi.waitFor(() => expect(page.getElementById("said")?.textContent).toContain("No se pudo"));
    const silent = answering();
    await opened(silent, " ");
    pressing("reports", "Abrir denuncia");
    expect(silent.mock.calls.some(([path]) => path.endsWith("/opened"))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does nothing without a reason", async () => {
    const fetching = answering();
    await opened(fetching, "  ");
    pressing("reports", "Bloquear documento");
    expect(paths(fetching).filter((path) => path.startsWith("/api/docs/"))).toEqual([]);
  });

  it("makes no link when the panic did not hold", async () => {
    const fetching = answering({ "/panic": () => new Response("{}", { status: 500 }) });
    await opened(fetching);
    pressing("reports", "Bloquear documento");
    await vi.waitFor(() => expect(page.getElementById("said")?.textContent).toContain("No se pudo"));
    expect(paths(fetching).some((path) => path.endsWith("/case"))).toBe(false);
  });

  it("says it stayed held when only the link failed", async () => {
    const fetching = answering({ "/case": () => new Response("{}", { status: 400 }) });
    await opened(fetching);
    pressing("reports", "Bloquear documento");
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
    expect(page.getElementById("state")?.textContent).toBe("Servicio con aviso de gasto");
  });

  it("offers to purge a key from a report and from a blocked document", () => {
    pressing("reports", "Borrar todo de esta llave");
    expect(doing.purgeOwner).toHaveBeenLastCalledWith(QUEUE.reports[0]?.doc);
    pressing("blocked", "Borrar todo de esta llave");
    expect(QUEUE.docs.map((one) => one.id)).toContain(doing.purgeOwner.mock.lastCall?.[0]);
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
    expect(offered).toEqual(["Link para verificar", "Preparar entrega a la autoridad", "Borrar todo de esta llave"]);
    pressing("blocked", "Desbloquear");
    expect(doing.accept).toHaveBeenCalledWith("YzAbCdEf");
  });

  it("hands over a sealed link only as a command for the operator's own machine", () => {
    pressing("reports", "Abrir denuncia");
    expect(doing.openReport).toHaveBeenCalledWith(
      "AbCdEfGh",
      "node scripts/report-key.mjs open ~/folio-reports.key AbCdEfGh sealed1.opaque",
      expect.anything(),
    );
    expect(page.getElementById("reports")?.textContent).not.toContain("sealed1.opaque");
  });

  it("offers to mark any report false, and opening only where a link came", () => {
    pressing("reports", "Era falsa", 1);
    expect(doing.reportWasFalse).toHaveBeenCalledWith("IjKlMnOp", "n2");
    const second = (page.getElementById("reports") as Element).querySelectorAll(".card")[1];
    expect(second?.textContent).not.toContain("Abrir denuncia");
  });

  it("says how many networks and providers reported each document, and how far it is from a block", () => {
    const [first, second] = (page.getElementById("reports") as Element).querySelectorAll(".card");
    expect(first?.textContent).toContain("1 red de 1 proveedor · bloqueado · trae link sellado");
    expect(second?.textContent).toContain("1 red de 1 proveedor · 0 de 3 redes y 0 de 2 proveedores para bloquear");
    const [grave, medium] = QUEUE.reports as [(typeof QUEUE.reports)[number], (typeof QUEUE.reports)[number]];
    drawQueue(
      page,
      {
        ...QUEUE,
        docs: [],
        reports: [
          { ...medium, fromFalseNet: false, net: "a", asn: 1 },
          { ...medium, fromFalseNet: false, net: "b", asn: 2 },
          { ...medium, fromFalseNet: false, net: "c", asn: 2, overCap: true },
          { ...grave, doc: "IjKlMnOp", sealedLink: null, net: "d", asn: 9 },
        ],
      },
      doing as unknown as Doing,
    );
    const counted = (page.getElementById("reports") as Element).querySelector(".card")?.textContent;
    expect(counted).toContain("4 redes de 3 proveedores · 2 de 3 redes y 2 de 2 proveedores para bloquear");
  });

  it("says which reports come from a network already marked false", () => {
    const [first, second] = (page.getElementById("reports") as Element).querySelectorAll(".card");
    expect(first?.textContent).not.toContain("denuncia falsa");
    expect(second?.textContent).toContain("denuncia falsa");
  });

  it("says when some reports did not fit, and not otherwise", () => {
    expect(page.getElementById("reports")?.textContent).not.toContain("Se ven de");
    drawQueue(page, { ...QUEUE, reportsTotal: 900 }, doing as unknown as Doing);
    expect(page.getElementById("reports")?.textContent).toContain("Se ven de la 1 a la 2 de 900.");
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
      expect.stringContaining("report-key.mjs open ~/folio-reports.key AbCdEfGh contact1.opaque"),
      "Imprime el correo que dejó quien denunció.",
      expect.anything(),
    );
    expect(page.getElementById("reports")?.textContent).not.toContain("contact1.opaque");
    const offered = [...(page.getElementById("reports") as Element).querySelectorAll("button")];
    expect(offered.filter((one) => one.textContent === "Copiar para leer su correo")).toHaveLength(1);
  });

  it("offers a report's own version to verify and to panic", () => {
    pressing("reports", "Link para verificar");
    expect(doing.verifyLink).toHaveBeenCalledWith("AbCdEfGh", 2);
    pressing("reports", "Bloquear documento", 1);
    expect(doing.panic).toHaveBeenCalledWith("IjKlMnOp", 1);
    expect(page.getElementById("reports")?.textContent).not.toContain("Ya lo entregué");
  });

  it("offers a blocked document's reported version, and says which it is", () => {
    pressing("appeals", "Preparar entrega a la autoridad");
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

  it("offers to block the owner's key from a report and from a blocked document", () => {
    pressing("reports", "Bloquear llave del dueño");
    expect(doing.blockKey).toHaveBeenCalledWith("OWNERROOT");
    pressing("appeals", "Bloquear llave del dueño");
    expect(doing.blockKey).toHaveBeenCalledTimes(2);
  });

  it("does not offer to block a key that is already blocked", () => {
    const cards = (page.getElementById("reports") as Element).querySelectorAll(".card");
    expect(cards[1]?.textContent).toContain("IjKlMnOp");
    expect(cards[1]?.textContent).not.toContain("Bloquear llave del dueño");
    const blocked = (page.getElementById("blocked") as Element).querySelectorAll(".card");
    expect(blocked[0]?.textContent).toContain("QrStUvWx");
    expect(blocked[1]?.textContent).toContain("Bloquear llave del dueño");
  });

  it("lists the blocked keys, each with a way to lift it", () => {
    expect(page.getElementById("blocked-keys")?.textContent).toContain("BLOCKEDROOT");
    pressing("blocked-keys", "Desbloquear llave");
    expect(doing.unblockKey).toHaveBeenCalledWith("BLOCKEDROOT");
  });

  it("offers a form for a key that is on no card", () => {
    expect(page.getElementById("key-form")).not.toBeNull();
  });

  it("says when there is nothing", () => {
    drawQueue(
      page,
      {
        stage: "open",
        newKeys: 0,
        reportsTotal: 0,
        reportsFrom: 0,
        reports: [],
        docs: [],
        warned: [],
        blockedKeys: [],
      },
      doing as unknown as Doing,
    );
    const parts = [...page.querySelectorAll<HTMLElement>(".queue-part")];
    expect(parts.every((one) => one.hidden)).toBe(true);
    expect(page.getElementById("queue-empty")?.hidden).toBe(false);
    expect(page.getElementById("queue-empty")?.textContent).toBe("Nada por revisar.");
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
