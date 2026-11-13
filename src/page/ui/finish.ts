import type { Picture } from "@tisty/contracts";
import type { Bytes } from "../../core/bytes";
import { pictureHolds } from "../open";
import { bareUrl } from "./clean";
import { said } from "./speak";

const PICTURE = /^tisty:picture\/(\d+)$/;
const LEAVES = /^(https?|mailto):/i;
const FILE = /^tisty:file\/(\d+)$/i;

// One that does not hold has no address: it shows its alt, and the words still read.
export const pictureAddresses = (said: Picture[], bytes: Bytes[]): (string | null)[] =>
  said.map((picture, at) => {
    const held = bytes[at];
    if (!held || !pictureHolds(held, picture)) return null;
    return URL.createObjectURL(new Blob([held], { type: picture.kind }));
  });

const urlOf = (where: string): URL | null => {
  try {
    return new URL(where);
  } catch {
    return null;
  }
};

const hostOf = (where: string): string | null => urlOf(where)?.host ?? null;

const XHTML = "http://www.w3.org/1999/xhtml";

// A styled piece inside a link can hide words the reader never sees, so only bare words may name the address.
const bareWords = (link: Element): string => (link.children.length === 0 ? (link.textContent ?? "") : "");

const BARE_WWW = /^www\./;

// A word in another alphabet can look like the address and read the same once parsed, so it has to say it literally.
const saysItsHost = (said: string, host: string): boolean => {
  const text = said.trim().toLowerCase();
  const parsed = hostOf(text.includes("://") ? text : `https://${text}`);
  return (
    parsed !== null &&
    text.includes(host.replace(BARE_WWW, "")) &&
    parsed.replace(BARE_WWW, "") === host.replace(BARE_WWW, "")
  );
};

const whereItGoes = (where: string, said: string): string | null => {
  if (/^mailto:/i.test(where)) {
    const target = where.slice("mailto:".length);
    return said.trim().toLowerCase() === target.toLowerCase() ? null : target;
  }
  const url = urlOf(where);
  if (url === null || url.host === "") return null;
  if (url.username !== "" || url.password !== "") return url.host;
  return saysItsHost(said, url.host) ? null : url.host;
};

const STAMP = /^(\d{4})-(\d\d)-(\d\d)(?: ((?:[01]\d|2[0-3]):[0-5]\d))?$/;
const HOLDS = ["pin", "tape", "corner-left", "corner-right"];

const hashed = (text: string): number => {
  let h = 0x811c9dc5;
  for (const letter of text) h = Math.imul(h ^ (letter.codePointAt(0) ?? 0), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

const whenSaid = (when: string, lang: string): string | null => {
  const stamp = STAMP.exec(when);
  if (!stamp) return null;
  const [year, month, dayOfMonth] = stamp.slice(1, 4).map(Number) as [number, number, number];
  const on = new Date(0);
  on.setFullYear(year, month - 1, dayOfMonth);
  if (on.getMonth() !== month - 1 || on.getDate() !== dayOfMonth) return null;
  const date = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).format(on);
  return stamp[4] ? `${date} · ${stamp[4]}` : date;
};

// Tisty's own arithmetic, so a note leans and is held here as it is in the app.
const pin = (note: HTMLElement, lang: string): void => {
  const heading = note.dataset.when ?? note.textContent ?? "";
  const pick = (salt: number, range: number): number => hashed(`${salt}|${heading}#0`) % range;
  note.dataset.said = whenSaid(note.dataset.when ?? "", lang) ?? note.dataset.said;
  note.dataset.hold = HOLDS[pick(6, 4)];
  note.dataset.pin = String(pick(9, 4));
  note.style.setProperty("--tilt", `${(pick(1, 15) - 7) / 4}deg`);
  note.style.setProperty("--angle", `${pick(7, 31) - 15}deg`);
  note.style.setProperty("--along", `${pick(8, 61) + 20}%`);
};

const paragraphAlone = (image: Element): Element | null => {
  const paragraph = image.closest("p");
  if (!paragraph || paragraph.textContent?.trim()) return null;
  const others = [...paragraph.querySelectorAll("*")].filter((one) => !one.contains(image) && one.localName !== "br");
  return others.length === 0 ? paragraph : null;
};

export const finished = (words: DocumentFragment, addresses: (string | null)[]): DocumentFragment => {
  const { callouts } = said(words.ownerDocument);
  for (const callout of words.querySelectorAll<HTMLElement>("blockquote[data-callout]")) {
    const kind = callout.dataset.callout ?? "";
    callout.dataset.said = callouts[kind] ?? callouts.note ?? "";
    if (kind === "idea") pin(callout, words.ownerDocument.documentElement.lang);
  }
  for (const image of words.querySelectorAll("img")) {
    const at = PICTURE.exec(bareUrl(image.getAttribute("src") ?? ""))?.[1];
    const address = at === undefined ? null : addresses[Number(at)];
    if (address) image.setAttribute("src", address);
    else image.removeAttribute("src");
    paragraphAlone(image)?.toggleAttribute("data-alone", true);
  }
  for (const link of words.querySelectorAll("a[href]")) {
    const where = bareUrl(link.getAttribute("href") ?? "");
    if (LEAVES.test(where)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      const goes = whereItGoes(where, bareWords(link));
      if (goes) {
        const shown = link.ownerDocument.createElement("span");
        shown.className = "link-where";
        shown.textContent = ` (${goes})`;
        (link.namespaceURI === XHTML ? link : (link.closest("svg") ?? link)).after(shown);
      }
    } else if (FILE.test(where)) {
      // A press asks for it, and no address ever does: what follows the # is the link key.
      link.removeAttribute("href");
      link.setAttribute("data-file", FILE.exec(where)?.[1] ?? "");
      link.setAttribute("role", "button");
      link.setAttribute("tabindex", "0");
    }
  }
  return words;
};
