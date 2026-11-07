import type { Queue, QueuedDoc, QueuedReport } from "../../core/queue";

export interface Doing {
  accept: (id: string) => void;
  reject: (id: string) => void;
  reportWasFalse: (id: string, net: string) => void;
  forgetContact: (id: string, net: string) => void;
  opened: (id: string) => void;
  copy: (said: string) => void;
  panic: (id: string, version: number) => void;
  verifyLink: (id: string, version: number) => void;
  handedOver: (id: string) => void;
}

const STAGES: Record<string, string> = {
  open: "abierto",
  warned: "con aviso de gasto",
  new_keys_off: "subidas solo de llaves antiguas",
  no_uploads: "subidas cortadas",
  blocked: "bloqueado por gasto",
};

const dayText = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

const piece = (page: Document, tag: string, className: string, said: string): HTMLElement => {
  const one = page.createElement(tag);
  one.className = className;
  one.textContent = said;
  return one;
};

const button = (page: Document, said: string, press: () => void, danger = false): HTMLButtonElement => {
  const one = page.createElement("button");
  one.type = "button";
  one.textContent = said;
  if (danger) one.className = "is-danger";
  one.addEventListener("click", press);
  return one;
};

const actions = (page: Document, ...buttons: HTMLButtonElement[]): HTMLElement => {
  const row = page.createElement("div");
  row.className = "actions";
  row.append(...buttons);
  return row;
};

const signersText = ({ signers }: QueuedDoc): string => {
  const others = signers.filter((one) => !one.byOwner).map((one) => one.n);
  return others.length === 0 ? "Su dueño firmó todas las versiones." : `No las firmó su dueño: ${others.join(", ")}.`;
};

const openCommand = (doc: string, sealed: string): string =>
  `node scripts/report-key.mjs open <llave> ${doc} ${sealed}`;

const reportCard = (page: Document, report: QueuedReport, doing: Doing): HTMLElement => {
  const card = page.createElement("article");
  card.className = report.level === "grave" ? "card is-grave" : "card";
  card.append(
    piece(page, "p", "card-title", `${report.category} · ${report.doc}`),
    piece(page, "p", "card-line", `Versión ${report.version} · operador ${report.asn} · ${dayText(report.at)}`),
  );
  if (report.fromFalseNet)
    card.append(piece(page, "p", "card-line", "Esta red ya tuvo una denuncia falsa: no cuenta para bloquear."));
  if (report.detail) card.append(piece(page, "p", "card-line", report.detail));
  const buttons = [
    button(page, "Link para verificar", () => doing.verifyLink(report.doc, report.version)),
    button(page, "Era falsa", () => doing.reportWasFalse(report.doc, report.net)),
    button(page, "Botón de pánico", () => doing.panic(report.doc, report.version), true),
  ];
  if (report.sealedLink) {
    const sealed = report.sealedLink;
    card.append(piece(page, "code", "sealed", sealed));
    buttons.unshift(
      button(page, "Copiar para abrir", () => doing.copy(openCommand(report.doc, sealed))),
      button(page, "Anotar apertura", () => doing.opened(report.doc)),
    );
  }
  if (report.sealedContact) {
    const contact = report.sealedContact;
    card.append(
      piece(
        page,
        "p",
        "card-line",
        "Trae un correo sin comprobar: al escribir, no nombres el documento ni lo denunciado.",
      ),
    );
    buttons.unshift(
      button(page, "Copiar para leer su correo", () => doing.copy(openCommand(report.doc, contact))),
      button(page, "Borrar su correo", () => doing.forgetContact(report.doc, report.net)),
    );
  }
  card.append(actions(page, ...buttons));
  return card;
};

const docCard = (page: Document, doc: QueuedDoc, doing: Doing, waiting: boolean): HTMLElement => {
  const card = page.createElement("article");
  card.className = "card";
  card.append(
    piece(page, "p", "card-title", doc.id),
    piece(page, "p", "card-line", `Bloqueado el ${dayText(doc.blockedAt)} · versión ${doc.latest}`),
    piece(page, "p", "card-line", signersText(doc)),
    piece(page, "p", "card-line", `Un link de caso abre la versión ${doc.versionToOpen}.`),
  );
  if (doc.mayCorrect)
    card.append(piece(page, "p", "card-line", "Reclamo aceptado solo: espera una versión de su dueño."));
  card.append(
    actions(
      page,
      button(page, "Link para verificar", () => doing.verifyLink(doc.id, doc.versionToOpen)),
      button(page, "Botón de pánico", () => doing.panic(doc.id, doc.versionToOpen), true),
      ...(doc.mayHandOver ? [button(page, "Ya lo entregué", () => doing.handedOver(doc.id))] : []),
    ),
  );
  if (waiting) {
    card.append(
      actions(
        page,
        button(page, "Aceptar y desbloquear", () => doing.accept(doc.id)),
        button(page, "Rechazar", () => doing.reject(doc.id), true),
      ),
    );
  } else if (!doc.mayCorrect) {
    card.append(
      actions(
        page,
        button(page, "Desbloquear", () => doing.accept(doc.id)),
      ),
    );
  }
  return card;
};

const filled = (place: Element, page: Document, cards: HTMLElement[], none: string): void => {
  place.replaceChildren(...(cards.length > 0 ? cards : [piece(page, "p", "card-line", none)]));
};

export const drawQueue = (page: Document, queue: Queue, doing: Doing): void => {
  const place = (id: string): Element => page.getElementById(id) as Element;
  place("state").textContent = `Servicio ${STAGES[queue.stage] ?? queue.stage}. Llaves nuevas hoy: ${queue.newKeys}.`;
  filled(
    place("appeals"),
    page,
    queue.docs.filter((one) => one.waitsForOperator).map((one) => docCard(page, one, doing, true)),
    "Ninguno.",
  );
  filled(
    place("reports"),
    page,
    [
      ...queue.reports.map((one) => reportCard(page, one, doing)),
      ...(queue.reportsTotal > queue.reports.length
        ? [
            piece(
              page,
              "p",
              "card-line",
              `Se ven las ${queue.reports.length} más graves y recientes de ${queue.reportsTotal}.`,
            ),
          ]
        : []),
    ],
    "Ninguna.",
  );
  filled(
    place("blocked"),
    page,
    queue.docs.filter((one) => !one.waitsForOperator).map((one) => docCard(page, one, doing, false)),
    "Ninguno.",
  );
};
