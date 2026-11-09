import { DAY_MS, type Limits } from "./limits";
import type { Version } from "./store";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// Replaced versions stay a while, so five clean uploads cannot erase what someone is about to report (decision 152).
export const keptVersions = (all: Version[], now: number, limits: Limits): Version[] =>
  all.filter((_, at) => {
    const replacedBy = all[at + 1];
    return (
      !replacedBy || at >= all.length - limits.versionsKept || now - replacedBy.at < limits.replacedKeptDays * DAY_MS
    );
  });

const streakOf = (versions: Version[], limits: Limits): number => {
  const resetsAfter = limits.uploadStreakResetMinutes * MINUTE_MS;
  let streak = 1;
  for (let at = versions.length - 1; at > 0; at -= 1) {
    if ((versions[at] as Version).at - (versions[at - 1] as Version).at >= resetsAfter) break;
    streak += 1;
  }
  return streak;
};

// Past its size nothing leaves until the oldest one that could leave has been replaced long enough.
export const listFreesAt = (versions: Version[], now: number, limits: Limits): number | null => {
  const next: Version = { n: 0, hash: "", bytes: 0, at: now, signer: "", machine: "", contract: "" };
  const kept = keptVersions([...versions, next], now, limits);
  if (kept.length <= limits.versionsListedAtMost) return null;
  const oldest = versions.indexOf(kept[0] as Version);
  return (versions[oldest + 1] as Version).at + limits.replacedKeptDays * DAY_MS;
};

// The document's, whoever signs, so more signers bring no more versions and it is known before any body is read.
export const waitEndsAt = (versions: Version[], now: number, limits: Limits): number => {
  const last = versions.at(-1);
  if (!last || now - last.at >= limits.uploadStreakResetMinutes * MINUTE_MS) return now;
  const waits = limits.uploadWaitsMinutes;
  const wait = waits[Math.min(streakOf(versions, limits) - 1, waits.length - 1)] ?? 0;
  return Math.max(last.at + wait * MINUTE_MS, now);
};

export const uploadAllowedAt = (versions: Version[], signer: string, now: number, limits: Limits): number => {
  const inTheHour = versions.filter((one) => one.signer === signer && now - one.at < HOUR_MS);
  const oldest = inTheHour[0];
  const afterTheHour = oldest && inTheHour.length >= limits.uploadsOfARootAnHour ? oldest.at + HOUR_MS : now;
  return Math.max(waitEndsAt(versions, now, limits), afterTheHour);
};
