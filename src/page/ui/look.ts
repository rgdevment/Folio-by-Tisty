import type { Document } from "@tisty/contracts";
import { element } from "./element";

export const wear = (sheet: HTMLElement, held: Document): Promise<unknown> | undefined => {
  const said: Record<string, unknown> = { ...held.sheet?.own, design: held.sheet?.design };
  for (const [part, list = ""] of Object.entries(element("looks").dataset)) {
    const names = list.split(" ");
    sheet.dataset[part] = names.find((one) => one === said[part]) ?? names[0];
  }
  const { design, font } = sheet.dataset;
  if (design !== "own" || font === "sans") return undefined;
  const face = `1em own-${font}`;
  const words = JSON.stringify(held);
  return document.fonts.check(face, words) ? undefined : document.fonts.load(face, words).catch(() => {});
};
