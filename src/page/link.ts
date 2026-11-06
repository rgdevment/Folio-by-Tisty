// Apart from what opens a document, since the page reads this before that code has arrived.
export const keyOfFragment = (fragment: string): string => fragment.split(".", 1)[0] ?? "";

export const readingLink = ({ origin, pathname, hash }: { origin: string; pathname: string; hash: string }): string => {
  const key = keyOfFragment(hash.slice(1));
  return `${origin}${pathname}${key === "" ? "" : `#${key}`}`;
};
