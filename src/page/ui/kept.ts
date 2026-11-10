// A browser that keeps nothing still reads: the choice just lasts until the page is closed.
export const keep = (change: (kept: Storage) => void): void => {
  try {
    change(localStorage);
  } catch {}
};
