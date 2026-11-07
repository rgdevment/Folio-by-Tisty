import type { Attachment, Document } from "@tisty/contracts";
import { playableAs } from "@tisty/contracts/check";
import type { Bytes } from "../../core/bytes";
import { type EnvelopeRefusal, EnvelopeRefused } from "../../rules/envelope";
import { openFiles } from "../open";
import { keyIn } from "../read";
import { asking, NOT_ARRIVED, type NotArrived } from "./ask";
import { answeringProof } from "./solve";

export interface FileAsking {
  id: string;
  linkKey: string;
  held: Document;
  caseToken?: string;
}

type Plays = NonNullable<ReturnType<typeof playableAs>>;

const SAVED_ADDRESS_LASTS_MS = 60_000;
const ASKING = "Trayendo el adjunto…";
const SAVED = "Guardando. Si no empieza, presiona otra vez.";
const READY = "Listo para reproducir.";
const COULD_NOT_PLAY = "No se puede reproducir aquí. Presiona para guardarlo.";
const COULD_NOT_ARRIVE = "No se pudo traer el adjunto. Vuelve a intentarlo en un momento.";
const NOT_THERE = "El adjunto no está. Recarga la página para volver a intentarlo.";
const NOT_OPENED: Partial<Record<EnvelopeRefusal, string>> = {
  newer: "Este adjunto se escribió con una versión más nueva de la que esta página sabe leer.",
  damaged: "Este adjunto llegó dañado, así que no se guarda.",
  unsigned: "La firma de este adjunto no vale, así que no se guarda.",
};

const PAGE_NAME = /\.x?html?[\s.]*$/i;
const PAGE_KIND = /^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i;

class NotBrought extends Error {}

const saysItIsAPage = ({ kind, name }: Attachment): boolean => PAGE_KIND.test(kind ?? "") || PAGE_NAME.test(name);

export const playerFor = (file: Attachment, bytes: Bytes): Plays | null =>
  saysItIsAPage(file) ? null : playableAs(bytes);

const asked = async (id: string, hash: string, proof?: string, caseToken?: string): Promise<Bytes | NotArrived> => {
  const place = caseToken === undefined ? "docs" : "cases";
  const response = await asking(`/api/v1/${place}/${id}/files/${hash}`, proof, caseToken);
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : ((await response.json()) as NotArrived);
};

const bytesOfFiles = async ({ id, linkKey, held, caseToken }: FileAsking): Promise<Bytes[]> => {
  const hash = held.files_hash as string;
  const answer = await answeringProof(await asked(id, hash, undefined, caseToken), (proof) =>
    asked(id, hash, proof, caseToken),
  );
  if ("refused" in answer) {
    throw new NotBrought(answer.refused === "missing" ? NOT_THERE : (NOT_ARRIVED[answer.refused] ?? COULD_NOT_ARRIVE));
  }
  const open = await openFiles(held, answer, { id, kind: "files" }, keyIn(linkKey));
  return open.opened;
};

const whyNot = (error: unknown): string => {
  if (error instanceof NotBrought) return error.message;
  if (error instanceof EnvelopeRefused) return NOT_OPENED[error.refusal] ?? COULD_NOT_ARRIVE;
  return COULD_NOT_ARRIVE;
};

const saidAloud = (said: string): void => {
  const status = document.getElementById("file-said");
  if (status) status.textContent = said;
};

const told = (link: HTMLElement, said: string): void => {
  saidAloud(said);
  link.setAttribute("title", said);
  const blurb = link.querySelector(".card-blurb");
  if (blurb) {
    blurb.textContent = said;
    return;
  }
  const next = link.nextElementSibling;
  const note = next?.classList.contains("file-said") ? next : link.ownerDocument.createElement("span");
  note.className = "file-said";
  note.textContent = said;
  link.after(note);
};

