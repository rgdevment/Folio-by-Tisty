import type { Owner } from "../../core/dashboard";
import { LEVEL_ONE } from "../../core/limits";
import type { Queue, QueuedDoc, QueuedReport, QueuedWarning } from "../../core/queue";
import { actions, button, daysText, dayText, megabytes, more, piece, shortKey } from "./say";

export interface Doing {
  accept: (id: string) => void;
  reject: (id: string) => void;
  reportWasFalse: (id: string, net: string) => void;
  forgetContact: (id: string, net: string) => void;
  networkWasFalse: (id: string, net: string) => void;
  openReport: (id: string, command: string, where: HTMLElement) => void;
  blockKey: (root: string) => void;
  unblockKey: (root: string) => void;
  copy: (command: string, then: string, where: HTMLElement) => void;
  panic: (id: string, version: number) => void;
  purgeOwner: (id: string) => void;
  verifyLink: (id: string, version: number) => void;
  handedOver: (id: string) => void;
  reportsPage: (from: number) => void;
  clearWarning: (id: string) => void;
  showKey: (root: string) => void;
}

export type Owners = Record<string, Owner>;

export const STAGES: Record<string, string> = {
  open: "abierto",
  warned: "con aviso de gasto",
  new_keys_off: "subidas solo de llaves antiguas",
  no_uploads: "subidas cortadas",
  blocked: "bloqueado por gasto",
};

const LEVELS: Record<string, string> = { grave: "Grave", medium: "Engaño", light: "Leve" };

const CATEGORIES: Record<string, string> = {
  csam: "Abuso sexual infantil",
  intimate: "Imágenes íntimas",
  threat: "Amenaza",
  doxxing: "Datos personales expuestos",
  phishing: "Phishing",
  malware: "Malware",
  scam: "Estafa",
  spam: "Spam",
  offensive: "Ofensivo",
};

const chip = (page: Document, said: string, kind: string): HTMLElement => piece(page, "span", `chip is-${kind}`, said);

const head = (page: Document, ...parts: HTMLElement[]): HTMLElement => {
  const row = page.createElement("div");
  row.className = "card-head";
  row.append(...parts);
  return row;
};

const signersText = ({ signers }: QueuedDoc): string => {
  const others = signers.filter((one) => !one.byOwner).map((one) => one.n);
  return others.length === 0 ? "Su dueño firmó todas las versiones." : `No las firmó su dueño: ${others.join(", ")}.`;
};

const REPORTS_KEY = "~/folio-reports.key";
const CHECKING =
  "Cambia <link para verificar> por uno del panel, entre las comillas. Dice si la llave abre ese documento, sin leer nada.";
const CONTACT = "Imprime el correo que dejó quien denunció.";

const openCommand = (doc: string, sealed: string): string =>
  `node scripts/report-key.mjs open ${REPORTS_KEY} ${doc} ${sealed}`;

const checkCommand = (doc: string, sealed: string): string =>
  `node scripts/report-key.mjs check ${REPORTS_KEY} ${doc} ${sealed} "<link para verificar>"`;

const keyAge = (owner: Owner, today: number): string =>
  owner.firstDay === null ? "llave sin registro" : `llave de ${daysText(today - owner.firstDay)}`;

const ownerLine = (page: Document, owner: Owner | undefined, today: number, doing: Doing): HTMLElement[] => {
  if (!owner) return [];
  const line = page.createElement("p");
  line.className = "card-line owner-line";
  const seeing = button(page, "Ver la llave", () => doing.showKey(owner.root));
  seeing.classList.add("is-link");
  line.append(
    "Dueño ",
    piece(page, "code", "mono", shortKey(owner.root)),
    ` · ${keyAge(owner, today)} · guarda ${megabytes(owner.holds)} de ${megabytes(LEVEL_ONE.keyBytesAtMost)}`,
    ...(owner.blockedAt === null ? [] : [" · bloqueada"]),
    " · ",
    seeing,
  );
  return [line];
};

const againstOwner = (page: Document, doc: string, ownerToBlock: string | null, doing: Doing): HTMLButtonElement[] => [
  ...(ownerToBlock ? [button(page, "Bloquear llave del dueño", () => doing.blockKey(ownerToBlock), true)] : []),
  button(page, "Borrar todo de esta llave", () => doing.purgeOwner(doc), true),
];

interface Standing {
  nets: number;
  asns: Set<number>;
  counting: number;
  countingAsns: Set<number>;
  blocked: boolean;
}

// As the server counts toward a block: not from a false or capped network, and a grave one only with its link.
const counts = (report: QueuedReport): boolean =>
  !report.fromFalseNet &&
  !report.overCap &&
  (report.level === "medium" || (report.level === "grave" && report.sealedLink !== null));

