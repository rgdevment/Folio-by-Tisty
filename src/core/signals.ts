import { LEVEL_ONE, type Limits, type ReportLevel } from "./limits";

export interface DayReading {
  nets: number;
  proved: number;
  hours: number;
  peak: number;
}

export interface Watched {
  today: DayReading;
  yesterday: DayReading | null;
  ownerRows: number;
  liveDays: number;
  mostNetsADay: number | null;
  byUploader: boolean;
  uploader: { keys: number; docs: number } | null;
  editsADay: number;
  report: ReportLevel | null;
}

export type Signal =
  | { kind: "cap" }
  | { kind: "proved" }
  | { kind: "even" }
  | { kind: "lone"; days: number; byUploader: boolean }
  | { kind: "keys"; keys: number; docs: number }
  | { kind: "edits"; edits: number }
  | { kind: "report"; level: ReportLevel };

export const LONE_AFTER_DAYS = 30;
export const EVEN_HOURS_AT_LEAST = 20;
export const EVEN_NETS_AT_LEAST = 100;
export const EDITS_A_DAY_AT_MOST = 20;
const EVEN_PEAK_OVER_MEAN = 2;

const mostlyProved = ({ nets, proved }: DayReading): boolean => proved * 2 > nets;

// People sleep and a group reads in a few hours; a script reads about the same every hour of the day.
const evenAllDay = (day: DayReading | null): boolean =>
  day !== null &&
  day.hours >= EVEN_HOURS_AT_LEAST &&
  day.nets >= EVEN_NETS_AT_LEAST &&
  day.peak * day.hours <= EVEN_PEAK_OVER_MEAN * day.nets;

const keptAliveAlone = ({ liveDays, mostNetsADay, today }: Watched): boolean =>
  liveDays > LONE_AFTER_DAYS && mostNetsADay !== null && Math.max(mostNetsADay, today.nets) <= 1;

// The ceiling is the owner's, so only a document that alone went past the free readers is named for it.
const reachedTheCeiling = ({ ownerRows, today }: Watched, limits: Limits): boolean =>
  ownerRows >= limits.rowsPerOwnerADay && today.nets > limits.newReadersFree;

export const signalsOf = (watched: Watched, limits: Limits = LEVEL_ONE): Signal[] => {
  const { today, yesterday, uploader, report } = watched;
  return [
    ...(reachedTheCeiling(watched, limits) ? [{ kind: "cap" } as const] : []),
    ...(mostlyProved(today) ? [{ kind: "proved" } as const] : []),
    ...(evenAllDay(today) || evenAllDay(yesterday) ? [{ kind: "even" } as const] : []),
    ...(keptAliveAlone(watched)
      ? [{ kind: "lone", days: watched.liveDays, byUploader: watched.byUploader } as const]
      : []),
    ...(uploader && uploader.keys >= limits.newKeysADay
      ? [{ kind: "keys", keys: uploader.keys, docs: uploader.docs } as const]
      : []),
    ...(watched.editsADay > EDITS_A_DAY_AT_MOST ? [{ kind: "edits", edits: watched.editsADay } as const] : []),
    ...(report ? [{ kind: "report", level: report } as const] : []),
  ];
};
