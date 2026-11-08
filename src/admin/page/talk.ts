// A session of Access that ended redirects to its login, and the browser refuses that: the fetch rejects.
const answered = async (asking: () => Promise<Response>): Promise<Response | null> => {
  try {
    return await asking();
  } catch {
    return null;
  }
};

export const fetchedAt = (path: string): Promise<Response | null> =>
  answered(() => fetch(path, { credentials: "same-origin", cache: "no-store" }));

export const fetched = (path: string): Promise<Response | null> => fetchedAt(`/api/${path}`);

export const sent = (path: string, body?: unknown): Promise<Response | null> =>
  answered(() =>
    fetch(`/api/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Folio-Operator": "1", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

export const asked = async (path: string, note?: string): Promise<boolean> =>
  (await sent(path, note === undefined ? undefined : { note }))?.ok ?? false;
