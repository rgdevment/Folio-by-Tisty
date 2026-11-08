import type { About, Logged, NetsNearTheirTop, Overview, ServiceDay } from "../../core/dashboard";
import {
  bar,
  cell,
  clock,
  count,
  decimal,
  gigabytes,
  HOUR_MS,
  megabytes,
  piece,
  shortKey,
  type Tone,
  when,
} from "./say";

export type Overlook = Overview & About & { operator: string };

const LADDER: [string, string][] = [
  ["open", "Abierto"],
  ["warned", "Aviso"],
  ["new_keys_off", "Solo antiguas"],
  ["no_uploads", "Sin subidas"],
  ["blocked", "Cortado"],
];

const ACTIONS: Record<string, string> = {
  accept: "Aceptar reclamo",
  reject: "Rechazar reclamo",
  block: "Bloquear",
  block_key: "Bloquear llave",
  unblock_key: "Desbloquear llave",
  panic: "Botón de pánico",
  purge_owner: "Borrar todo de la llave",
  case: "Link de caso",
  handed_over: "Entregado",
  clear_warning: "Quitar aviso",
  forget_contact: "Borrar correo",
  false_report: "Era falsa",
  false_network: "Red falsa",
  opened: "Abrir para verificar",
};

const SPEND_STALE_MS = 3_600_000;
const SWEEP_STALE_HOURS = 26;

const tile = (page: Document, label: string, value: string, under: string, tone: Tone): HTMLElement => {
  const one = page.createElement("div");
  one.className = "tile";
  one.append(
    piece(page, "span", "tile-label", label),
    piece(page, "strong", "tile-value", value),
    piece(page, "span", `tile-under is-${tone}`, under),
  );
  return one;
};

const readersUnder = ({ yesterday }: Overview["readers"]): string => {
  if (yesterday === null) return "sin datos de ayer";
  return `ayer ${count(yesterday)}`;
};

const storedOf = ({ stored }: Overview): number => (stored.gb === null ? stored.heldBytes / 1e9 : stored.gb);

export const drawTiles = (page: Document, place: Element, seen: Overlook): void => {
  const { docs, readers, keys, uploads, stored, reports } = seen;
  const open = reports.grave + reports.medium + reports.light;
  place.replaceChildren(
    tile(
      page,
      "Documentos abiertos",
      count(docs.open),
      `+${count(docs.newToday)} hoy · ${count(docs.withLanguages)} en varios idiomas`,
      "ok",
    ),
    tile(page, "Lectores hoy", count(readers.today), readersUnder(readers), "soft"),
    tile(
      page,
      "Llaves",
      count(keys.total),
      `${count(keys.newToday)} nuevas hoy · tope ${keys.newADay} por red`,
      "soft",
    ),
    tile(page, "Subidas hoy", count(uploads.today), `${count(uploads.newDocs)} documentos nuevos`, "soft"),
    tile(
      page,
      "Guardado",
      `${decimal(storedOf(seen))} GB`,
      `de ${stored.atMostGb} · ${gigabytes(stored.newKeysBytesToday)} de llaves nuevas hoy`,
      "soft",
    ),
    tile(
      page,
      "Denuncias abiertas",
      count(open),
      `${reports.grave} graves · ${reports.medium} de engaño · ${reports.light} leves`,
      open > 0 ? "danger" : "soft",
    ),
  );
};

const meter = (page: Document, label: string, said: string, track: HTMLElement): HTMLElement => {
  const one = page.createElement("div");
  one.className = "meter";
  const top = page.createElement("div");
  top.className = "meter-head";
  top.append(piece(page, "span", "", label), piece(page, "span", "soft", said));
  one.append(top, track);
  return one;
};

const usd = (n: number): string => decimal(n, 2);

const spendMeter = (page: Document, { spend }: Overlook): HTMLElement => {
  if (spend.bill === null || spend.line === null) {
    return meter(page, "Gasto del mes", "la revisión del gasto aún no anota nada", bar(page, 0, "accent"));
  }
  const said = `${usd(spend.bill)} de ${spend.capUsd} USD · corte en la línea de hoy ${usd(spend.line)}`;
  const tone: Tone = spend.bill >= spend.line ? "danger" : spend.bill >= spend.line * 0.75 ? "warn" : "accent";
  return meter(page, "Gasto del mes", said, bar(page, spend.bill / spend.capUsd, tone, [spend.line / spend.capUsd]));
};

const storageMeter = (page: Document, seen: Overlook): HTMLElement => {
  const { atMostGb, newKeysStopGb, gb } = seen.stored;
  const stored = storedOf(seen);
  const measured = gb === null ? " · contado en D1" : "";
  const said = `${decimal(stored)} de ${atMostGb} GB · llaves nuevas paran en ${newKeysStopGb}${measured}`;
  const tone: Tone = stored >= atMostGb ? "danger" : stored >= newKeysStopGb ? "warn" : "ok";
  return meter(page, "Guardado", said, bar(page, stored / atMostGb, tone, [newKeysStopGb / atMostGb, 1]));
};

const ladder = (page: Document, stage: string): HTMLElement => {
  const list = page.createElement("ol");
  list.className = "ladder";
  for (const [step, said] of LADDER) {
    const one = piece(page, "li", step === stage ? "is-here" : "", said);
    if (step === stage) one.setAttribute("aria-current", "step");
    list.append(one);
  }
  return list;
};

