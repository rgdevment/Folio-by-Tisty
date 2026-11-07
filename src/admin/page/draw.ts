import type { Queue, QueuedDoc, QueuedReport, QueuedWarning } from "../../core/queue";

export interface Doing {
  accept: (id: string) => void;
  reject: (id: string) => void;
  reportWasFalse: (id: string, net: string) => void;
  forgetContact: (id: string, net: string) => void;
  networkWasFalse: (id: string, net: string) => void;
  opened: (id: string) => void;
  blockKey: (root: string) => void;
  unblockKey: (root: string) => void;
  copy: (said: string) => void;
  panic: (id: string, version: number) => void;
  purgeOwner: (id: string) => void;
  verifyLink: (id: string, version: number) => void;
  handedOver: (id: string) => void;
  reportsPage: (from: number) => void;
  clearWarning: (id: string) => void;
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

const checkCommand = (doc: string, sealed: string): string =>
  `node scripts/report-key.mjs check <llave> ${doc} ${sealed} "<link para verificar>"`;

const reportCard = (page: Document, report: QueuedReport, doing: Doing): HTMLElement => {
  const card = page.createElement("article");
  card.className = report.level === "grave" ? "card is-grave" : "card";
  card.append(
    piece(page, "p", "card-title", `${report.category} · ${report.doc}`),
    piece(page, "p", "card-line", `Versión ${report.version} · operador ${report.asn} · ${dayText(report.at)}`),
  );
  if (report.overCap)
    card.append(
      piece(page, "p", "card-line", "Esta red pasó su tope de documentos: no cuenta para bloquear ni retener."),
    );
  if (report.fromFalseNet)
    card.append(piece(page, "p", "card-line", "Esta red ya tuvo una denuncia falsa: no cuenta para bloquear."));
  if (report.detail) card.append(piece(page, "p", "card-line", report.detail));
  const buttons = [
    button(page, "Link para verificar", () => doing.verifyLink(report.doc, report.version)),
    button(page, "Era falsa", () => doing.reportWasFalse(report.doc, report.net)),
    button(page, "Botón de pánico", () => doing.panic(report.doc, report.version), true),
    button(page, "Borrar todo de esta llave", () => doing.purgeOwner(report.doc), true),
  ];
  if (report.fromFalseNet) {
    buttons.push(
      button(page, "Descartar todas las de esta red", () => doing.networkWasFalse(report.doc, report.net), true),
    );
  }
  const { owner } = report;
  if (owner) buttons.push(button(page, "Bloquear llave del dueño", () => doing.blockKey(owner), true));
  if (report.sealedLink) {
    const sealed = report.sealedLink;
    card.append(piece(page, "code", "sealed", sealed));
    buttons.unshift(
      button(page, "Comprobar sin abrir", () => doing.copy(checkCommand(report.doc, sealed))),
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
      button(page, "Borrar todo de esta llave", () => doing.purgeOwner(doc.id), true),
      button(page, "Bloquear llave del dueño", () => doing.blockKey(doc.owner), true),
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

const keyCard = (page: Document, { root, blockedAt }: Queue["blockedKeys"][number], doing: Doing): HTMLElement => {
  const card = page.createElement("article");
  card.className = "card";
  card.append(
    piece(page, "code", "sealed", root),
    piece(page, "p", "card-line", `Bloqueada el ${dayText(blockedAt)}`),
    actions(
      page,
      button(page, "Desbloquear llave", () => doing.unblockKey(root)),
    ),
  );
  return card;
};

const warningCard = (page: Document, warning: QueuedWarning, doing: Doing): HTMLElement => {
  const card = page.createElement("article");
  card.className = "card";
  card.append(
    piece(page, "p", "card-title", warning.id),
    piece(
      page,
      "p",
      "card-line",
      `${warning.nets} redes. Si no corrige, deja de servirse después del ${dayText(warning.fixBy)}.`,
    ),
    actions(
      page,
      button(page, "Quitar aviso", () => doing.clearWarning(warning.id)),
    ),
  );
  return card;
};

const pagesOfReports = (page: Document, queue: Queue, doing: Doing): HTMLElement[] => {
  const { reports, reportsFrom: from, reportsTotal: total } = queue;
  if (from === 0 && total <= reports.length) return [];
  const until = from + reports.length;
  return [
    piece(page, "p", "card-line", `Se ven de la ${from + 1} a la ${until} de ${total}.`),
    actions(
      page,
      ...(from > 0 ? [button(page, "Volver al inicio", () => doing.reportsPage(0))] : []),
      ...(until < total ? [button(page, "Ver las siguientes", () => doing.reportsPage(until))] : []),
    ),
  ];
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
    [...queue.reports.map((one) => reportCard(page, one, doing)), ...pagesOfReports(page, queue, doing)],
    "Ninguna.",
  );
  filled(
    place("warned"),
    page,
    queue.warned.map((one) => warningCard(page, one, doing)),
    "Ninguno.",
  );
  filled(
    place("blocked"),
    page,
    queue.docs.filter((one) => !one.waitsForOperator).map((one) => docCard(page, one, doing, false)),
    "Ninguno.",
  );
  filled(
    place("blocked-keys"),
    page,
    queue.blockedKeys.map((one) => keyCard(page, one, doing)),
    "Ninguna.",
  );
};
