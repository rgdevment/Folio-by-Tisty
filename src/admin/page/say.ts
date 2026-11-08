import { DAY_MS } from "../../core/limits";

export const HOUR_MS = 3_600_000;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];

export type Tone = "ok" | "warn" | "danger" | "soft" | "accent";

export const piece = (page: Document, tag: string, className: string, said: string): HTMLElement => {
  const one = page.createElement(tag);
  one.className = className;
  one.textContent = said;
  return one;
};

export const button = (page: Document, said: string, press: () => void, danger = false): HTMLButtonElement => {
  const one = page.createElement("button");
  one.type = "button";
  one.textContent = said;
  if (danger) one.className = "is-danger";
  one.addEventListener("click", press);
  return one;
};

export const actions = (page: Document, ...buttons: HTMLElement[]): HTMLElement => {
  const row = page.createElement("div");
  row.className = "actions";
  row.append(...buttons);
  return row;
};

export const more = (page: Document, ...buttons: HTMLButtonElement[]): HTMLElement[] => {
  if (buttons.length === 0) return [];
  const folded = page.createElement("details");
  folded.className = "more";
  const said = page.createElement("summary");
  said.textContent = "Más";
  const list = page.createElement("div");
  list.className = "more-list";
  list.append(...buttons);
  folded.append(said, list);
  return [folded];
};

export const bar = (page: Document, share: number, tone: Tone, marks: number[] = []): HTMLElement => {
  const track = page.createElement("div");
  track.className = "bar";
  const fill = page.createElement("div");
  fill.className = `bar-fill is-${tone}`;
  fill.style.width = `${Math.min(100, Math.max(0, share * 100)).toFixed(1)}%`;
  track.append(fill);
  for (const mark of marks) {
    const line = page.createElement("div");
    line.className = "bar-mark";
    line.style.left = `${Math.min(100, Math.max(0, mark * 100)).toFixed(1)}%`;
    track.append(line);
  }
  return track;
};

export const count = (n: number): string => n.toLocaleString("es-CL");

export const decimal = (n: number, digits = 1): string =>
  n.toLocaleString("es-CL", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const megabytes = (bytes: number): string => `${decimal(bytes / 1e6)} MB`;

export const gigabytes = (bytes: number): string => `${decimal(bytes / 1e9)} GB`;

export const dayText = (day: number): string => {
  const date = new Date(day * DAY_MS);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

export const shortDay = (day: number): string => {
  const date = new Date(day * DAY_MS);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};

export const isoDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

export const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });

export const hourClock = (hour: number): string => clock(hour * HOUR_MS);

export const ago = (ms: number, now: number): string => {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "recién";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor((now - ms) / DAY_MS);
  return days === 1 ? "ayer" : shortDay(Math.floor(ms / DAY_MS));
};

export const when = (ms: number, now: number): string => {
  const day = Math.floor(ms / DAY_MS);
  const today = Math.floor(now / DAY_MS);
  if (day === today) return `hoy ${clock(ms)}`;
  if (day === today - 1) return `ayer ${clock(ms)}`;
  return `${shortDay(day)} ${clock(ms)}`;
};

export const daysText = (days: number): string => (days === 1 ? "1 día" : `${count(days)} días`);

export const shortKey = (root: string): string => `${root.slice(0, 4)}…${root.slice(-3)}`;

export const todayOf = (now: number): number => Math.floor(now / DAY_MS);

export const cell = (page: Document, said: string, className = ""): HTMLTableCellElement => {
  const one = page.createElement("td");
  if (className) one.className = className;
  one.textContent = said;
  return one;
};
