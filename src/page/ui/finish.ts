import type { Picture } from "@tisty/contracts";
import type { Bytes } from "../../core/bytes";
import { pictureHolds } from "../open";
import { bareUrl } from "./clean";

const PICTURE = /^tisty:picture\/(\d+)$/;
const LEAVES = /^(https?|mailto):/i;
const FILE = /^tisty:file\/(\d+)$/i;
const CALLOUTS: Record<string, string> = {
  note: "Nota",
  tip: "Consejo",
  important: "Importante",
  warning: "Aviso",
  caution: "Cuidado",
};

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
    const address = where.slice("mailto:".length).split("?", 1)[0] ?? "";
    return said.trim().toLowerCase() === address.toLowerCase() ? null : address;
  }
  const url = urlOf(where);
  if (url === null || url.host === "") return null;
  if (url.username !== "" || url.password !== "") return url.host;
  return saysItsHost(said, url.host) ? null : url.host;
};

export const finished = (words: DocumentFragment, addresses: (string | null)[]): DocumentFragment => {
  for (const callout of words.querySelectorAll("blockquote[data-callout]")) {
    callout.setAttribute("data-said", CALLOUTS[callout.getAttribute("data-callout") ?? ""] ?? CALLOUTS.note ?? "");
  }
  for (const image of words.querySelectorAll("img")) {
    const at = PICTURE.exec(bareUrl(image.getAttribute("src") ?? ""))?.[1];
    const address = at === undefined ? null : addresses[Number(at)];
    if (address) image.setAttribute("src", address);
    else image.removeAttribute("src");
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