const beat = (page: Document, name: string, at: number | null, staleAfter: number, now: number): HTMLElement =>
  at === null
    ? piece(page, "span", "is-warn", `${name}: sin latido`)
    : piece(
        page,
        "span",
        now - at > staleAfter ? "is-danger" : "is-ok",
        `${name} ${now - at > staleAfter ? "✗" : "✓"} ${when(at, now)}`,
      );

// The digest only goes out when there is news, so a quiet day is not a missed beat.
const digestSaid = (hour: number | null, now: number): string =>
  hour === null ? "resumen: aún no sale ninguno" : `último resumen ${when((hour + 1) * HOUR_MS, now)}`;

export const drawHealth = (page: Document, place: Element, seen: Overlook, now: number): void => {
  const { beats } = seen;
  const pulse = page.createElement("div");
  pulse.className = "beats";
  pulse.append(
    piece(page, "span", "soft", "Latidos:"),
    beat(
      page,
      "limpieza diaria",
      beats.sweptHour === null ? null : beats.sweptHour * HOUR_MS,
      SWEEP_STALE_HOURS * HOUR_MS,
      now,
    ),
    beat(page, "gasto", beats.spentAt, SPEND_STALE_MS, now),
    piece(page, "span", "soft", digestSaid(beats.digestedHour, now)),
    piece(page, "span", "soft", "respaldo: en GitHub Actions"),
  );
  place.replaceChildren(spendMeter(page, seen), storageMeter(page, seen), ladder(page, seen.stage), pulse);
};

export const drawAbout = (page: Document, place: Element, seen: Overlook, now: number): void => {
  const sharing = seen.sharingOpen ? "abierto" : "cerrado";
  place.textContent = `Compartir: ${sharing} · Términos v${seen.termsVersion} · limits.json n.º ${seen.limitsSerial}`;
  const who = page.getElementById("operator");
  if (who) who.textContent = `${seen.operator ? `${seen.operator} · ` : ""}actualizado a las ${clock(now)}`;
};

const chart = (page: Document, title: string, days: ServiceDay[], key: "readers" | "uploads", tone: Tone) => {
  const figure = page.createElement("figure");
  figure.className = "chart";
  const total = days.reduce((sum, one) => sum + one[key], 0);
  const top = Math.max(1, ...days.map((one) => one[key]));
  const caption = page.createElement("figcaption");
  caption.append(
    piece(page, "strong", "", title),
    piece(page, "span", "soft", `${count(total)} en ${days.length} días`),
  );
  const bars = page.createElement("div");
  bars.className = "chart-bars";
  bars.setAttribute("role", "img");
  bars.setAttribute("aria-label", `${title}: ${count(total)} en ${days.length} días`);
  for (const one of days) {
    const column = piece(page, "div", `chart-bar is-${tone}`, "");
    column.style.height = `${Math.max(1, (one[key] / top) * 100).toFixed(1)}%`;
    column.title = `${count(one[key])}`;
    bars.append(column);
  }
  const foot = page.createElement("div");
  foot.className = "chart-foot";
  foot.append(piece(page, "span", "", `hace ${days.length} días`), piece(page, "span", "", "hoy"));
  figure.append(caption, bars, foot);
  return figure;
};

export const drawDays = (page: Document, place: Element, days: ServiceDay[]): void => {
  place.replaceChildren(
    chart(page, "Lectores por día", days, "readers", "accent"),
    chart(page, "Subidas por día", days, "uploads", "ok"),
  );
};

export const drawLog = (page: Document, place: Element, logged: Logged[], now: number): void => {
  if (logged.length === 0) {
    place.replaceChildren(piece(page, "p", "card-line", "Nada todavía."));
    return;
  }
  const rows = logged.map((one) => {
    const row = page.createElement("tr");
    const on = page.createElement("td");
    on.append(piece(page, "code", "mono", one.on.length > 8 ? shortKey(one.on) : one.on));
    row.append(
      cell(page, when(one.at, now), "soft nowrap"),
      cell(page, ACTIONS[one.action] ?? one.action),
      on,
      cell(page, one.note ?? "—", "note"),
    );
    return row;
  });
  const table = page.createElement("table");
  const headRow = page.createElement("tr");
  for (const said of ["Cuándo", "Acción", "Sobre", "Motivo"]) headRow.append(piece(page, "th", "", said));
  const thead = page.createElement("thead");
  thead.append(headRow);
  const tbody = page.createElement("tbody");
  tbody.append(...rows);
  table.append(thead, tbody);
  place.replaceChildren(table);
};

const netSaid = (net: NetsNearTheirTop["nets"][number], { limits }: NetsNearTheirTop): string =>
  [
    `${net.keys} de ${limits.keys} llaves nuevas`,
    `${net.docs} de ${limits.docs} documentos`,
    `${megabytes(net.bytes)} de ${megabytes(limits.bytes)}`,
    `${net.uploadsThisHour} de ${limits.uploadsAnHour} subidas esta hora`,
  ].join(" · ");

export const drawNets = (page: Document, place: Element, near: NetsNearTheirTop): void => {
  if (near.nets.length === 0) {
    place.replaceChildren(piece(page, "p", "card-line", "Ninguna red pasa de la mitad de su cupo hoy."));
    return;
  }
  place.replaceChildren(
    ...near.nets.map((net) => {
      const one = page.createElement("div");
      one.className = "meter";
      const top = page.createElement("div");
      top.className = "meter-head";
      top.append(piece(page, "code", "mono", shortKey(net.net)), piece(page, "span", "soft", netSaid(net, near)));
      one.append(top, bar(page, net.share, net.share >= 0.8 ? "warn" : "accent"));
      return one;
    }),
  );
};
