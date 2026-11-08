import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Doing, drawQueue } from "../src/admin/page/draw";
import { ago, when } from "../src/admin/page/say";
import type { Queue, QueuedDoc, QueuedReport } from "../src/core/queue";

const ID = "AbCdEfGh";
const LINK = `sealed1.${"o".repeat(150)}`;
const CONTACT = `contact1.${"o".repeat(80)}`;

const report = (over: Partial<QueuedReport> = {}): QueuedReport => ({
  doc: ID,
  ownerToBlock: "OWNERROOT",
  net: "n1",
  category: "phishing",
  level: "medium",
  detail: "una denuncia",
  sealedLink: LINK,
  sealedContact: CONTACT,
  version: 1,
  at: 20_000,
  asn: 3,
  fromFalseNet: false,
  overCap: false,
  ...over,
});

const doc = (over: Partial<QueuedDoc> = {}): QueuedDoc => ({
  id: ID,
  ownerToBlock: null,
  latest: 1,
  blockedAt: 20_000,
  appealedAt: null,
  waitsForOperator: false,
  mayCorrect: false,
  versionToOpen: 1,
  mayHandOver: false,
  signers: [{ n: 1, byOwner: true }],
  ...over,
});

const queue = (over: Partial<Queue> = {}): Queue => ({
  stage: "open",
  blockedKeys: [],
  newKeys: 0,
  reportsTotal: 1,
  reportsFrom: 0,
  warned: [],
  reports: [report()],
  docs: [doc()],
  ...over,
});

let page: Document;