const CONTROLS = /\p{C}/gu;
const MAY_RUN_BY_NAME =
  /\.(exe|msi|msp|msix|msixbundle|appx|appxbundle|application|bat|cmd|com|scr|pif|cpl|dll|msc|ps1|psm1|ps1xml|psc1|vb|vbs|vbe|js|jse|ws|wsf|wsh|hta|lnk|url|website|scf|inf|reg|chm|gadget|jar|apk|appimage|deb|rpm|dmg|pkg|app|command|sh|iso|img|vhdx?|html?|xhtml|mht|mhtml|svg|docm|dotm|xlsm|xltm|xlam|xll|pptm|potm|ppsm|ppam|sldm)[\s.]*$/i;
const MAY_RUN_BY_START = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x23, 0x21],
];
const NOT_SAVED = "No se descargó.";

const plainName = (name: string): string => name.replace(CONTROLS, "");

// By what it starts with too, since a name can say anything.
export const mayRun = ({ name }: Pick<Attachment, "name">, bytes: Bytes): boolean =>
  MAY_RUN_BY_NAME.test(plainName(name)) ||
  MAY_RUN_BY_START.some((start) => start.every((byte, at) => bytes[at] === byte));

const agreedToSave = (file: Pick<Attachment, "name">, bytes: Bytes): boolean =>
  !mayRun(file, bytes) ||
  confirm(
    `«${plainName(file.name)}» puede ser un programa. Folio no revisa lo que se comparte, y abrirlo podría dañar tu equipo. ¿Descargarlo de todos modos?`,
  );

export const saved = ({ name }: Pick<Attachment, "name">, bytes: Bytes): void => {
  const address = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const saving = document.createElement("a");
  saving.href = address;
  saving.download = plainName(name);
  saving.click();
  setTimeout(() => URL.revokeObjectURL(address), SAVED_ADDRESS_LASTS_MS);
};

const playerOf = (link: HTMLElement, { name }: Attachment, { player: kind, type }: Plays): HTMLMediaElement | null => {
  const player = link.ownerDocument.createElement(kind);
  if (player.canPlayType(type) === "") return null;
  player.className = "file-player";
  player.controls = true;
  player.preload = "metadata";
  player.tabIndex = 0;
  player.setAttribute("aria-label", name);
  return player;
};

const placed = (link: HTMLElement, player: HTMLMediaElement, address: string, onFailure: () => void): void => {
  player.addEventListener(
    "error",
    () => {
      player.replaceWith(link);
      onFailure();
      link.focus({ preventScroll: true });
    },
    { once: true },
  );
  player.src = address;
  link.replaceWith(player);
  player.focus({ preventScroll: true });
  saidAloud(READY);
};

export const filePresser = (asking: FileAsking) => {
  let opening: Promise<Bytes[]> | undefined;
  const opened = (): Promise<Bytes[]> => {
    opening ??= bytesOfFiles(asking).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };
  const couldNotPlay = new Set<number>();
  const addresses = new Map<number, string>();
  const addressOf = (at: number, bytes: Bytes, { type }: Plays): string => {
    const address = addresses.get(at) ?? URL.createObjectURL(new Blob([bytes], { type }));
    addresses.set(at, address);
    return address;
  };

  return async (link: HTMLElement): Promise<void> => {
    const file = asking.held.files?.find((one) => one.at === Number(link.getAttribute("data-file")));
    if (!file || link.getAttribute("aria-busy") === "true") return;
    link.setAttribute("aria-busy", "true");
    told(link, ASKING);
    try {
      const bytes = (await opened())[file.at] as Bytes;
      const plays = playerFor(file, bytes);
      const standsAlone = link.classList.contains("doc-card");
      const player = plays && standsAlone && !couldNotPlay.has(file.at) ? playerOf(link, file, plays) : null;
      if (plays && player) {
        const address = addressOf(file.at, bytes, plays);
        placed(link, player, address, () => {
          URL.revokeObjectURL(address);
          addresses.delete(file.at);
          couldNotPlay.add(file.at);
          told(link, COULD_NOT_PLAY);
        });
        return;
      }
      if (!agreedToSave(file, bytes)) {
        told(link, NOT_SAVED);
        return;
      }
      saved(file, bytes);
      told(link, SAVED);
    } catch (error) {
      told(link, whyNot(error));
    } finally {
      link.removeAttribute("aria-busy");
    }
  };
};