const standingsOf = (queue: Queue): Map<string, Standing> => {
  const blocked = new Set(queue.docs.map((one) => one.id));
  const standings = new Map<string, Standing>();
  for (const report of queue.reports) {
    const standing = standings.get(report.doc) ?? {
      nets: 0,
      asns: new Set<number>(),
      counting: 0,
      countingAsns: new Set<number>(),
      blocked: blocked.has(report.doc),
    };
    standing.nets += 1;
    standing.asns.add(report.asn);
    if (counts(report)) {
      standing.counting += 1;
      standing.countingAsns.add(report.asn);
    }
    standings.set(report.doc, standing);
  }
  return standings;
};

const standingText = (report: QueuedReport, standing: Standing | undefined): string => {
  if (!standing) return "";
  const { reportsToBlock, reportOperatorsToBlock } = LEVEL_ONE;
  const reported = `${standing.nets} ${standing.nets === 1 ? "red" : "redes"} de ${standing.asns.size} ${standing.asns.size === 1 ? "proveedor" : "proveedores"}`;
  const state = standing.blocked
    ? "bloqueado"
    : report.level === "light"
      ? ""
      : `${standing.counting} de ${reportsToBlock} redes y ${standing.countingAsns.size} de ${reportOperatorsToBlock} proveedores para bloquear`;
  return [reported, state, report.sealedLink ? "trae link sellado" : ""].filter((one) => one).join(" · ");
};

const reportCard = (
  page: Document,
  report: QueuedReport,
  doing: Doing,
  owner: Owner | undefined,
  today: number,
  standing: Standing | undefined,
) => {
  const card = page.createElement("article");
  card.className = report.level === "grave" ? "card is-grave" : report.level === "medium" ? "card is-medium" : "card";
  card.dataset.level = report.level;
  card.append(
    head(
      page,
      chip(page, LEVELS[report.level] ?? report.level, report.level),
      piece(page, "strong", "", CATEGORIES[report.category] ?? report.category),
      piece(page, "code", "mono soft", report.doc),
      piece(page, "span", "soft", `· versión ${report.version} · operador ${report.asn} · ${dayText(report.at)}`),
      piece(page, "span", "grow", ""),
      piece(page, "span", "soft", standingText(report, standing)),
    ),
  );
  if (report.detail) card.append(piece(page, "p", "card-detail", report.detail));
  if (report.overCap)
    card.append(
      piece(page, "p", "card-line", "Esta red pasó su tope de documentos: no cuenta para bloquear ni retener."),
    );
  if (report.fromFalseNet)
    card.append(piece(page, "p", "card-line", "Esta red ya tuvo una denuncia falsa: no cuenta para bloquear."));
  const sealed = report.sealedLink;
  const contact = report.sealedContact;
  if (contact)
    card.append(
      piece(
        page,
        "p",
        "card-line",
        "Trae un correo sin comprobar: al escribir, no nombres el documento ni lo denunciado.",
      ),
    );
  const verifying = button(page, "Link para verificar", () => doing.verifyLink(report.doc, report.version));
  const main = [
    sealed
      ? button(page, "Abrir denuncia", () => doing.openReport(report.doc, openCommand(report.doc, sealed), card))
      : verifying,
    button(page, "Era falsa", () => doing.reportWasFalse(report.doc, report.net)),
    button(page, "Bloquear documento", () => doing.panic(report.doc, report.version), true),
  ];
  const rest = [
    ...(sealed
      ? [
          button(page, "Comprobar sin abrir", () => doing.copy(checkCommand(report.doc, sealed), CHECKING, card)),
          verifying,
        ]
      : []),
    ...(contact
      ? [
          button(page, "Copiar para leer su correo", () => doing.copy(openCommand(report.doc, contact), CONTACT, card)),
          button(page, "Borrar su correo", () => doing.forgetContact(report.doc, report.net)),
        ]
      : []),
    ...(report.fromFalseNet
      ? [button(page, "Descartar todas las de esta red", () => doing.networkWasFalse(report.doc, report.net), true)]
      : []),
    ...againstOwner(page, report.doc, report.ownerToBlock, doing),
  ];
  card.append(...ownerLine(page, owner, today, doing), actions(page, ...main, ...more(page, ...rest)));
  return card;
};

