export const HELD_BYTES = "json_extract(d.versions, '$[#-1].bytes') + d.files_bytes";

// A language lives by its anchor, so its own days passing does not stop it being served.
export const SERVED = (
  today: string,
): string => `(d.dies_on >= ${today} OR (d.anchor IS NOT NULL AND d.paused_at IS NULL
  AND EXISTS (SELECT 1 FROM docs a WHERE a.id = d.anchor AND a.latest >= 0 AND a.blocked_at IS NULL
    AND a.paused_at IS NULL AND a.dies_on >= ${today})))`;

// What a key holds: the latest version of what it still shares, as uploads count it.
export const HOLDS_ROOM = (today: string): string => `d.latest >= 0 AND d.blocked_at IS NULL AND ${SERVED(today)}`;
