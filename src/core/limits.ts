export interface Limits {
  ttlChoices: number[];
  sharesAtMost: number;
  versionsKept: number;
  replacedKeptDays: number;
  versionsListedAtMost: number;
  envelopeBytesAtMost: number;
  picturesAtMost: number;
  pictureBytesAtMost: number;
  picturesBytesAtMost: number;
  firstBytesAtMost: number;
  restBytesAtMost: number;
  filesAtMost: number;
  filesBytesAtMost: number;
  uploadsAnHour: number;
  revocationsAnHour: number;
  revocationsAtOnce: number;
  uploadsOfARootAnHour: number;
  uploadWaitsMinutes: number[];
  uploadStreakResetMinutes: number;
  oldestContractTaken: string | null;
  oldestContractServed: string | null;
  newReadersFree: number;
  rowsPerOwnerADay: number;
  netDocsADay: number;
  netBytesADay: number;
  reportsAnHour: number;
  reportDetailAtMost: number;
  sealedLinkAtMost: number;
  pausedDays: number;
  evidenceDays: number;
  reportsToBlock: number;
  reportOperatorsToBlock: number;
  lightReportsToWarn: number;
  lightFixDays: number;
  sweptAtOnce: number;
  historyDays: number;
  hoursFromReaders: number;
  proofBits: number;
}

// Level 1 (decisions 36, 41, 42, 49, 93 bis, 97, 116, 128 and 136). What Tisty reads of them is signed in docs/limits.json (decision 120).
export const LEVEL_ONE: Limits = {
  ttlChoices: [1, 3, 7, 15],
  sharesAtMost: 2,
  versionsKept: 3,
  replacedKeptDays: 7,
  versionsListedAtMost: 300,
  envelopeBytesAtMost: 24_000_000,
  picturesAtMost: 10,
  pictureBytesAtMost: 1_000_000,
  picturesBytesAtMost: 5_000_000,
  firstBytesAtMost: 2_512_000,
  restBytesAtMost: 15_572_000,
  filesAtMost: 2,
  filesBytesAtMost: 5_000_000,
  uploadsAnHour: 60,
  revocationsAnHour: 30,
  revocationsAtOnce: 8,
  uploadsOfARootAnHour: 10,
  uploadWaitsMinutes: [1, 1, 1, 2, 4, 8, 15],
  uploadStreakResetMinutes: 30,
  oldestContractTaken: null,
  oldestContractServed: null,
  newReadersFree: 250,
  rowsPerOwnerADay: 5000,
  netDocsADay: 50,
  netBytesADay: 200 * 1000 * 1000,
  reportsAnHour: 10,
  reportDetailAtMost: 2000,
  sealedLinkAtMost: 1024,
  pausedDays: 30,
  evidenceDays: 180,
  reportsToBlock: 3,
  reportOperatorsToBlock: 2,
  lightReportsToWarn: 3,
  lightFixDays: 3,
  sweptAtOnce: 500,
  historyDays: 90,
  hoursFromReaders: 5,
  proofBits: 16,
};

// What Tisty reads to warn before sharing (decision 120). The server holds to the same numbers whoever calls it.
export const publishedLimits = (limits: Limits) => ({
  ttl_days: limits.ttlChoices,
  shares_at_most: limits.sharesAtMost,
  envelope_bytes_at_most: limits.envelopeBytesAtMost,
  first_bytes_at_most: limits.firstBytesAtMost,
  rest_bytes_at_most: limits.restBytesAtMost,
  pictures_at_most: limits.picturesAtMost,
  picture_bytes_at_most: limits.pictureBytesAtMost,
  pictures_bytes_at_most: limits.picturesBytesAtMost,
  files_at_most: limits.filesAtMost,
  files_bytes_at_most: limits.filesBytesAtMost,
  uploads_of_a_root_an_hour: limits.uploadsOfARootAnHour,
  upload_waits_minutes: limits.uploadWaitsMinutes,
  oldest_contract_taken: limits.oldestContractTaken,
  oldest_contract_served: limits.oldestContractServed,
});

export type ReportLevel = "light" | "medium" | "grave";

// What anyone can report (decisions 38 and 153). Copyright is not here: its holder asks, and it comes down with no evidence.
const REPORT_LEVELS: Readonly<Record<string, ReportLevel>> = {
  spam: "light",
  offensive: "light",
  phishing: "medium",
  malware: "medium",
  scam: "medium",
  threat: "grave",
  doxxing: "grave",
  intimate: "grave",
  csam: "grave",
};

export const REPORT_CATEGORIES = Object.keys(REPORT_LEVELS);

export const levelOfReport = (category: string): ReportLevel | null =>
  Object.hasOwn(REPORT_LEVELS, category) ? (REPORT_LEVELS[category] as ReportLevel) : null;

export const DAY_MS = 86_400_000;

export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);
