export const PROVED = "proved";
export const PROVED_COLUMN = `${PROVED} INTEGER NOT NULL DEFAULT 0`;
// Not a network's digest, which is base64url, so the day's sum of new keys has its own row that the sweep clears too.
export const NEW_KEYS_NET = "~new-keys";

export const seenTable = (day: number): string => {
  if (!Number.isSafeInteger(day) || day < 0) throw new Error(`not a day: ${day}`);
  return `seen_${day}`;
};

export const addProvedTo = (table: string): string => `ALTER TABLE ${table} ADD COLUMN ${PROVED_COLUMN}`;

export interface SeenTable {
  table: string;
  proved: string;
}

// A day's table can be missing until its first reader, or older than the proof it now notes.
export const seenOf = async (db: D1Database, day: number): Promise<SeenTable | null> => {
  const table = seenTable(day);
  const found = await db
    .prepare(`SELECT instr(sql, '${PROVED}') > 0 AS proved FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(table)
    .first<{ proved: number }>();
  return found ? { table, proved: found.proved === 1 ? PROVED : "0" } : null;
};
