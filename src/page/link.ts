// Apart from what opens a document, since the page reads this before that code has arrived.
export const keyOfFragment = (fragment: string): string => fragment.split(".", 1)[0] ?? "";

export interface CaseLink {
  token: string;
  recordsKey?: string;
}

export const caseOfFragment = (fragment: string): CaseLink | null => {
  const [word, token, recordsKey] = fragment.split(".");
  if (word !== "caso" || !token) return null;
  return { token, ...(recordsKey ? { recordsKey } : {}) };
};
