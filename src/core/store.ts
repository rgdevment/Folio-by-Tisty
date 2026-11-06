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
}

export interface KeptFiles {
  id: string;
  hash: string;
  body: Uint8Array;
  net: string;
}

export interface Held {
  owner: string;
  permit: string | null;
  ownerMark: string;
  anchor: string | null;
  latest: number;
  versions: Version[];
  blocked: boolean;
  paused: boolean;
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
  version?: number;
}

export interface Reported {
  blocked: boolean;
}

export interface News {
  reports: { doc: string; category: string; nets: number }[];
  blocked: string[];
  appealed: string[];
}

// What a read needs of a document, in one row.
export interface Shown {
  owner: string;
  version: Version | null;
  diesOn: number;
  alive: boolean;
  pausedAt: number | null;
  blockedAt: number | null;
  fixBy: number | null;
  revocations: Revocation[];
}

// What the admin link shows, and never an order that keeps a document (decision 42).
export interface DocStatus {
  latest: number;
  diesOn: number;
  pausedAt: number | null;
  blockedAt: number | null;
  appealedAt: number | null;
  fixBy: number | null;
  readTotal: number;
  days: unknown;
}

export interface Owned {
  adminHash: string;
  status: DocStatus;
}

export type Created = "created" | "same" | "taken" | "shares_full" | "no_anchor" | "quota" | "bad_ttl";
export type Uploaded = "stored" | "same" | "behind" | "missing" | "blocked" | "paused" | "quota" | "list_full";
export type Admitted = "here" | "new" | "over" | "full";
export type Stage = "open" | "warned" | "no_uploads" | "blocked";

export interface Swept {
  summed: number;
  forgotten: number;
  failed: number;
}

// What the rules need of wherever Folio runs, so the core never knows it is Cloudflare (decisions 16 and 108).
export interface Store {
  create(doc: NewDoc, today: number): Promise<Created>;
  upload(upload: Upload, today: number, held?: Held): Promise<Uploaded>;
  held(id: string): Promise<Held | null>;
  setPermit(id: string, permit: string | null): Promise<void>;
  revoke(revocations: Revocation[]): Promise<void>;
  isRevoked(root: string, machine: string, now: number): Promise<boolean>;
  haveSigned(roots: string[]): Promise<boolean>;
  admit(reading: Reading, today: number): Promise<Admitted>;
  note(reading: Reading, today: number): Promise<void>;
  shown(id: string, today: number): Promise<Shown | null>;
  envelope(id: string, version: Version): Promise<ReadableStream | null>;
  hasFiles(id: string, hash: string): Promise<boolean>;
  keepFiles(files: KeptFiles, today: number): Promise<"stored" | "quota">;
  filesOf(id: string, hash: string): Promise<ReadableStream | null>;
  dayKey(today: number): Promise<string>;
  evidenceKey(today: number): Promise<string>;
  takeHourly(net: string, action: string, hour: number, atMost: number, taking?: number): Promise<boolean>;
  report(report: Report, today: number, hour: number): Promise<Reported>;
  owned(id: string, today: number): Promise<Owned | null>;
  appeal(id: string, today: number, hour: number): Promise<void>;
  appealAccepted(id: string, today: number): Promise<void>;
  pause(id: string, today: number): Promise<void>;
  resume(id: string, today: number): Promise<void>;
  stop(id: string, today: number): Promise<void>;
  sweep(today: number): Promise<Swept>;
  forgetOrphans(now: number): Promise<number>;
  stage(): Promise<Stage>;
  digested(): Promise<{ hour: number; alerted: Stage }>;
  news(after: number, before: number, atMost: number): Promise<News>;
  setDigested(hour: number, stage: Stage): Promise<void>;
  setStage(stage: Stage): Promise<void>;
  liftCut(today: number): Promise<void>;
}
