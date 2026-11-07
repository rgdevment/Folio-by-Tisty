import "./panel.css";
import type { Queue } from "../../core/queue";
import { madeCase } from "./case";
import { drawQueue } from "./draw";

const said = document.getElementById("said") as HTMLElement;
const COULD_NOT = "No se pudo. Recarga la página para ver cómo quedó.";

// A session of Access that ended redirects to its login, and the browser refuses that: the fetch rejects.
const answered = async (asking: () => Promise<Response>): Promise<Response | null> => {
  try {
    return await asking();
  } catch {
    return null;
  }
};

const sent = (path: string, body?: unknown, on = "docs"): Promise<Response | null> =>
  answered(() =>
    fetch(`/api/${on}/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Folio-Operator": "1", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const asked = async (path: string, note?: string, on?: string): Promise<boolean> =>
  (await sent(path, note === undefined ? undefined : { note }, on))?.ok ?? false;

const showCaseLink = (link: string, says: string): void => {
  (document.getElementById("case-link-said") as HTMLElement).textContent = says;
  (document.getElementById("case-link-code") as HTMLElement).textContent = link;
  (document.getElementById("case-link") as HTMLElement).hidden = false;
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
  if (!(await sent(`${id}/case`, made.body))?.ok) return false;
  showCaseLink(made.link, says);
  return true;
};

const verifying = async (id: string, version: number): Promise<void> => {
  said.textContent = "Trabajando…";
  const made = await caseMade(id, version, "Link para verificar, se muestra una vez. Pide la llave al abrirlo:");
  said.textContent = made ? "" : COULD_NOT;
};

const panicking = async (id: string, version: number, note: string): Promise<void> => {
  said.textContent = "Trabajando…";
  const held = await sent(`${id}/panic`, { note });
  if (!held?.ok) {
    said.textContent = COULD_NOT;
    return;
  }
  const { records } = (await held.json()) as { records: unknown };
  await load();
  const says = "Bloqueado y retenido. Link de caso para la autoridad, se muestra una vez. Entrégalo con la llave:";
  if (!(await caseMade(id, version, says, records))) {
    said.textContent = "Quedó bloqueado y retenido, pero no se pudo crear el link. Presiona de nuevo el botón.";
  }
};

const purging = async (id: string): Promise<void> => {
  said.textContent = "Trabajando…";
  const preview = await answered(() =>
    fetch(`/api/docs/${id}/purge_owner`, { credentials: "same-origin", cache: "no-store" }),
  );
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
  const count = prompt(
    `Se borrarán ${purged} documentos de la llave dueña de ${id}, no de quien haya firmado una versión, y se conservan ${kept}: retenidos, con denuncia grave o citados por otra persona. No se puede deshacer. Escribe ${purged} para seguir.`,
  );
  if (count?.trim() !== String(purged)) return;
  const note = prompt("¿Por qué se borran?");
  if (!note?.trim()) return;
  said.textContent = "Trabajando…";
  const purge = await sent(`${id}/purge_owner`, { note });
  if (!purge?.ok) {
    said.textContent = COULD_NOT;
    return;
  }
  const done = (await purge.json()) as { purged: number; kept: number };
  await load();
  said.textContent = `Dejaron de servirse ${done.purged}. Se vacían en la próxima limpieza, que espera si el servicio está cortado. Se conservan ${done.kept}.`;
};

let reportsFrom = 0;

const load = async (): Promise<void> => {
  const path = reportsFrom === 0 ? "/api/queue" : `/api/queue?from=${reportsFrom}`;
  const response = await answered(() => fetch(path, { credentials: "same-origin", cache: "no-store" }));
  if (!response?.ok) {
    said.textContent = "No se pudo traer el panel. Recarga la página, quizá debas volver a entrar.";
    return;
  }
  const queue = (await response.json()) as Queue;
  if (queue.reports.length === 0 && reportsFrom > 0) {
    reportsFrom = 0;
    await load();
    return;
  }
  drawQueue(document, queue, {
    accept: (id) => confirmed(`¿Aceptar y desbloquear ${id}?`, `${id}/accept`),
    reject: (id) => confirmed(`¿Rechazar el reclamo de ${id}? Sigue bloqueado.`, `${id}/reject`),
    clearWarning: (id) =>
      confirmed(`¿Quitar el aviso de ${id}? Sus denuncias leves dejan de contar.`, `${id}/clear_warning`),
    networkWasFalse: (id, net) =>
      confirmed(
        "¿Descartar todas las denuncias de esta red? Si es compartida, puede incluir denuncias reales, y sus documentos dejarán de retenerse.",
        `${id}/reports/${net}/false_network`,
      ),
    forgetContact: (id, net) =>
      confirmed(
        "¿Borrar el correo de esta denuncia? Sigue hasta 30 días en los respaldos cifrados.",
        `${id}/reports/${net}/forget_contact`,
      ),
    reportWasFalse: (id, net) =>
      confirmed("¿Esta denuncia era falsa? Esa red dejará de contar.", `${id}/reports/${net}/false`),
    opened: (id) => {
      const reason = prompt("¿Por qué se abrió este documento?");
      if (reason?.trim()) void doing(`${id}/opened`, reason);
    },
    panic: (id, version) => {
      const note = prompt(`¿Por qué bloquear y retener ${id}? Dejará de servirse y se retiene 180 días.`);
      if (note?.trim()) void panicking(id, version, note);
    },
    blockKey: (root) => {
      const reason = prompt(`¿Por qué bloquear la llave ${root}? No podrá subir nada más, y lo ya compartido sigue.`);
      if (reason?.trim()) void doing(`${root}/block`, reason, "keys");
    },
    unblockKey: (root) => {
      if (confirm(`¿Desbloquear la llave ${root}?`)) void doing(`${root}/unblock`, undefined, "keys");
    },
    purgeOwner: (id) => void purging(id),
    verifyLink: (id, version) => void verifying(id, version),
    reportsPage: (from) => {
      reportsFrom = from;
      void load();
    },
    handedOver: (id) =>
      confirmed(
        "¿Ya entregaste el link de caso y la llave a la autoridad? Se borran las llaves selladas de este documento, aunque siguen hasta 30 días en los respaldos cifrados.",
        `${id}/handed_over`,
      ),
    copy: (command) => copying(command, "Copiado. Reemplaza <llave> por la ruta de tu llave y ábrelo en tu equipo."),
  });
  said.textContent = "";
};

const doing = async (path: string, note?: string, on?: string): Promise<void> => {
  said.textContent = "Trabajando…";
  if (await asked(path, note, on)) await load();
  else said.textContent = COULD_NOT;
};

const confirmed = (question: string, path: string): void => {
  if (confirm(question)) void doing(path);
};

(document.getElementById("case-link-copy") as HTMLElement).addEventListener("click", () => {
  const link = (document.getElementById("case-link-code") as HTMLElement).textContent ?? "";
  copying(link, "Link copiado.");
});

(document.getElementById("block-form") as HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  const id = (document.getElementById("block-id") as HTMLInputElement).value.trim();
  const note = (document.getElementById("block-note") as HTMLInputElement).value;
  if (confirm(`¿Bloquear ${id}? Dejará de servirse.`)) void doing(`${id}/block`, note);
});

(document.getElementById("key-form") as HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  const root = (document.getElementById("key-root") as HTMLInputElement).value.trim();
  const note = (document.getElementById("key-note") as HTMLInputElement).value;
  if (confirm(`¿Bloquear la llave ${root}? No podrá subir nada más.`)) void doing(`${root}/block`, note, "keys");
});

void load();
