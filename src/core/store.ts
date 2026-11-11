import type { Revocation } from "@tisty/contracts";

export interface Version {
  n: number;
  hash: string;
  bytes: number;
  at: number;
  signer: string;
  machine: string;
  contract: string;
  files?: string;
  filesKept?: number;
}

export interface NewDoc {
  id: string;
  owner: string;
  anchor?: string;
  permit?: string;
  ownerMark?: string;
  adminHash: string;
  ttlDays: number;
  net: string;
}

export interface Upload {
  id: string;
  n: number;
  hash: string;
  body: ArrayBuffer | Uint8Array | string;
  net: string;
  at: number;
  signer: string;
  machine: string;
  contract: string;
  byOwner: boolean;
  permit: string | null;
  ownerMark: string;
  files?: string;
  filesBytes?: number;
  newKey?: boolean;
  roomAtMost?: number;
  reviewed?: HeldReviewed;
}

export interface HeldReviewed {
  said: string;
  seq: number;
}

export interface KeptFiles {
  id: string;
  hash: string;
  body: Uint8Array;
  net: string;
  newKey: boolean;
  roomAtMost: number;
}

export type Appealed = "accepted" | "review";

export interface Held {
  owner: string;
  adminHash: string;
  reviewed: HeldReviewed | null;
  permit: string | null;
  ownerMark: string;
  anchor: string | null;
  latest: number;
  versions: Version[];
  filesBytes: number;
  blocked: boolean;
  paused: boolean;
  correctable: boolean;
}

export interface Reading {
  owner: string;
  reader: string;
  doc: string;
  hour: number;
  proved: boolean;
}

export interface Report {
  doc: string;
  net: string;
  category: string;
  asn: number;
  detail?: string;
  sealedLink?: string;
  sealedContact?: string;
  version?: number;
}

export interface Reported {
  blocked: boolean;
}

export interface News {
  reports: { doc: string; category: string; nets: number; uncounted: number }[];
  reportsTotal: number;
  reportLines: number;
  blocked: string[];
  appealed: string[];
  newKeys: number;
  newKeysDay: number;
  newKeysNearTheirTop: boolean;
}

// What a read needs of a document, in one row.
export interface OpenedCase {
  version: Version;
  diesOn: number;
  revocations: Revocation[];
  sealedRecords: string | null;
}

export interface Shown {
  owner: string;
  version: Version | null;
  diesOn: number;
  alive: boolean;
  pausedAt: number | null;
  blockedAt: number | null;
  fixBy: number | null;
  revocations: Revocation[];
  reviewed: ServedReviewed | null;
}

export interface ServedReviewed {
  said: string;
  seq: number;
  at: number;
}

// What the admin link shows, and never an order that keeps a document (decision 42).
export interface DocStatus {
  latest: number;
  diesOn: number;
  pausedAt: number | null;
  blockedAt: number | null;
  appealedAt: number | null;
  mayCorrect: boolean;
  fixBy: number | null;
  readTotal: number;
  days: unknown;
}

export interface Owned {
  adminHash: string;
  status: DocStatus;
}

export type Created =
  | "created"
  | "same"
  | "taken"
  | "shares_full"
  | "languages_full"
  | "no_anchor"
  | "quota"
  | "day_full"
  | "bad_ttl";
export type Uploaded =
  | "stored"
  | "same"
  | "behind"
  | "missing"
  | "blocked"
  | "paused"
  | "quota"
  | "list_full"
  | "new_keys_full"
  | "room_full";
export type Admitted = "here" | "new" | "over" | "full";
export type Stage = "open" | "warned" | "new_keys_off" | "no_uploads" | "blocked";

export interface Spent {
  bill: number;
  line: number;
  storedGb: number;
}

export interface Swept {
  summed: number;
  forgotten: number;
  failed: number;
}

export interface Orphans {
  forgotten: number;
  unknownBatches: number;
}

// What the rules need of wherever Folio runs, so the core never knows it is Cloudflare (decisions 16 and 108).
export interface KeyAdmitted {
  said: "known" | "new" | "full" | "blocked";
  terms: string | null;
}

export interface AcceptedTerms {
  root: string;
  version: string;
  hour: number;
}

export interface Store {
  create(doc: NewDoc, today: number): Promise<Created>;
  upload(upload: Upload, today: number, held?: Held): Promise<Uploaded>;
  forgetUnsent(id: string, net: string, today: number): Promise<void>;
  held(id: string): Promise<Held | null>;
  setPermit(id: string, permit: string | null): Promise<void>;
  revoke(revocations: Revocation[]): Promise<boolean>;
  isRevoked(root: string, machine: string, now: number): Promise<boolean>;
  keepReviewed(id: string, latest: number, reviewed: HeldReviewed, at: number): Promise<boolean>;
  haveSigned(roots: string[]): Promise<boolean>;
  newRootsOf(roots: string[], day: number): Promise<string[]>;
  anyBlocked(roots: string[]): Promise<boolean>;
  heldByOwner(owner: string, today: number, except: string): Promise<number>;
  admit(reading: Reading, today: number): Promise<Admitted>;
  note(reading: Reading, today: number): Promise<void>;
  shown(id: string, today: number): Promise<Shown | null>;
  lastVersionsWithLanguages(id: string, owner: string, count: number): Promise<Version[][]>;
  openedCase(id: string, hash: string, today: number, now: number): Promise<OpenedCase | null>;
  envelope(id: string, version: Version): Promise<ReadableStream | null>;
  filesBytes(id: string, hash: string): Promise<number | null>;
  keepFiles(files: KeptFiles, today: number): Promise<"stored" | "quota" | "new_keys_full" | "room_full" | "behind">;
  filesOf(id: string, hash: string): Promise<ReadableStream | null>;
  dayKey(today: number): Promise<string>;
  evidenceKey(today: number): Promise<string>;
  admitKey(root: string, net: string, today: number): Promise<KeyAdmitted>;
  keepKeys(roots: string[], today: number, accepted?: AcceptedTerms): Promise<void>;
  giveKeysBack(count: number, net: string, today: number): Promise<void>;
  takeHourly(net: string, action: string, hour: number, atMost: number, taking?: number): Promise<boolean>;
  sharedToday(owner: string, today: number): Promise<number>;
  report(report: Report, today: number, hour: number): Promise<Reported>;
  owned(id: string, today: number): Promise<Owned | null>;
  appeal(id: string, today: number, hour: number): Promise<Appealed>;
  appealAccepted(id: string, today: number): Promise<void>;
  pause(id: string, today: number): Promise<void>;
  resume(id: string, today: number): Promise<void>;
  stop(id: string, today: number): Promise<void>;
  sweep(today: number): Promise<Swept>;
  forgetOrphans(now: number): Promise<Orphans>;
  stage(): Promise<Stage>;
  spentAt(): Promise<number | null>;
  digested(): Promise<{ hour: number; alerted: Stage }>;
  news(after: number, before: number, atMost: number): Promise<News>;
  setDigested(hour: number, stage: Stage): Promise<void>;
  setStage(stage: Stage): Promise<void>;
  noteSpend(spent: Spent, at: number): Promise<void>;
  liftCut(today: number): Promise<void>;
}
