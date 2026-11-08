import type { Top, TopDoc } from "../../core/dashboard";
import type { Signal } from "../../core/signals";
import { ago, button, cell, count, daysText, megabytes, piece, shortDay, shortKey, type Tone, todayOf } from "./say";

const SHOWN_AT_FIRST = 10;
const BOTS: Signal["kind"][] = ["cap", "proved", "even"];
const BOT_SAID: Partial<Record<Signal["kind"], string>> = {
  cap: "tope de lectores",
  proved: "casi todo con prueba",
  even: "parejo las 24 h",
};
const REPORTED: Record<string, string> = {
  grave: "Denuncia grave",
  medium: "Denuncia de engaño",
  light: "Denuncia leve",
};
const COLUMNS: [string, boolean][] = [
  ["Documento", false],
  ["Llave", false],
  ["Redes hoy", true],
  ["Con prueba", true],
  ["Horas", true],
  ["Ayer", true],
  ["Peso", true],
  ["Ediciones", true],
  ["Versión", false],
  ["Compartido", false],
  ["Caducaba", false],
  ["Caduca ahora", false],
  ["Señal", false],
];

export interface Ranking {
  showKey: (root: string) => void;
}

const otherSaid = (signal: Signal): string | null => {
  switch (signal.kind) {
    case "lone":
      return signal.byUploader
        ? `Solo la lee la red que la sube · ${daysText(signal.days)} viva`
        : `Una sola red la mantiene viva · ${daysText(signal.days)}`;
    case "keys":
      return `Misma red subió ${signal.keys} llaves y ${signal.docs} documentos`;
    case "edits":
      return `${signal.edits} ediciones en un día`;
    case "report":
      return REPORTED[signal.level] ?? "Denuncia abierta";
    default:
      return null;
  }
};

export const signalText = (signals: Signal[]): { said: string; tone: Tone } => {
  if (signals.length === 0) return { said: "Normal", tone: "ok" };
  const bots = signals.filter((one) => BOTS.includes(one.kind)).map((one) => BOT_SAID[one.kind]);
  const others = signals.map(otherSaid).filter((one): one is string => one !== null);
  const said = [...(bots.length > 0 ? [`Bots: ${bots.join(", ")}`] : []), ...others].join(" · ");
  const alarming = signals.some(
    (one) => BOTS.includes(one.kind) || one.kind === "keys" || (one.kind === "report" && one.level === "grave"),
  );
  return { said, tone: alarming ? "danger" : "warn" };
};

const rowOf = (page: Document, doc: TopDoc, now: number, ranking: Ranking): HTMLTableRowElement => {
  const today = todayOf(now);
  const { said, tone } = signalText(doc.signals);
  const row = page.createElement("tr");
  row.className = `is-${tone}`;
  const id = page.createElement("td");
  id.append(
    piece(page, "code", "mono", doc.id),
    ...(doc.languages > 0
      ? [" ", piece(page, "span", "soft", `+${doc.languages} ${doc.languages === 1 ? "idioma" : "idiomas"}`)]
      : []),
    ...(doc.blocked ? [" ", piece(page, "span", "chip is-blocked", "bloqueado")] : []),
    ...(doc.paused ? [" ", piece(page, "span", "chip is-light", "en pausa")] : []),
  );
  const key = page.createElement("td");
  key.className = "nowrap";
  const age = doc.keyDay === null ? "" : ` · ${daysText(today - doc.keyDay)}`;
  key.append(
    button(page, shortKey(doc.owner), () => ranking.showKey(doc.owner)),
    piece(page, "span", "soft", age),
  );
  const flag = page.createElement("td");
  flag.append(piece(page, "span", `chip is-${tone}`, said));
  row.append(
    id,
    key,
    cell(
      page,
      `${count(doc.today.nets)}${doc.ownerAtTop ? " · tope" : ""}`,
      `num${doc.ownerAtTop ? " is-danger" : ""}`,
    ),
    cell(page, count(doc.today.proved), "num soft"),
    cell(page, `${doc.today.hours}/24`, "num soft"),
    cell(page, doc.yesterday === null ? "—" : count(doc.yesterday.nets), "num soft"),
    cell(page, megabytes(doc.bytes), "num"),
    cell(page, count(doc.latest), "num"),
    cell(page, `v${doc.latest}${doc.latestAt === null ? "" : ` · ${ago(doc.latestAt, now)}`}`, "nowrap"),
    cell(page, doc.firstDay === null ? "—" : shortDay(doc.firstDay), "nowrap soft"),
    cell(page, doc.firstDay === null ? "—" : shortDay(doc.firstDay + doc.ttlDays), "nowrap soft"),
    cell(page, shortDay(doc.diesOn), "nowrap"),
    flag,
  );
  return row;
};

export const drawTop = (page: Document, place: Element, top: Top, now: number, ranking: Ranking): void => {
  if (top.docs.length === 0) {
    const none = top.flaggedOnly ? "Ningún documento marcado." : "Ningún documento abierto.";
    place.replaceChildren(piece(page, "p", "card-line", none));
    return;
  }
  const headRow = page.createElement("tr");
  for (const [said, numeric] of COLUMNS) headRow.append(piece(page, "th", numeric ? "num" : "", said));
  const thead = page.createElement("thead");
  thead.append(headRow);
  const rows = top.docs.map((doc) => rowOf(page, doc, now, ranking));
  const tbody = page.createElement("tbody");
  tbody.append(...rows);
  const table = page.createElement("table");
  table.className = "top-table";
  table.append(thead, tbody);
  const scroll = page.createElement("div");
  scroll.className = "scroll";
  scroll.append(table);
  const foot = page.createElement("div");
  foot.className = "top-foot";
  const shown = piece(page, "span", "", "");
  const sayShown = (n: number): void => {
    shown.textContent = `Se ven ${Math.min(n, rows.length)} de ${rows.length}.`;
  };
  rows.forEach((row, at) => {
    row.hidden = at >= SHOWN_AT_FIRST;
  });
  sayShown(SHOWN_AT_FIRST);
  foot.append(shown);
  if (rows.length > SHOWN_AT_FIRST) {
    const all = button(page, `Ver los ${rows.length}`, () => {
      for (const row of rows) row.hidden = false;
      sayShown(rows.length);
      all.remove();
    });
    foot.append(all);
  }
  place.replaceChildren(scroll, foot);
};
