import "./panel.css";
import type { Queue } from "../../core/queue";
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

const asked = async (path: string, note?: string): Promise<boolean> => {
  const response = await answered(() =>
    fetch(`/api/docs/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Folio-Operator": "1", "Content-Type": "application/json" },
      ...(note === undefined ? {} : { body: JSON.stringify({ note }) }),
    }),
  );
  return response?.ok ?? false;
};

const load = async (): Promise<void> => {
  const response = await answered(() => fetch("/api/queue", { credentials: "same-origin", cache: "no-store" }));
  if (!response?.ok) {
    said.textContent = "No se pudo traer el panel. Recarga la página, quizá debas volver a entrar.";
    return;
  }
  drawQueue(document, (await response.json()) as Queue, {
    accept: (id) => confirmed(`¿Aceptar y desbloquear ${id}? Sus denunciantes dejarán de contar.`, `${id}/accept`),
    reject: (id) => confirmed(`¿Rechazar el reclamo de ${id}? Sigue bloqueado.`, `${id}/reject`),
    reportWasFalse: (id, net) =>
      confirmed("¿Esta denuncia era falsa? Esa red dejará de contar.", `${id}/reports/${net}/false`),
    opened: (id) => {
      const reason = prompt("¿Por qué se abrió este documento?");
      if (reason?.trim()) void doing(`${id}/opened`, reason);
    },
    copy: (command) => {
      void navigator.clipboard.writeText(command).then(
        () => {
          said.textContent = "Copiado. Reemplaza <llave> por la ruta de tu llave y ábrelo en tu equipo.";
        },
        () => {
          said.textContent = "No se pudo copiar. El comando es este:";
          said.append(" ", command);
        },
      );
    },
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

(document.getElementById("block-form") as HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  const id = (document.getElementById("block-id") as HTMLInputElement).value.trim();
  const note = (document.getElementById("block-note") as HTMLInputElement).value;
  if (confirm(`¿Bloquear ${id}? Dejará de servirse.`)) void doing(`${id}/block`, note);
});

void load();
