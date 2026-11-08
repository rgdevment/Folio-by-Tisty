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
import { drawQueue } from "./draw";
import { drawKey } from "./key";
import { count, isoDay, megabytes, piece, shortKey, todayOf } from "./say";
import { drawTop } from "./top";

const page = document;
const said = page.getElementById("said") as HTMLElement;
const found = page.getElementById("found") as HTMLElement;
const COULD_NOT = "No se pudo. Recarga la página para ver cómo quedó.";
const PART_FAILED = "No se pudo traer esta parte. Recarga la página.";
const place = (id: string): HTMLElement => page.getElementById(id) as HTMLElement;

// A session of Access that ended redirects to its login, and the browser refuses that: the fetch rejects.
const answered = async (asking: () => Promise<Response>): Promise<Response | null> => {
  try {
    return await asking();
  } catch {
    return null;
  }
};

const fetched = (path: string): Promise<Response | null> =>
  answered(() => fetch(`/api/${path}`, { credentials: "same-origin", cache: "no-store" }));

const sent = (path: string, body?: unknown): Promise<Response | null> =>
  answered(() =>
    fetch(`/api/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Folio-Operator": "1", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const asked = async (path: string, note?: string): Promise<boolean> =>
  (await sent(path, note === undefined ? undefined : { note }))?.ok ?? false;

// Each part stands alone, so one that fails, or an older Worker that lacks it, leaves the rest working.
const shown = async <T>(path: string, where: HTMLElement, draw: (answer: T) => void): Promise<void> => {
  const response = await fetched(path);
  try {
    if (!response?.ok) throw new Error(`no ${path}`);
    draw((await response.json()) as T);
  } catch {
    where.replaceChildren(piece(page, "p", "card-line", PART_FAILED));
  }
};

const showCaseLink = (link: string, says: string): void => {
  place("case-link-said").textContent = says;
  place("case-link-code").textContent = link;
  place("case-link").hidden = false;
};

const copying = (text: string, says: string): void => {
  void navigator.clipboard.writeText(text).then(
    () => {
      said.textContent = says;
    },
    () => {
      said.textContent = "No se pudo copiar. Es este:";
      said.append(" ", text);
    },
  );
};

const caseMade = async (id: string, version: number, says: string, records?: unknown): Promise<boolean> => {
  const made = await madeCase(id, version, records);
  if (!(await sent(`docs/${id}/case`, made.body))?.ok) return false;
  showCaseLink(made.link, says);
  return true;
};

const verifying = async (id: string, version: number): Promise<void> => {
  said.textContent = "Trabajando…";
  const made = await caseMade(id, version, "Link para verificar, se muestra una vez. Pide la llave al abrirlo:");
  said.textContent = made ? "" : COULD_NOT;
};

let topOrder: TopOrder = "readers";
let topFlagged = false;
let keyShown: string | null = null;

const showKey = async (root: string): Promise<void> => {
  keyShown = root;
  await shown<KeyView>(`keys/${root}`, place("key"), (view) =>
    drawKey(page, place("key"), view, Date.now(), {
      blockKey: (one) => blockingKey(one),
      unblockKey: (one) => unblockingKey(one),
      exportKey: (one) => void exporting(one),
    }),
  );
};

const loadTop = (): Promise<void> =>
  shown<Top>(`top?by=${topOrder}${topFlagged ? "&flagged=1" : ""}`, place("top"), (top) =>
    drawTop(page, place("top"), top, Date.now(), { showKey: (root) => void showKey(root) }),
  );

const loadBoard = async (): Promise<void> => {
  const now = Date.now();
  await Promise.all([
    shown<Overlook>("overview", place("tiles"), (overview) => {
      drawTiles(page, place("tiles"), overview);
      drawHealth(page, place("health"), overview, now);
      drawAbout(page, place("about"), overview, now);
    }),
    shown<ServiceDay[]>("days", place("days"), (days) => drawDays(page, place("days"), days)),
    shown<Logged[]>("log", place("log"), (logged) => drawLog(page, place("log"), logged, now)),
    shown<NetsNearTheirTop>("nets", place("nets"), (nets) => drawNets(page, place("nets"), nets)),
    loadTop(),
    ...(keyShown ? [showKey(keyShown)] : []),
  ]);
};

const panicking = async (id: string, version: number, note: string): Promise<void> => {
  said.textContent = "Trabajando…";
  const held = await sent(`docs/${id}/panic`, { note });
  if (!held?.ok) {
    said.textContent = COULD_NOT;
    return;
  }
  const { records } = (await held.json()) as { records: unknown };
  await load();
  void loadBoard();
  const says = "Bloqueado y retenido. Link de caso para la autoridad, se muestra una vez. Entrégalo con la llave:";
  if (!(await caseMade(id, version, says, records))) {
    said.textContent = "Quedó bloqueado y retenido, pero no se pudo crear el link. Presiona de nuevo el botón.";
  }
};

const purging = async (id: string): Promise<void> => {
  said.textContent = "Trabajando…";
  const preview = await fetched(`docs/${id}/purge_owner`);
  if (!preview?.ok) {
    said.textContent = COULD_NOT;
    return;
  }
  const { purged, kept } = (await preview.json()) as { purged: number; kept: number };
  said.textContent = "";
  if (purged === 0) {
    said.textContent = `No hay nada que borrar de esta llave. Se conservan ${kept}.`;
    return;
  }
  const typed = prompt(
    `Se borrarán ${purged} documentos de la llave dueña de ${id}, no de quien haya firmado una versión, y se conservan ${kept}: retenidos, con denuncia grave o citados por otra persona. No se puede deshacer. Escribe ${purged} para seguir.`,
  );
  if (typed?.trim() !== String(purged)) return;
  const note = prompt("¿Por qué se borran?");
  if (!note?.trim()) return;
  said.textContent = "Trabajando…";
  const purge = await sent(`docs/${id}/purge_owner`, { note });
  if (!purge?.ok) {
    said.textContent = COULD_NOT;
    return;
  }
  const done = (await purge.json()) as { purged: number; kept: number };
  await load();
  void loadBoard();
  said.textContent = `Dejaron de servirse ${done.purged}. Se vacían en la próxima limpieza, que espera si el servicio está cortado. Se conservan ${done.kept}.`;
};

// Saved only where the operator chooses, as a file: the page itself keeps nothing in the browser.
const exporting = async (root: string): Promise<void> => {
  if (!confirm(`¿Exportar los registros de la llave ${root}? Se descarga un archivo JSON a este equipo.`)) return;
  said.textContent = "Trabajando…";
  const records = await fetched(`keys/${root}/records`);
  if (!records?.ok) {
    said.textContent = COULD_NOT;
    return;
  }
  const file = URL.createObjectURL(new Blob([await records.text()], { type: "application/json" }));
  const link = page.createElement("a");
  link.href = file;
  link.download = `folio-llave-${root.slice(0, 8)}-${isoDay(todayOf(Date.now()))}.json`;
  link.click();
  URL.revokeObjectURL(file);
  said.textContent = "Exportado. No contiene la red ni el correo de quien denunció.";
};

let reportsFrom = 0;

const load = async (): Promise<void> => {
  const path = reportsFrom === 0 ? "/api/queue" : `/api/queue?from=${reportsFrom}`;
  const response = await answered(() => fetch(path, { credentials: "same-origin", cache: "no-store" }));
  if (!response?.ok) {
    said.textContent = "No se pudo traer el panel. Recarga la página, quizá debas volver a entrar.";
    return;
  }
  const queue = (await response.json()) as Reviewed;
  if (queue.reports.length === 0 && reportsFrom > 0) {
    reportsFrom = 0;
    await load();
    return;
  }
  drawQueue(
    page,
    queue,
    {
      accept: (id) => confirmed(`¿Aceptar y desbloquear ${id}?`, `docs/${id}/accept`),
      reject: (id) => confirmed(`¿Rechazar el reclamo de ${id}? Sigue bloqueado.`, `docs/${id}/reject`),
      clearWarning: (id) =>
        confirmed(`¿Quitar el aviso de ${id}? Sus denuncias leves dejan de contar.`, `docs/${id}/clear_warning`),
      networkWasFalse: (id, net) =>
        confirmed(
          "¿Descartar todas las denuncias de esta red? Si es compartida, puede incluir denuncias reales, y sus documentos dejarán de retenerse.",
          `docs/${id}/reports/${net}/false_network`,
        ),
      forgetContact: (id, net) =>
        confirmed(
          "¿Borrar el correo de esta denuncia? Sigue hasta 30 días en los respaldos cifrados.",
          `docs/${id}/reports/${net}/forget_contact`,
        ),
      reportWasFalse: (id, net) =>
        confirmed("¿Esta denuncia era falsa? Esa red dejará de contar.", `docs/${id}/reports/${net}/false`),
      openReport: (id, command) => {
        const reason = prompt(`¿Por qué abres la denuncia de ${id}? Queda anotado en el registro.`);
        if (reason?.trim()) void openingReport(id, reason, command);
      },
      panic: (id, version) => {
        const note = prompt(`¿Por qué bloquear y retener ${id}? Dejará de servirse y se retiene 180 días.`);
        if (note?.trim()) void panicking(id, version, note);
      },
      blockKey: (root) => blockingKey(root),
      unblockKey: (root) => unblockingKey(root),
      purgeOwner: (id) => void purging(id),
      verifyLink: (id, version) => void verifying(id, version),
      reportsPage: (from) => {
        reportsFrom = from;
        void load();
      },
      handedOver: (id) =>
        confirmed(
          "¿Ya entregaste el link de caso y la llave a la autoridad? Se borran las llaves selladas de este documento, aunque siguen hasta 30 días en los respaldos cifrados.",
          `docs/${id}/handed_over`,
        ),
      copy: (command) => copying(command, "Copiado. Reemplaza <llave> por la ruta de tu llave y ábrelo en tu equipo."),
      showKey: (root) => void showKey(root),
    },
    queue.owners ?? {},
    todayOf(Date.now()),
  );
  said.textContent = "";
};

// Noted before the command is handed over, so no report is opened without its reason on record.
const openingReport = async (id: string, reason: string, command: string): Promise<void> => {
  said.textContent = "Trabajando…";
  if (!(await asked(`docs/${id}/opened`, reason))) {
    said.textContent = COULD_NOT;
    return;
  }
  copying(
    command,
    "Copiado. Pégalo en tu terminal, en la carpeta de Folio, con la ruta de tu llave en vez de <llave>: te da el link de la denuncia.",
  );
  void loadBoard();
};

const doing = async (path: string, note?: string): Promise<void> => {
  said.textContent = "Trabajando…";
  if (await asked(path, note)) {
    await load();
    void loadBoard();
  } else said.textContent = COULD_NOT;
};

const confirmed = (question: string, path: string): void => {
  if (confirm(question)) void doing(path);
};

const blockingKey = (root: string): void => {
  const reason = prompt(`¿Por qué bloquear la llave ${root}? No podrá subir nada más, y lo ya compartido sigue.`);
  if (reason?.trim()) void doing(`keys/${root}/block`, reason);
};

const unblockingKey = (root: string): void => {
  if (confirm(`¿Desbloquear la llave ${root}?`)) void doing(`keys/${root}/unblock`);
};

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
      return `Red ${shortKey(answer.net)}. ${days || "Sin subidas hoy ni ayer."} Denuncias desde ella: ${answer.reports}.`;
    }
    default:
      return "No se encontró. Una red solo se reconoce el mismo día, porque su resumen cambia cada día.";
  }
};

const finding = async (asking: string): Promise<void> => {
  found.textContent = "Buscando…";
  const response = await fetched(`find?q=${encodeURIComponent(asking)}`);
  if (!response?.ok) {
    found.textContent = COULD_NOT;
    return;
  }
  const answer = (await response.json()) as Found;
  found.textContent = foundText(answer);
  if (answer.kind === "doc") void showKey(answer.owner);
  if (answer.kind === "key") void showKey(answer.root);
};

const pressedIn = (nav: HTMLElement, pressed: HTMLElement, attribute: string): void => {
  for (const one of nav.querySelectorAll<HTMLElement>(`button[${attribute}]`)) {
    one.setAttribute("aria-pressed", String(one === pressed));
  }
};

place("queue-filters").addEventListener("click", (event) => {
  const pressed = (event.target as HTMLElement).closest<HTMLElement>("button[data-filter]");
  if (!pressed) return;
  place("queue").dataset.filter = pressed.dataset.filter ?? "all";
  pressedIn(place("queue-filters"), pressed, "data-filter");
});

place("top-order").addEventListener("click", (event) => {
  const pressed = (event.target as HTMLElement).closest<HTMLElement>("button");
  if (!pressed) return;
  if (pressed.id === "top-flagged") {
    topFlagged = !topFlagged;
    pressed.setAttribute("aria-pressed", String(topFlagged));
  } else {
    topOrder = (pressed.dataset.by as TopOrder | undefined) ?? "readers";
    pressedIn(place("top-order"), pressed, "data-by");
  }
  void loadTop();
});

place("find-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const asking = (place("find") as HTMLInputElement).value.trim();
  if (asking) void finding(asking);
});

place("case-link-copy").addEventListener("click", () => {
  copying(place("case-link-code").textContent ?? "", "Link copiado.");
});

(place("block-form") as HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  const id = (place("block-id") as HTMLInputElement).value.trim();
  const note = (place("block-note") as HTMLInputElement).value;
  if (confirm(`¿Bloquear ${id}? Dejará de servirse.`)) void doing(`docs/${id}/block`, note);
});

(place("key-form") as HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  const root = (place("key-root") as HTMLInputElement).value.trim();
  const note = (place("key-note") as HTMLInputElement).value;
  if (confirm(`¿Bloquear la llave ${root}? No podrá subir nada más.`)) void doing(`keys/${root}/block`, note);
});

void load();
void loadBoard();
