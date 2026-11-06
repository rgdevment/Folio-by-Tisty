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
