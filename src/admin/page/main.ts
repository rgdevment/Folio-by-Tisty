import "./panel.css";
import type {
  Found,
  KeyView,
  Logged,
  NetsNearTheirTop,
  Reviewed,
  ServiceDay,
  Top,
  TopOrder,
} from "../../core/dashboard";
import { drawAbout, drawDays, drawHealth, drawLog, drawNets, drawTiles, type Overlook } from "./board";
import { madeCase } from "./case";
import { type Doing, drawQueue, type Reading, sayWhenEmpty } from "./draw";
import { drawKey } from "./key";
import { count, isoDay, megabytes, piece, shortKey, todayOf } from "./say";
import { asked, fetched, fetchedAt, sent } from "./talk";
import { drawTop } from "./top";

const COULD_NOT = "No se pudo. Recarga la página para ver cómo quedó.";
const UNCHANGED = "No cambió nada: ya estaba así o ya no existe. La vista quedó al día.";
const ON_RECORD = "Queda en el registro, y en los registros que se entregan a la autoridad si hay un caso.";
const READING_SAID: Record<Reading, string> = {
  link: "Anotado el motivo. Imprime el link de la denuncia, listo para abrir en el navegador y leer la versión denunciada.",
  contact: "Anotado el motivo. Imprime el correo que dejó quien denunció.",
};
const PART_FAILED = "No se pudo traer esta parte. Recarga la página.";
const RUN_IT =
  "Córrelo en una terminal, en la carpeta de Folio. Usa tu llave de denuncias en ~/folio-reports.key: si está en otro lugar, cambia esa ruta. Tu llave nunca pasa por el panel.";
const DOWNLOAD_KEPT_MS = 60_000;
const MISSING = 404;

const foundText = (answer: Found): string => {
  switch (answer.kind) {
    case "doc":
      return `Documento ${answer.id}, de la llave ${shortKey(answer.owner)}.`;
    case "key":
      return `Llave ${shortKey(answer.root)}.`;
    case "net": {
      const days = answer.days
        .map(
          (one) =>
            `${isoDay(one.day)}: ${count(one.docs)} documentos, ${count(one.keys)} llaves, ${megabytes(one.bytes)}`,
        )
        .join(" · ");
      return `Red ${shortKey(answer.net)}, resumen del día. ${days}`;
    }
    case "reporter":
      return `Red que denunció ${shortKey(answer.net)}: ${answer.reports} denuncias. Su resumen cambia cada 180 días, así que no se cruza con las subidas.`;
    default:
      return "No se encontró. Una red solo se reconoce el mismo día, porque su resumen cambia cada día.";
  }
};

const pressedIn = (nav: HTMLElement, pressed: HTMLElement, attribute: string): void => {
  for (const one of nav.querySelectorAll<HTMLElement>(`button[${attribute}]`)) {
    one.setAttribute("aria-pressed", String(one === pressed));
  }
};

class Panel {
  readonly #page: Document;
  readonly #said: HTMLElement;
  readonly #found: HTMLElement;
  #reportsFrom = 0;
  #topOrder: TopOrder = "readers";
  #topFlagged = false;
  #keyShown: string | null = null;

  constructor(page: Document) {
    this.#page = page;
    this.#said = this.#place("said");
    this.#found = this.#place("found");
  }

  start(): void {
    this.#listen();
    void this.#load();
    void this.#loadBoard();
  }