beforeEach(() => {
  page = new JSDOM(readFileSync("src/admin/page/index.html", "utf8")).window.document;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const noDoing = (): Doing =>
  Object.fromEntries(
    [
      "accept",
      "reject",
      "clearWarning",
      "reportWasFalse",
      "forgetContact",
      "networkWasFalse",
      "openReport",
      "block",
      "blockKey",
      "unblockKey",
      "copy",
      "panic",
      "purgeOwner",
      "verifyLink",
      "handedOver",
      "reportsPage",
      "showKey",
    ].map((name) => [name, vi.fn()]),
  ) as unknown as Doing;

const labelsIn = (place: string): string[] =>
  [...(page.getElementById(place) as Element).querySelectorAll("button")].map((one) => one.textContent ?? "");

describe("the commands the panel hands to the operator's shell", () => {
  const draw = (over: Partial<QueuedReport>) =>
    drawQueue(page, queue({ reports: [report(over)], docs: [] }), noDoing());
  const reportsText = () => page.getElementById("reports")?.textContent ?? "";

  it("offers both for a seal and a contact of the shape the server takes", () => {
    draw({});
    expect(labelsIn("reports")).toEqual(
      expect.arrayContaining(["Abrir denuncia", "Comprobar sin abrir", "Leer su correo", "Borrar su correo"]),
    );
    expect(reportsText()).not.toContain("no tiene la forma esperada");
  });

  it.each([
    ["a shell command after it", `${LINK}; rm -rf ~`],
    ["a space inside", `sealed1.${"o".repeat(75)} ${"o".repeat(75)}`],
    ["a newline at the end", `${LINK}\n`],
    ["a newline inside", `sealed1.${"o".repeat(75)}\n${"o".repeat(75)}`],
    ["a quote", `sealed1.${"o".repeat(149)}"`],
    ["a dollar sign", `sealed1.${"o".repeat(149)}$`],
    ["a backtick", `sealed1.${"o".repeat(149)}\``],
    ["a plus, which base64url does not use", `sealed1.${"o".repeat(149)}+`],
    ["a padding sign", `sealed1.${"o".repeat(149)}=`],
    ["a unicode letter that looks like a letter", `sealed1.${"o".repeat(149)}ñ`],
    ["149 characters, one short", `sealed1.${"o".repeat(149)}`],
    ["the prefix of a contact", `contact1.${"o".repeat(200)}`],
    ["no prefix", "o".repeat(150)],
    ["the prefix in capitals", `SEALED1.${"o".repeat(150)}`],
    ["a leading space", ` ${LINK}`],
    ["a dash first, which a shell would read as an option", `-${LINK}`],
    ["nothing but the prefix", "sealed1."],
    ["an empty string", ""],
  ])("offers no command for a seal with %s, and says why", (_what, sealedLink) => {
    draw({ sealedLink, sealedContact: null });
    expect(labelsIn("reports")).not.toContain("Abrir denuncia");
    expect(labelsIn("reports")).not.toContain("Comprobar sin abrir");
    expect(reportsText()).toContain("no tiene la forma esperada");
    expect(reportsText()).not.toContain("sealed1.o");
  });

  it("takes the longest a link may be and the shortest, 150 characters", () => {
    draw({ sealedLink: `sealed1.${"A_-".repeat(50)}`, sealedContact: null });
    expect(labelsIn("reports")).toContain("Abrir denuncia");
  });

  it.each([
    ["a link where a contact goes", LINK],
    ["79 characters, one short", `contact1.${"o".repeat(79)}`],
    ["513 characters, one over", `contact1.${"o".repeat(504)}`],
    ["a shell command", `${CONTACT}; id`],
    ["an at sign", `contact1.${"o".repeat(79)}@`],
  ])("offers no command for a contact with %s", (_what, sealedContact) => {
    draw({ sealedLink: null, sealedContact });
    expect(labelsIn("reports")).not.toContain("Leer su correo");
    expect(reportsText()).toContain("no tiene la forma esperada");
  });

  it("takes a contact of 512 characters, and 80 of body", () => {
    draw({ sealedLink: null, sealedContact: `contact1.${"o".repeat(503)}` });
    expect(labelsIn("reports")).toContain("Leer su correo");
    draw({ sealedLink: null, sealedContact: `contact1.${"o".repeat(80)}` });
    expect(labelsIn("reports")).toContain("Leer su correo");
  });

  it.each([
    ["seven characters", "AbCdEfG"],
    ["nine characters", "AbCdEfGhI"],
    ["a dash", "AbCd-fGh"],
    ["a semicolon", "AbCdEf;h"],
    ["a space", "AbCdEf h"],
    ["a command substitution", "$(id)xxxx"],
    ["a unicode digit", "AbCdEfG٣"],
    ["a trailing newline", "AbCdEfGh\n"],
    ["an empty id", ""],
  ])("offers no command for a document whose id is %s, even with a good seal", (_what, docId) => {
    draw({ doc: docId });
    expect(labelsIn("reports")).not.toContain("Abrir denuncia");
    expect(labelsIn("reports")).not.toContain("Leer su correo");
    expect(labelsIn("reports")).not.toContain("Comprobar sin abrir");
  });

  it("still lets the operator act on a report whose seal is malformed", () => {
    draw({ sealedLink: "garbage", sealedContact: "garbage" });
    expect(labelsIn("reports")).toEqual(
      expect.arrayContaining([
        "Link para verificar",
        "Era falsa",
        "Bloquear documento",
        "Preparar entrega a la autoridad",
      ]),
    );
  });

  it("builds the command with nothing but the id and the seal, in the form the script takes", () => {
    const doing = noDoing();
    drawQueue(page, queue({ docs: [] }), doing);
    const press = (label: string) => {
      const found = [...(page.getElementById("reports") as Element).querySelectorAll("button")].find(
        (one) => one.textContent === label,
      );
      (found as HTMLButtonElement).click();
    };
    press("Abrir denuncia");
    press("Leer su correo");
    const calls = (doing.openReport as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual([
      ID,
      `node scripts/report-key.mjs open ~/folio-reports.key ${ID} ${LINK}`,
      expect.anything(),
      "link",
    ]);
    expect(calls[1]).toEqual([
      ID,
      `node scripts/report-key.mjs open ~/folio-reports.key ${ID} ${CONTACT}`,
      expect.anything(),
      "contact",
    ]);
    for (const [, command] of calls)
      expect(command).toMatch(
        /^node scripts\/report-key\.mjs open ~\/folio-reports\.key [A-Za-z0-9]{8} (sealed1|contact1)\.[A-Za-z0-9_-]+$/,
      );
  });

  it("writes what the reporter said as text, said apart, and never as markup", () => {
    draw({ detail: '<img src=x onerror="alert(1)"><script>alert(2)</script>' });
    const said = page.querySelector("#reports .card-detail");
    expect(said?.tagName).toBe("BLOCKQUOTE");
    expect(said?.querySelector("img, script")).toBeNull();
    expect(said?.textContent).toContain("Escribió quien denunció, sin comprobar: ");
    expect(said?.textContent).toContain("<script>alert(2)</script>");
  });
});

describe("the panel in a session", () => {
  const unseen = new Set<string>();
  let openings: string[];
  let queued: () => Queue;
  let queueFails: boolean;

  const mayHandOver = (): boolean => openings.some((one) => one.startsWith("link: "));

  const server = (over: Record<string, () => Response> = {}) =>
    vi.fn(async (path: string, init?: RequestInit) => {
      const answer = Object.entries(over).find(([end]) => path.endsWith(end));
      if (answer) return answer[1]();
      if (path === "/api/queue" || path.startsWith("/api/queue?")) {
        if (queueFails) throw new TypeError("refused by the browser");
        return new Response(JSON.stringify(queued()));
      }
      if (path.endsWith("/opened")) {
        const { note, kind } = JSON.parse(String(init?.body));
        openings.push(`${kind}: ${note}`);
        return new Response(JSON.stringify({ done: true }));
      }
      if (path.endsWith("/panic")) return new Response(JSON.stringify({ records: { id: ID } }));
      if (path.startsWith("/api/") && init?.method !== "POST") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ done: true }));
    });

  const start = async (
    fetching: ReturnType<typeof server>,
    reason: string | null = "una razon",
    extra: Record<string, unknown> = {},
  ) => {
    vi.resetModules();
    vi.stubGlobal("document", page);
    vi.stubGlobal("confirm", () => true);
    const asked: string[] = [];
    vi.stubGlobal("prompt", (question: string) => {
      asked.push(question);
      return reason;
    });
    for (const [name, value] of Object.entries(extra)) vi.stubGlobal(name, value);
    vi.stubGlobal("fetch", fetching);
    await import("../src/admin/page/main");
    await vi.waitFor(() => expect(page.getElementById("reports")?.querySelector("button")).not.toBeNull());
    return asked;
  };

  const press = (place: string, label: string, at = 0) => {
    const found = [...(page.getElementById(place) as Element).querySelectorAll("button")].filter(
      (one) => one.textContent === label,
    );
    (found[at] as HTMLButtonElement).click();
  };
  const said = () => page.getElementById("said")?.textContent;
  const clipboard = () => {
    const writeText = vi.fn(async (_text: string) => {});
    return { writeText, extra: { navigator: { clipboard: { writeText } } } };
  };

  beforeEach(() => {
    unseen.clear();
    openings = [];
    queueFails = false;
    queued = () => queue({ docs: [doc({ mayHandOver: mayHandOver() })] });
  });

  describe("the hand-over gate", () => {
    it("shows «Ya lo entregué» once the report was opened, without a reload of the page", async () => {
      const { extra } = clipboard();
      await start(server(), "verificar", extra);
      expect(labelsIn("blocked")).not.toContain("Ya lo entregué");
      press("reports", "Abrir denuncia");
      await vi.waitFor(() => expect(openings).toEqual(["link: verificar"]));
      await vi.waitFor(() => expect(page.querySelector("#reports .card-steps")).not.toBeNull());
      await vi.waitFor(() =>
        expect(labelsIn("blocked"), "the gate opened on the server and the panel still hides it").toContain(
          "Ya lo entregué",
        ),
      );
    });

    it("does not show it after only the reporter's email was read, which is noted with its own words", async () => {
      const { extra } = clipboard();
      await start(server(), "preguntar algo", extra);
      press("reports", "Leer su correo");
      await vi.waitFor(() => expect(openings).toEqual(["contact: preguntar algo"]));
      expect(labelsIn("blocked")).not.toContain("Ya lo entregué");
      press("reports", "Era falsa");
      await vi.waitFor(() => expect(said()).toBe("Hecho."));
      expect(labelsIn("blocked")).not.toContain("Ya lo entregué");
    });

    it("notes a link opening and an email reading apart, with the words each one says", async () => {
      const { extra } = clipboard();
      await start(server(), "motivo", extra);
      press("reports", "Abrir denuncia");
      await vi.waitFor(() =>
        expect(page.querySelector("#reports .card-steps")?.textContent).toContain("Imprime el link de la denuncia"),
      );
      press("reports", "Leer su correo");
      await vi.waitFor(() =>
        expect(page.querySelector("#reports .card-steps")?.textContent).toContain("Imprime el correo que dejó"),
      );
      expect(openings).toEqual(["link: motivo", "contact: motivo"]);
      expect(page.querySelectorAll("#reports .card-steps")).toHaveLength(1);
    });

    it("says it could not note the opening when the document is not there (404), and hands over no command", async () => {
      const { writeText, extra } = clipboard();
      await start(server({ "/opened": () => new Response('{"refused":"missing"}', { status: 404 }) }), "motivo", extra);
      press("reports", "Abrir denuncia");
      await vi.waitFor(() => expect(said()).toContain("No se pudo"));
      expect(writeText).not.toHaveBeenCalled();
      expect(page.querySelector("#reports .card-steps")).toBeNull();
    });

    it("hands over no command when the network fails while noting", async () => {
      const { writeText, extra } = clipboard();
      const fetching = server();
      await start(fetching, "motivo", extra);
      fetching.mockImplementation(async (path: string) => {
        if (path.endsWith("/opened")) throw new TypeError("offline");
        return new Response(JSON.stringify(queued()));
      });
      press("reports", "Abrir denuncia");
      await vi.waitFor(() => expect(said()).toContain("No se pudo"));
      expect(writeText).not.toHaveBeenCalled();
    });

    it("asks for the reason with words that say what each opening is, and keeps nothing without one", async () => {
      const { writeText, extra } = clipboard();
      const asked = await start(server(), null, extra);
      press("reports", "Abrir denuncia");
      press("reports", "Leer su correo");
      expect(asked[0]).toContain("abres la denuncia");
      expect(asked[1]).toContain("lees el correo");
      expect(asked.every((one) => one.includes("registros que se entregan"))).toBe(true);
      expect(openings).toEqual([]);
      expect(writeText).not.toHaveBeenCalled();
    });
  });

  describe("what each action says when it ends", () => {
    const outcome = async (answer: () => Response | Promise<Response>, button = "Rechazar") => {
      queued = () => queue({ docs: [doc({ id: "QrStUvWx", waitsForOperator: true, appealedAt: 20_001 })] });
      const fetching = server({ "/reject": answer as () => Response });
      await start(fetching, "x", clipboard().extra);
      const before = fetching.mock.calls.filter(([path]) => path === "/api/queue").length;
      press("appeals", button);
      await vi.waitFor(() => expect(said()).not.toBe("Trabajando…"));
      await vi.waitFor(() =>
        expect(fetching.mock.calls.filter(([path]) => path === "/api/queue").length).toBe(before + 1),
      );
      return said();
    };

    it("says it is done on a 200", async () => {
      expect(await outcome(() => new Response("{}"))).toBe("Hecho.");
    });
    it("says nothing changed on a 404, and still reloads", async () => {
      expect(await outcome(() => new Response("{}", { status: 404 }))).toContain("No cambió nada");
    });
    it.each([400, 401, 403, 409, 429, 500, 502, 503])(
      "says it could not on a %i, and still reloads",
      async (status) => {
        expect(await outcome(() => new Response("{}", { status }))).toContain("No se pudo. Recarga");
      },
    );
    it("says it could not when the answer never comes", async () => {
      expect(
        await outcome(() => {
          throw new TypeError("offline");
        }),
      ).toContain("No se pudo. Recarga");
    });
    it("does not call a 3xx done: a session that ended redirects", async () => {
      expect(await outcome(() => new Response(null, { status: 302 }))).toContain("No se pudo. Recarga");
    });

    it("does not say everything is done when the page behind it could not be brought up to date", async () => {
      queued = () => queue({ docs: [doc({ id: "QrStUvWx", waitsForOperator: true, appealedAt: 20_001 })] });
      const fetching = server();
      await start(fetching, "x", clipboard().extra);
      queueFails = true;
      press("appeals", "Rechazar");
      await vi.waitFor(() => expect(fetching.mock.calls.some(([path]) => path.endsWith("/reject"))).toBe(true));
      await vi.waitFor(() => expect(said()).not.toBe("Trabajando…"));
      expect(said(), "an old page, said to be up to date").not.toBe("Hecho.");
    });
  });

  describe("blocking, and holding for an authority", () => {
    it("asks different questions, and the block's says no case link is made", async () => {
      const asked = await start(server(), "motivo", clipboard().extra);
      press("reports", "Bloquear documento");
      await vi.waitFor(() => expect(said()).toBe("Hecho."));
      press("reports", "Preparar entrega a la autoridad");
      await vi.waitFor(() => expect(page.getElementById("case-link")?.hidden).toBe(false));
      expect(asked[0]).toContain("no se crea ningún link de caso");
      expect(asked[1]).toContain("se crea un link de caso");
      expect(asked[1]).toContain("también los motivos que escribiste");
    });

    it("empties the forms once a block was asked for and confirmed, and keeps them when it was not", async () => {
      const fetching = server();
      await start(fetching, "x", clipboard().extra);
      const fill = () => {
        (page.getElementById("block-id") as HTMLInputElement).value = "AbCdEfGh";
        (page.getElementById("block-note") as HTMLInputElement).value = "una razon";
        (page.getElementById("key-root") as HTMLInputElement).value = "R".repeat(43);
        (page.getElementById("key-note") as HTMLInputElement).value = "otra razon";
      };
      const submit = (form: string) =>
        page
          .getElementById(form)
          ?.dispatchEvent(new (page.defaultView as Window & typeof globalThis).Event("submit", { cancelable: true }));
      vi.stubGlobal("confirm", () => false);
      fill();
      submit("block-form");
      submit("key-form");
      expect((page.getElementById("block-note") as HTMLInputElement).value).toBe("una razon");
      expect((page.getElementById("key-note") as HTMLInputElement).value).toBe("otra razon");
      vi.stubGlobal("confirm", () => true);
      submit("block-form");
      submit("key-form");
      await vi.waitFor(() => expect(said()).toBe("Hecho."));
      expect((page.getElementById("block-id") as HTMLInputElement).value).toBe("");
      expect((page.getElementById("block-note") as HTMLInputElement).value).toBe("");
      expect((page.getElementById("key-root") as HTMLInputElement).value).toBe("");
      expect((page.getElementById("key-note") as HTMLInputElement).value).toBe("");
    });

    it("sends the block with its reason alone, and no request at all without one", async () => {
      const fetching = server();
      await start(fetching, "   ", clipboard().extra);
      press("reports", "Bloquear documento");
      press("reports", "Preparar entrega a la autoridad");
      expect(fetching.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
    });

    it("blocks the very document of the card, not another", async () => {
      queued = () =>
        queue({ reports: [report({ doc: "ZzZzZzZz" }), report({ doc: ID, net: "n2" })], reportsTotal: 2, docs: [] });
      const fetching = server();
      await start(fetching, "porque si", clipboard().extra);
      press("reports", "Bloquear documento", 1);
      await vi.waitFor(() => expect(fetching.mock.calls.some(([path]) => path === `/api/docs/${ID}/block`)).toBe(true));
      expect(fetching.mock.calls.some(([path]) => path === "/api/docs/ZzZzZzZz/block")).toBe(false);
    });

    it("keeps the typed reason out of the form once sent, and clears the form even when the block failed", async () => {
      const fetching = server({ "/block": () => new Response("{}", { status: 500 }) });
      await start(fetching, "x", clipboard().extra);
      (page.getElementById("block-id") as HTMLInputElement).value = " AbCdEfGh ";
      (page.getElementById("block-note") as HTMLInputElement).value = "una razon larga escrita a mano";
      page
        .getElementById("block-form")
        ?.dispatchEvent(new (page.defaultView as Window & typeof globalThis).Event("submit", { cancelable: true }));
      await vi.waitFor(() => expect(said()).toContain("No se pudo"));
      expect(fetching.mock.calls.some(([path]) => path === "/api/docs/AbCdEfGh/block")).toBe(true);
      expect(
        (page.getElementById("block-note") as HTMLInputElement).value,
        "the reason was lost with the failure",
      ).toBe("una razon larga escrita a mano");
    });
  });

  describe("the link of a case", () => {
    const CASE = () => page.getElementById("case-link-code")?.textContent ?? "";
    const shown = () => page.getElementById("case-link") as HTMLElement;

    it("is hidden and emptied once copied", async () => {
      const { writeText, extra } = clipboard();
      await start(server(), "motivo", extra);
      press("reports", "Link para verificar");
      await vi.waitFor(() => expect(CASE()).toContain("#caso."));
      const link = CASE();
      page.getElementById("case-link-copy")?.click();
      await vi.waitFor(() => expect(shown().hidden).toBe(true));
      expect(writeText).toHaveBeenCalledWith(link);
      expect(CASE()).toBe("");
      expect(said()).toBe("Link copiado. Ya no se muestra.");
    });

    it("stays when copying fails, and says so", async () => {
      const writeText = vi.fn(async () => {
        throw new Error("denied");
      });
      await start(server(), "motivo", { navigator: { clipboard: { writeText } } });
      press("reports", "Link para verificar");
      await vi.waitFor(() => expect(CASE()).toContain("#caso."));
      const link = CASE();
      page.getElementById("case-link-copy")?.click();
      await vi.waitFor(() => expect(said()).toContain("No se pudo copiar"));
      expect(shown().hidden).toBe(false);
      expect(CASE()).toBe(link);
    });

    it("is not hidden by the copy of a link it no longer shows", async () => {
      let release: () => void = () => undefined;
      const writeText = vi.fn(
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      );
      await start(server(), "motivo", { navigator: { clipboard: { writeText } } });
      press("reports", "Link para verificar");
      await vi.waitFor(() => expect(CASE()).toContain("#caso."));
      const first = CASE();
      page.getElementById("case-link-copy")?.click();
      press("reports", "Link para verificar");
      await vi.waitFor(() => expect(CASE()).not.toBe(first));
      const second = CASE();
      release();
      await vi.waitFor(() => expect(said()).toContain("Link copiado"));
      expect(CASE(), "the new link vanished unseen when the old one finished copying").toBe(second);
      expect(shown().hidden).toBe(false);
    });
  });
});

describe("the time the panel shows", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it.each(["UTC", "America/Santiago", "Pacific/Auckland", "Asia/Kolkata"])(
    "never leaves a gap or goes backwards in %s",
    (zone) => {
      process.env.TZ = zone;
      const now = new Date(2026, 10, 8, 3, 30).getTime();
      const rank = (said: string): number =>
        said === "recién" ? 0 : said.includes("min") ? 1 : said.includes(" h") ? 2 : said === "ayer" ? 3 : 4;
      let last = 0;
      for (let minutes = 0; minutes <= 4 * 24 * 60; minutes += 7) {
        const said = ago(now - minutes * 60_000, now);
        expect(said, `${minutes} min`).not.toMatch(/NaN|undefined|^$/);
        expect(rank(said), `${said} after ${minutes} min`).toBeGreaterThanOrEqual(last);
        last = rank(said);
      }
    },
  );

  it("says «ayer» for the calendar day before, in the browser's zone, and never for two days back", () => {
    process.env.TZ = "America/Santiago";
    const now = new Date(2026, 10, 8, 23, 50).getTime();
    expect(ago(new Date(2026, 10, 7, 0, 5).getTime(), now)).toBe("ayer");
    expect(ago(new Date(2026, 10, 6, 23, 59).getTime(), now)).toBe("6 nov");
    expect(when(new Date(2026, 10, 7, 9, 0).getTime(), now)).toMatch(/^ayer /);
    expect(when(new Date(2026, 10, 8, 9, 0).getTime(), now)).toMatch(/^hoy /);
    expect(when(new Date(2026, 10, 6, 9, 0).getTime(), now)).toMatch(/^6 nov /);
  });

  it("holds across the day the clocks change", () => {
    process.env.TZ = "America/Santiago";
    const now = new Date(2026, 8, 7, 15, 0).getTime();
    expect(ago(new Date(2026, 8, 5, 12, 0).getTime(), now)).toBe("5 sept");
    expect(ago(new Date(2026, 8, 6, 12, 0).getTime(), now)).toBe("ayer");
  });

  it("says «recién» for a moment in the future, as when the clocks differ", () => {
    const now = Date.now();
    expect(ago(now + 5 * 60_000, now)).toBe("recién");
  });
});