const docCard = (
  page: Document,
  doc: QueuedDoc,
  doing: Doing,
  waiting: boolean,
  owner: Owner | undefined,
  today: number,
) => {
  const card = page.createElement("article");
  card.className = "card";
  card.append(
    head(
      page,
      chip(page, waiting ? "Reclamo" : "Bloqueado", waiting ? "appeal" : "blocked"),
      piece(page, "code", "mono", doc.id),
      piece(page, "span", "soft", `· bloqueado el ${dayText(doc.blockedAt)} · versión ${doc.latest}`),
    ),
    piece(page, "p", "card-line", signersText(doc)),
    piece(page, "p", "card-line", `Un link de caso abre la versión ${doc.versionToOpen}.`),
  );
  if (doc.mayCorrect)
    card.append(piece(page, "p", "card-line", "Reclamo aceptado solo: espera una versión de su dueño."));
  const main = waiting
    ? [
        button(page, "Aceptar y desbloquear", () => doing.accept(doc.id)),
        button(page, "Rechazar", () => doing.reject(doc.id), true),
      ]
    : doc.mayCorrect
      ? []
      : [button(page, "Desbloquear", () => doing.accept(doc.id))];
  const rest = [
    button(page, "Link para verificar", () => doing.verifyLink(doc.id, doc.versionToOpen)),
    button(page, "Preparar entrega a la autoridad", () => doing.panic(doc.id, doc.versionToOpen), true),
    ...againstOwner(page, doc.id, doc.ownerToBlock, doing),
  ];
  card.append(
    ...ownerLine(page, owner, today, doing),
    actions(
      page,
      ...main,
      ...(doc.mayHandOver ? [button(page, "Ya lo entregué", () => doing.handedOver(doc.id))] : []),
      ...more(page, ...rest),
    ),
  );
  return card;
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
      button(page, "Ver la llave", () => doing.showKey(root)),
    ),
  );
  return card;
};

const warningCard = (page: Document, warning: QueuedWarning, doing: Doing): HTMLElement => {
  const card = page.createElement("article");
  card.className = "card";
  card.append(
    head(page, chip(page, "Leve", "light"), piece(page, "code", "mono", warning.id)),
    piece(
      page,
      "p",
      "card-line",
      `Aviso al dueño: ${warning.nets} redes. Si no corrige, deja de servirse después del ${dayText(warning.fixBy)}.`,
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

const countFilters = (page: Document, queue: Queue, appeals: number): void => {
  const counts: Record<string, number> = {
    all: queue.reportsTotal + queue.docs.length + queue.warned.length + queue.blockedKeys.length,
    grave: queue.reports.filter((one) => one.level === "grave").length,
    medium: queue.reports.filter((one) => one.level === "medium").length,
    appeals,
    warned: queue.warned.length,
    blocked: queue.docs.length - appeals,
    keys: queue.blockedKeys.length,
  };
  for (const counted of page.querySelectorAll<HTMLElement>("[data-count]")) {
    counted.textContent = String(counts[counted.dataset.count ?? ""] ?? 0);
  }
};

export const drawQueue = (page: Document, queue: Queue, doing: Doing, owners: Owners = {}, today = 0): void => {
  const place = (id: string): Element => page.getElementById(id) as Element;
  place("state").textContent = `Servicio ${STAGES[queue.stage] ?? queue.stage}`;
  place("state").className = `stage-chip is-${queue.stage}`;
  const appeals = queue.docs.filter((one) => one.waitsForOperator);
  const standings = standingsOf(queue);
  const part = (id: string, cards: HTMLElement[]) => {
    place(id).replaceChildren(...cards);
    (place(id).closest(".queue-part") as HTMLElement).hidden = cards.length === 0;
  };
  part(
    "appeals",
    appeals.map((one) => docCard(page, one, doing, true, owners[one.id], today)),
  );
  part(
    "reports",
    queue.reports.length === 0
      ? []
      : [
          ...queue.reports.map((one) => reportCard(page, one, doing, owners[one.doc], today, standings.get(one.doc))),
          ...pagesOfReports(page, queue, doing),
        ],
  );
  part(
    "warned",
    queue.warned.map((one) => warningCard(page, one, doing)),
  );
  part(
    "blocked",
    queue.docs
      .filter((one) => !one.waitsForOperator)
      .map((one) => docCard(page, one, doing, false, owners[one.id], today)),
  );
  part(
    "blocked-keys",
    queue.blockedKeys.map((one) => keyCard(page, one, doing)),
  );
  countFilters(page, queue, appeals.length);
  sayWhenEmpty(page);
};

// Each part hides when it has nothing, so a filter with nothing in it says so once.
export const sayWhenEmpty = (page: Document): void => {
  const filter = (page.getElementById("queue") as HTMLElement).dataset.filter ?? "all";
  const counted = Number(page.querySelector(`[data-count="${filter}"]`)?.textContent ?? 0);
  const empty = page.getElementById("queue-empty") as HTMLElement;
  empty.textContent = filter === "all" ? "Nada por revisar." : "Nada en este filtro.";
  empty.hidden = counted > 0;
};
