import type { KeyDoc, KeyView } from "../../core/dashboard";
import { LEVEL_ONE } from "../../core/limits";
import {
  actions,
  bar,
  button,
  count,
  daysText,
  dayText,
  HOUR_MS,
  megabytes,
  piece,
  shortDay,
  todayOf,
  when,
} from "./say";

export interface Keying {
  blockKey: (root: string) => void;
  unblockKey: (root: string) => void;
  exportKey: (root: string) => void;
  forgetKey: (root: string) => void;
}

const firstSaid = ({ firstDay }: KeyView, today: number): string => {
  if (firstDay === null) return "sin registro";
  const left = LEVEL_ONE.daysAKeyIsNew - (today - firstDay);
  return left > 0 ? `${dayText(firstDay)} · nueva por ${daysText(left)} más` : dayText(firstDay);
};

const termsSaid = ({ termsVersion, termsHour }: KeyView, now: number): string => {
  if (termsVersion === null) return "sin aceptar";
  return termsHour === null ? `v${termsVersion}` : `v${termsVersion}, aceptados ${when(termsHour * HOUR_MS, now)}`;
};

const docState = (doc: KeyDoc, today: number): string => {
  if (doc.blockedAt !== null) return "bloqueado";
  if (doc.legalUntil !== null && doc.legalUntil >= today) return "retenido";
  if (!doc.alive) return "caducado";
  return doc.pausedAt === null ? "abierto" : "en pausa";
};

const docList = (page: Document, view: KeyView, today: number): HTMLElement => {
  const list = page.createElement("ul");
  list.className = "key-docs";
  list.hidden = true;
  if (view.listed.length === 0) list.append(piece(page, "li", "soft", "No le queda ningún documento."));
  for (const doc of view.listed) {
    const one = page.createElement("li");
    one.append(
      piece(page, "code", "mono", doc.id),
      ` · ${doc.anchor ? `idioma de ${doc.anchor} · ` : ""}v${doc.latest} · ${megabytes(doc.bytes)} · ${docState(doc, today)} · caduca ${shortDay(doc.diesOn)}`,
    );
    list.append(one);
  }
  return list;
};

const fact = (page: Document, term: string, said: string): HTMLElement[] => [
  piece(page, "dt", "", term),
  piece(page, "dd", "", said),
];

export const drawKey = (page: Document, place: HTMLElement, view: KeyView, now: number, keying: Keying): void => {
  const today = todayOf(now);
  const facts = page.createElement("dl");
  facts.append(
    ...fact(page, "Primera vez", firstSaid(view, today)),
    ...fact(page, "Términos", termsSaid(view, now)),
    ...fact(
      page,
      "Guarda",
      `${megabytes(view.holds)} de ${megabytes(view.holdsAtMost)} en ${count(view.docs.open)} documentos abiertos`,
    ),
    ...fact(
      page,
      "Documentos",
      `${count(view.docs.open)} abiertos · ${count(view.docs.expired)} caducados · ${count(view.docs.blocked)} bloqueados`,
    ),
    ...fact(page, "Versiones", `${count(view.versions)} en sus documentos · ${count(view.asEditor)} como editora`),
    ...fact(
      page,
      "Denuncias",
      `${view.reports.grave} graves · ${view.reports.medium} de engaño · ${view.reports.light} leves`,
    ),
    ...(view.blockedAt === null ? [] : fact(page, "Bloqueada", dayText(view.blockedAt))),
  );
  const share = view.holds / view.holdsAtMost;
  const docs = docList(page, view, today);
  const seeing = button(page, "Ver documentos", () => {
    docs.hidden = !docs.hidden;
    seeing.textContent = docs.hidden ? "Ver documentos" : "Ocultar documentos";
  });
  place.replaceChildren(
    piece(page, "code", "sealed", view.root),
    facts,
    bar(page, share, share >= 0.9 ? "warn" : "accent"),
    actions(
      page,
      seeing,
      button(page, "Exportar para autoridad", () => keying.exportKey(view.root)),
      view.blockedAt === null
        ? button(page, "Bloquear llave", () => keying.blockKey(view.root), true)
        : button(page, "Desbloquear llave", () => keying.unblockKey(view.root)),
      button(page, "Borrar a pedido del titular", () => keying.forgetKey(view.root), true),
    ),
    docs,
  );
};
