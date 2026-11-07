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

const sent = (path: string, body?: unknown): Promise<Response | null> =>
  answered(() =>
    fetch(`/api/docs/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Folio-Operator": "1", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const asked = async (path: string, note?: string): Promise<boolean> =>
  (await sent(path, note === undefined ? undefined : { note }))?.ok ?? false;

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

let reportsFrom = 0;

const load = async (): Promise<void> => {
  const path = reportsFrom === 0 ? "/api/queue" : `/api/queue?from=${reportsFrom}`;
  const response = await answered(() => fetch(path, { credentials: "same-origin", cache: "no-store" }));
  if (!response?.ok) {
    said.textContent = "No se pudo traer el panel. Recarga la página, quizá debas volver a entrar.";
    return;
  }
  drawQueue(document, (await response.json()) as Queue, {
    accept: (id) => confirmed(`¿Aceptar y desbloquear ${id}?`, `${id}/accept`),
    reject: (id) => confirmed(`¿Rechazar el reclamo de ${id}? Sigue bloqueado.`, `${id}/reject`),
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

const doing = async (path: string, note?: string): Promise<void> => {
  said.textContent = "Trabajando…";
  if (await asked(path, note)) await load();
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

void load();
