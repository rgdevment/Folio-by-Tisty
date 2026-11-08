import type { Attachment, Document } from "@tisty/contracts";
import { playableAs } from "@tisty/contracts/check";
import type { Bytes } from "../../core/bytes";
import { type EnvelopeRefusal, EnvelopeRefused } from "../../rules/envelope";
import { openFiles } from "../open";
import { keyIn } from "../read";
import { asking, type NotArrived, notArrived } from "./ask";
import { answeringProof } from "./solve";
import { said } from "./speak";

export interface FileAsking {
  id: string;
  linkKey: string;
  held: Document;
  caseToken?: string;
}

type Plays = NonNullable<ReturnType<typeof playableAs>>;

const SAVED_ADDRESS_LASTS_MS = 60_000;

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
    const { fileNotThere, fileCouldNotArrive } = said();
    throw new NotBrought(
      answer.refused === "missing" ? fileNotThere : (notArrived(answer.refused) ?? fileCouldNotArrive),
    );
  }
  const open = await openFiles(held, answer, { id, kind: "files" }, keyIn(linkKey));
  return open.opened;
};

const notOpened = (refusal: EnvelopeRefusal): string => {
  const why: Partial<Record<EnvelopeRefusal, string>> = said().fileRefused;
  return why[refusal] ?? said().fileCouldNotArrive;
};

const whyNot = (error: unknown): string => {
  if (error instanceof NotBrought) return error.message;
  if (error instanceof EnvelopeRefused) return notOpened(error.refusal);
  return said().fileCouldNotArrive;
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
const INERT_BY_NAME =
  /\.(pdf|png|jpe?g|gif|webp|avif|heic|bmp|txt|md|csv|tsv|mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4v|webm|mov|docx|xlsx|pptx|odt|ods|odp|epub)$/i;
const ZIPPED_BY_NAME = /\.(docx|xlsx|pptx|odt|ods|odp|epub)$/i;
const TRAILING = /[\s.]+$/;
const RUNS_BY_START = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x23, 0x21],
];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

const plainName = (name: string): string => name.replace(CONTROLS, "");

// By what it starts with too, since a name can say anything.
const startsWith = (bytes: Bytes, start: number[]): boolean => start.every((byte, at) => bytes[at] === byte);

export const mayRun = ({ name }: Pick<Attachment, "name">, bytes: Bytes): boolean => {
  const savedAs = plainName(name).replace(TRAILING, "");
  if (RUNS_BY_START.some((start) => startsWith(bytes, start))) return true;
  if (startsWith(bytes, ZIP)) return !ZIPPED_BY_NAME.test(savedAs);
  return !INERT_BY_NAME.test(savedAs);
};

const agreedToSave = (file: Pick<Attachment, "name">, bytes: Bytes): boolean =>
  !mayRun(file, bytes) || confirm(said().fileMayRun(plainName(file.name)));

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
  saidAloud(said().fileReady);
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
    told(link, said().fileAsking);
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
          told(link, said().fileCouldNotPlay);
        });
        return;
      }
      if (!agreedToSave(file, bytes)) {
        told(link, said().fileNotSaved);
        return;
      }
      saved(file, bytes);
      told(link, said().fileSaved);
    } catch (error) {
      told(link, whyNot(error));
    } finally {
      link.removeAttribute("aria-busy");
    }
  };
};
