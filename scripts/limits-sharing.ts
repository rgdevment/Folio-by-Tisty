const NOTE_LANGUAGES = new Set(["es", "en"]);
const NOTE_CHARACTERS_AT_MOST = 400;
const NOTE_LINES_AT_MOST = 6;
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const LINK = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;
const LINK_ADDRESS = /^https:\/\/([a-z0-9.-]+)(?:[/?#][^\s\\()]*)?$/;
const FORMATTED =
  /\*\*|__|~~|`|\*[^*\n]+\*|(?:^|\s)_[^_\n]+_(?:\s|$)|<\/?[a-z]|^#{1,6}\s|^\s*>\s|^\s*(?:[-*+]|\d+\.)\s/im;
const ROOT = /^[A-Za-z0-9_-]{43}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const LINE_TISTY_ADDS = /(?:conoce más en|learn more at) folio\.tisty\.app/i;

const isLinkHost = (host: string): boolean =>
  host === "tisty.cl" || host === "tisty.app" || host.endsWith(".tisty.app");

const linkFaults = (text: string): string[] =>
  [...text.matchAll(LINK)].flatMap(([, label, address]) => {
    const host = LINK_ADDRESS.exec(address ?? "")?.[1];
    if (!label?.trim()) return [`has a link with no text: ${address}`];
    return host && isLinkHost(host) ? [] : [`links where Tisty would not: ${address}`];
  });

const textFaults = (text: string): string[] => {
  const shown = text.replace(LINK, "$1");
  return [
    ...(text.trim() === "" ? ["is empty"] : []),
    ...(text.length > NOTE_CHARACTERS_AT_MOST
      ? [`is ${text.length} characters, of ${NOTE_CHARACTERS_AT_MOST} at most`]
      : []),
    ...(text.split("\n").length > NOTE_LINES_AT_MOST ? [`is over ${NOTE_LINES_AT_MOST} lines`] : []),
    ...(UNSEEN.test(text.replaceAll("\n", "")) ? ["has a tab, a control character or an invisible one"] : []),
    ...linkFaults(text),
    ...(shown.includes("](") ? ["has a link that is not whole"] : []),
    ...(FORMATTED.test(shown) || text.includes("![") ? ["has formatting Tisty would show literally"] : []),
    ...(LINE_TISTY_ADDS.test(shown) ? ["repeats the line Tisty adds below it"] : []),
  ];
};

const noteFaults = (note: unknown): string[] => {
  if (typeof note !== "object" || note === null || Array.isArray(note)) return ["is not an object"];
  const said = Object.entries(note);
  if (said.length === 0) return ["says nothing, so it belongs out of the file"];
  return said.flatMap(([language, text]) => {
    if (!NOTE_LANGUAGES.has(language)) return [`has a language Tisty does not read: ${language}`];
    if (typeof text !== "string") return [`${language} is not text`];
    return textFaults(text).map((fault) => `${language} ${fault}`);
  });
};

// Tisty drops a language whose message breaks these, so a bad one is stopped here, before anyone signs it.
export const sharingFaults = ({
  sharing_open: open,
  sharing_closed_note: note,
  maker_root: maker,
  maker_name: name,
}: Record<string, unknown>): string[] => [
  ...(typeof open === "boolean" ? [] : ["sharing_open is not true or false"]),
  ...(maker === undefined || (typeof maker === "string" && ROOT.test(maker)) ? [] : ["maker_root is not a root"]),
  ...(name === undefined || (typeof name === "string" && NAME.test(name)) ? [] : ["maker_name is not a name"]),
  ...(name !== undefined && maker === undefined ? ["maker_name names no maker_root"] : []),
  ...(note === undefined ? [] : noteFaults(note).map((fault) => `sharing_closed_note ${fault}`)),
];