  #place(id: string): HTMLElement {
    return this.#page.getElementById(id) as HTMLElement;
  }

  #say(text: string): void {
    this.#said.textContent = text;
  }

  // Each part stands alone, so one that fails, or an older Worker that lacks it, leaves the rest working.
  async #shown<T>(path: string, where: HTMLElement, draw: (answer: T) => void): Promise<void> {
    const response = await fetched(path);
    try {
      if (!response?.ok) throw new Error(`no ${path}`);
      draw((await response.json()) as T);
    } catch {
      where.replaceChildren(piece(this.#page, "p", "card-line", PART_FAILED));
    }
  }

  #copying(text: string, says: string, then?: () => void): void {
    void navigator.clipboard.writeText(text).then(
      () => {
        this.#say(says);
        then?.();
      },
      () => this.#say("No se pudo copiar: selecciónalo y cópialo."),
    );
  }

  // Shown on the card that asked, since the line at the top of the page is out of sight there.
  #handing(command: string, then: string, where: HTMLElement): void {
    const steps = (copied: boolean) => {
      const box = this.#page.createElement("section");
      box.className = "card-steps";
      box.append(
        piece(this.#page, "p", "", `${copied ? "Copiado." : "No se pudo copiar: cópialo de aquí."} ${RUN_IT} ${then}`),
        piece(this.#page, "code", "sealed", command),
      );
      where.querySelector(".card-steps")?.remove();
      where.append(box);
      this.#say("");
    };
    void navigator.clipboard.writeText(command).then(
      () => steps(true),
      () => steps(false),
    );
  }

  async #caseMade(id: string, version: number, says: string, records?: unknown): Promise<boolean> {
    const made = await madeCase(id, version, records);
    if (!(await sent(`docs/${id}/case`, made.body))?.ok) return false;
    this.#place("case-link-said").textContent = says;
    this.#place("case-link-code").textContent = made.link;
    const shown = this.#place("case-link");
    shown.hidden = false;
    shown.scrollIntoView?.({ block: "center" });
    return true;
  }

  async #verifying(id: string, version: number): Promise<void> {
    this.#say("Trabajando…");
    const made = await this.#caseMade(
      id,
      version,
      "Link para verificar, se muestra una vez. Pide la llave al abrirlo:",
    );
    this.#say(made ? "" : COULD_NOT);
  }

  async #showKey(root: string): Promise<void> {
    this.#keyShown = root;
    const where = this.#place("key");
    await this.#shown<KeyView>(`keys/${root}`, where, (view) =>
      drawKey(this.#page, where, view, Date.now(), {
        blockKey: (one) => this.#blockingKey(one),
        unblockKey: (one) => this.#unblockingKey(one),
        exportKey: (one) => void this.#exporting(one),
      }),
    );
  }

  // Asked from a card far below, so the key's box comes into sight instead of changing out of view.
  async #seeingKey(root: string): Promise<void> {
    const where = this.#place("key");
    where.replaceChildren(piece(this.#page, "p", "card-line", "Trayendo la llave…"));
    where.closest("section")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    await this.#showKey(root);
  }

  #loadTop(): Promise<void> {
    const where = this.#place("top");
    return this.#shown<Top>(`top?by=${this.#topOrder}${this.#topFlagged ? "&flagged=1" : ""}`, where, (top) =>
      drawTop(this.#page, where, top, Date.now(), { showKey: (root) => void this.#seeingKey(root) }),
    );
  }

  async #loadBoard(): Promise<void> {
    const now = Date.now();
    const page = this.#page;
    const place = (id: string) => this.#place(id);
    await Promise.all([
      this.#shown<Overlook>("overview", place("tiles"), (overview) => {
        drawTiles(page, place("tiles"), overview);
        drawHealth(page, place("health"), overview, now);
        drawAbout(page, place("about"), overview, now);
      }),
      this.#shown<ServiceDay[]>("days", place("days"), (days) => drawDays(page, place("days"), days)),
      this.#shown<Logged[]>("log", place("log"), (logged) => drawLog(page, place("log"), logged, now)),
      this.#shown<NetsNearTheirTop>("nets", place("nets"), (nets) => drawNets(page, place("nets"), nets)),
      this.#loadTop(),
      ...(this.#keyShown ? [this.#showKey(this.#keyShown)] : []),
    ]);
  }

  async #reload(): Promise<void> {
    await this.#load();
    void this.#loadBoard();
  }

  async #panicking(id: string, version: number, note: string): Promise<void> {
    this.#say("Trabajando…");
    const held = await sent(`docs/${id}/panic`, { note });
    if (!held?.ok) {
      this.#say(COULD_NOT);
      return;
    }
    const { records } = (await held.json()) as { records: unknown };
    await this.#reload();
    const says = "Bloqueado y retenido. Link de caso para la autoridad, se muestra una vez. Entrégalo con la llave:";
    if (!(await this.#caseMade(id, version, says, records))) {
      this.#say("Quedó bloqueado y retenido, pero no se pudo crear el link. Presiona de nuevo el botón.");
    }
  }

  async #purging(id: string): Promise<void> {
    this.#say("Trabajando…");
    const preview = await fetched(`docs/${id}/purge_owner`);
    if (!preview?.ok) {
      this.#say(COULD_NOT);
      return;
    }
    const { purged, kept } = (await preview.json()) as { purged: number; kept: number };
    this.#say("");
    if (purged === 0) {
      this.#say(`No hay nada que borrar de esta llave. Se conservan ${kept}.`);
      return;
    }
    const typed = prompt(
      `Se borrarán ${purged} documentos de la llave dueña de ${id}, no de quien haya firmado una versión, y se conservan ${kept}: retenidos, con denuncia grave o citados por otra persona. No se puede deshacer. Escribe ${purged} para seguir.`,
    );
    if (typed?.trim() !== String(purged)) return;
    const note = prompt("¿Por qué se borran?");
    if (!note?.trim()) return;
    this.#say("Trabajando…");
    const purge = await sent(`docs/${id}/purge_owner`, { note });
    if (!purge?.ok) {
      this.#say(COULD_NOT);
      return;
    }
    const done = (await purge.json()) as { purged: number; kept: number };
    await this.#reload();
    this.#say(
      `Dejaron de servirse ${done.purged}. Se vacían en la próxima limpieza, que espera si el servicio está cortado. Se conservan ${done.kept}.`,
    );
  }

  // Saved only where the operator chooses, as a file: the page itself keeps nothing in the browser.
  async #exporting(root: string): Promise<void> {
    if (!confirm(`¿Exportar los registros de la llave ${root}? Se descarga un archivo JSON a este equipo.`)) return;
    this.#say("Trabajando…");
    const records = await fetched(`keys/${root}/records`);
    if (!records?.ok) {
      this.#say(COULD_NOT);
      return;
    }
    const file = URL.createObjectURL(new Blob([await records.text()], { type: "application/json" }));
    const link = this.#page.createElement("a");
    link.href = file;
    link.download = `folio-llave-${root.slice(0, 8)}-${isoDay(todayOf(Date.now()))}.json`;
    link.hidden = true;
    this.#page.body.append(link);
    link.click();
    link.remove();
    // Some browsers start the download after the click returns, and a link let go at once saves nothing.
    setTimeout(() => URL.revokeObjectURL(file), DOWNLOAD_KEPT_MS);
    this.#say("Exportado. No contiene la red ni el correo de quien denunció.");
  }

  #doing(): Doing {
    return {
      accept: (id) =>
        this.#confirmed(
          `¿Desbloquear ${id}? Vuelve a servirse, se descartan sus denuncias abiertas, se levanta su retención y dejan de servir sus links de caso, también el de la autoridad.`,
          `docs/${id}/accept`,
        ),
      reject: (id) => this.#confirmed(`¿Rechazar el reclamo de ${id}? Sigue bloqueado.`, `docs/${id}/reject`),
      clearWarning: (id) =>
        this.#confirmed(`¿Quitar el aviso de ${id}? Sus denuncias leves dejan de contar.`, `docs/${id}/clear_warning`),
      networkWasFalse: (id, net) =>
        this.#confirmed(
          "¿Descartar todas las denuncias de esta red? Si es compartida, puede incluir denuncias reales, y sus documentos dejarán de retenerse.",
          `docs/${id}/reports/${net}/false_network`,
        ),
      forgetContact: (id, net) =>
        this.#confirmed(
          "¿Borrar el correo de esta denuncia? Sigue hasta 30 días en los respaldos cifrados.",
          `docs/${id}/reports/${net}/forget_contact`,
        ),
      reportWasFalse: (id, net) =>
        this.#confirmed(
          "¿Esta denuncia era falsa? Esa red no contará por 180 días: si es compartida, tampoco contarán sus denuncias reales. No se deshace desde el panel.",
          `docs/${id}/reports/${net}/false`,
        ),
      openReport: (id, command, where, reading) => {
        const what = reading === "link" ? "abres la denuncia" : "lees el correo de quien denunció";
        const reason = prompt(`¿Por qué ${what} de ${id}? ${ON_RECORD}`);
        if (reason?.trim()) void this.#openingReport(id, reason, command, where, reading);
      },
      block: (id) => {
        const note = prompt(
          `¿Por qué bloquear ${id}? Deja de servirse y su copia se guarda 180 días; no se crea ningún link de caso. ${ON_RECORD}`,
        );
        if (note?.trim()) void this.#acting(`docs/${id}/block`, note);
      },
      panic: (id, version) => {
        const note = prompt(
          `¿Por qué preparar la entrega de ${id} a la autoridad? Deja de servirse, se retiene 180 días, se crea un link de caso y se sellan sus registros, también los motivos que escribiste.`,
        );
        if (note?.trim()) void this.#panicking(id, version, note);
      },
      blockKey: (root) => this.#blockingKey(root),
      unblockKey: (root) => this.#unblockingKey(root),
      purgeOwner: (id) => void this.#purging(id),
      verifyLink: (id, version) => void this.#verifying(id, version),
      reportsPage: (from) => {
        this.#reportsFrom = from;
        void this.#load();
      },
      handedOver: (id) =>
        this.#confirmed(
          "¿Ya entregaste el link de caso y la llave a la autoridad? Se borra lo sellado de sus denuncias: si no copiaste la llave del documento, nadie podrá volver a leerlo. Sigue hasta 30 días en los respaldos cifrados.",
          `docs/${id}/handed_over`,
        ),
      copy: (command, then, where) => this.#handing(command, then, where),
      showKey: (root) => void this.#seeingKey(root),
    };
  }

  async #load(): Promise<void> {
    const path = this.#reportsFrom === 0 ? "/api/queue" : `/api/queue?from=${this.#reportsFrom}`;
    const response = await fetchedAt(path);
    if (!response?.ok) {
      this.#say("No se pudo traer el panel. Recarga la página, quizá debas volver a entrar.");
      return;
    }
    const queue = (await response.json()) as Reviewed;
    if (queue.reports.length === 0 && this.#reportsFrom > 0) {
      this.#reportsFrom = 0;
      await this.#load();
      return;
    }
    drawQueue(this.#page, queue, this.#doing(), queue.owners ?? {}, todayOf(Date.now()));
    this.#say("");
  }

  // Noted before the command is handed over, so no report is opened without its reason on record.
  async #openingReport(
    id: string,
    reason: string,
    command: string,
    where: HTMLElement,
    reading: Reading,
  ): Promise<void> {
    this.#say("Trabajando…");
    if (!(await sent(`docs/${id}/opened`, { note: reason, kind: reading }))?.ok) {
      this.#say(COULD_NOT);
      return;
    }
    this.#handing(command, READING_SAID[reading], where);
    void this.#loadBoard();
  }

  async #acting(path: string, note?: string): Promise<void> {
    this.#say("Trabajando…");
    const answer = await sent(path, note === undefined ? undefined : { note });
    await this.#reload();
    this.#say(answer?.ok ? "Hecho." : answer?.status === MISSING ? UNCHANGED : COULD_NOT);
  }

  #confirmed(question: string, path: string): void {
    if (confirm(question)) void this.#acting(path);
  }

  #blockingKey(root: string): void {
    const reason = prompt(`¿Por qué bloquear la llave ${root}? No podrá subir nada más, y lo ya compartido sigue.`);
    if (reason?.trim()) void this.#acting(`keys/${root}/block`, reason);
  }

  #unblockingKey(root: string): void {
    if (confirm(`¿Desbloquear la llave ${root}?`)) void this.#acting(`keys/${root}/unblock`);
  }

  async #finding(asking: string): Promise<void> {
    this.#found.textContent = "Buscando…";
    const response = await fetched(`find?q=${encodeURIComponent(asking)}`);
    if (!response?.ok) {
      this.#found.textContent = COULD_NOT;
      return;
    }
    const answer = (await response.json()) as Found;
    this.#found.textContent = foundText(answer);
    if (answer.kind === "doc") void this.#showKey(answer.owner);
    if (answer.kind === "key") void this.#showKey(answer.root);
  }

  #listen(): void {
    const place = (id: string) => this.#place(id);
    place("queue-filters").addEventListener("click", (event) => {
      const pressed = (event.target as HTMLElement).closest<HTMLElement>("button[data-filter]");
      if (!pressed) return;
      place("queue").dataset.filter = pressed.dataset.filter ?? "all";
      pressedIn(place("queue-filters"), pressed, "data-filter");
      sayWhenEmpty(this.#page);
    });
    place("top-order").addEventListener("click", (event) => {
      const pressed = (event.target as HTMLElement).closest<HTMLElement>("button");
      if (!pressed) return;
      if (pressed.id === "top-flagged") {
        this.#topFlagged = !this.#topFlagged;
        pressed.setAttribute("aria-pressed", String(this.#topFlagged));
      } else {
        this.#topOrder = (pressed.dataset.by as TopOrder | undefined) ?? "readers";
        pressedIn(place("top-order"), pressed, "data-by");
      }
      void this.#loadTop();
    });
    place("find-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const asking = (place("find") as HTMLInputElement).value.trim();
      if (asking) void this.#finding(asking);
    });
    place("case-link-copy").addEventListener("click", () => {
      this.#copying(place("case-link-code").textContent ?? "", "Link copiado. Ya no se muestra.", () => {
        place("case-link-code").textContent = "";
        place("case-link").hidden = true;
      });
    });
    place("block-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const id = (place("block-id") as HTMLInputElement).value.trim();
      const note = (place("block-note") as HTMLInputElement).value;
      if (confirm(`¿Bloquear ${id}? Dejará de servirse.`)) {
        void this.#acting(`docs/${id}/block`, note);
        (place("block-form") as HTMLFormElement).reset();
      }
    });
    place("key-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const root = (place("key-root") as HTMLInputElement).value.trim();
      const note = (place("key-note") as HTMLInputElement).value;
      if (confirm(`¿Bloquear la llave ${root}? No podrá subir nada más.`)) {
        void this.#acting(`keys/${root}/block`, note);
        (place("key-form") as HTMLFormElement).reset();
      }
    });
  }
}

new Panel(document).start();
