export const HELD_BYTES = "json_extract(d.versions, '$[#-1].bytes') + d.files_bytes";

// What a key holds: the latest version of what it still shares, as uploads count it.
export const HOLDS_ROOM = (today: string): string => `d.latest >= 0 AND d.dies_on >= ${today} AND d.blocked_at IS NULL`;
