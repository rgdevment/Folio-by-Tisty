import { ALLOWED, PASSTHROUGH, STYLES, URLS } from "@tisty/contracts/check";
import createDOMPurify, { type Config, type UponSanitizeAttributeHookEvent } from "dompurify";

export interface HtmlCleaner {
  clean(html: string): DocumentFragment;
}

type StyleRule = (typeof STYLES)[number];

const own = <T>(held: Record<string, T>, name: string): T | undefined =>
  Object.hasOwn(held, name) ? held[name] : undefined;

const ATTRIBUTES = [
  ...new Set([
    ...Object.values(ALLOWED).flatMap((one) => one.attributes),
    ...Object.values(PASSTHROUGH.attributes).flat(),
  ]),
];

const CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: [...Object.keys(ALLOWED), ...PASSTHROUGH.tags],
  ALLOWED_ATTR: ATTRIBUTES,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP: new RegExp(`^(?:#|(?:${URLS.schemes.join("|")}):)`, "i"),
  // Only what is an address is read as one: a width or a colour has no scheme to look at.
  ADD_URI_SAFE_ATTR: ATTRIBUTES.filter((one) => !URLS.attributes.includes(one)),
  // A heading called "title" keeps its id: inside a shadow root it cannot reach the document's names.
  SANITIZE_DOM: false,
  RETURN_DOM_FRAGMENT: true,
};

// As a browser reads an address: spaces and control characters do not hide a scheme from it.
export const bareUrl = (said: string): string => [...said].filter((one) => one > " ").join("");

const REFERENCE = new RegExp(`^(?:${URLS.references.join("|")})/(?:0|[1-9][0-9]{0,14})$`);

const attributeHolds = (tag: string, name: string): boolean =>
  own(ALLOWED, tag)?.attributes.includes(name) ||
  PASSTHROUGH.attributes["*"]?.includes(name) ||
  own(PASSTHROUGH.attributes, tag)?.includes(name) ||
  false;

const classesKept = (tag: string, said: string): string => {
  const rule = own(ALLOWED, tag);
  if (!rule) return "";
  const known = (one: string): boolean =>
    rule.classes.includes(one) ||
    rule.class_starts.some((start) => one.startsWith(start)) ||
    rule.class_ends.some((end) => one.endsWith(end));
  return said
    .split(/[\t\n\f\r ]+/)
    .filter(known)
    .join(" ");
};

const urlHolds = (said: string): boolean => {
  const url = bareUrl(said);
  if (url.startsWith("#")) return true;
  const colon = url.indexOf(":");
  const scheme = url.slice(0, Math.max(colon, 0)).toLowerCase();
  if (scheme === "tisty") return REFERENCE.test(url.slice(colon + 1));
  return URLS.schemes.includes(scheme);
};

const paintHolds = (said: string): boolean => {
  const paint = said.trim().toLowerCase();
  if (paint.includes("&") || paint.includes("\\")) return false;
  return !paint.includes("url(") || /^url\(#[^\s()]+\)$/.test(paint);
};

const sized = (said: string, units: string[]): boolean =>
  /^-?0*\.?0+$/.test(said) ||
  units.some((unit) => said.endsWith(unit) && /^-?\d*\.?\d+$/.test(said.slice(0, -unit.length)));

const styleHolds = ({ unit, sizes, color, values }: StyleRule, said: string): boolean => {
  if (unit) return said.endsWith(unit) && /^\d+(\.\d+)?$/.test(said.slice(0, -unit.length));
  if (sizes) return sized(said, sizes);
  if (color) return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(said);
  return values?.includes(said) ?? false;
};

const keepsAttribute = (node: Element, event: UponSanitizeAttributeHookEvent, styled: Map<Element, string>): void => {
  const tag = node.nodeName.toLowerCase();
  const { attrName: name, attrValue: said } = event;
  if (!attributeHolds(tag, name)) event.keepAttr = false;
  else if (name === "class") event.attrValue = classesKept(tag, said);
  else if (URLS.attributes.includes(name)) event.keepAttr = urlHolds(said);
  else if (URLS.paints.includes(name)) event.keepAttr = paintHolds(said);
  else if (name === "style") {
    // The page's CSP refuses a style attribute, so what the contract lets through is set by hand afterwards.
    styled.set(node, said);
    event.keepAttr = false;
  }
};

const applyStyles = (node: Element, said: string): void => {
  const tag = node.nodeName.toLowerCase();
  for (const one of said.split(";")) {
    const colon = one.indexOf(":");
    const property = one.slice(0, Math.max(colon, 0)).trim().toLowerCase();
    const value = one
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (STYLES.some((rule) => rule.on === tag && rule.property === property && styleHolds(rule, value))) {
      (node as HTMLElement).style?.setProperty(property, value);
    }
  }
};

// The second layer (decision 112): it runs on what the contract already took, for where a browser reads it otherwise.
export const domPurifyCleaner = (place: Window & typeof globalThis): HtmlCleaner => {
  const purify = createDOMPurify(place);
  if (!purify.isSupported) throw new Error("this browser cannot clean a document");
  return {
    clean(html) {
      const styled = new Map<Element, string>();
      purify.addHook("uponSanitizeAttribute", (node, event) => keepsAttribute(node, event, styled));
      try {
        const words = place.document.adoptNode(purify.sanitize(html, CONFIG));
        for (const [node, said] of styled) applyStyles(node, said);
        return words;
      } finally {
        purify.removeAllHooks();
      }
    },
  };
};
