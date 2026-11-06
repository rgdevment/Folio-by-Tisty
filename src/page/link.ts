// Apart from what opens a document, since the page reads this before that code has arrived.
export const keyOfFragment = (fragment: string): string => fragment.split(".", 1)[0] ?? "";
