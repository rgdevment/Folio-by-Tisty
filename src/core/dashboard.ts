import type { ReportLevel } from "./limits";
import type { Queue } from "./queue";
import type { DayReading, Signal } from "./signals";
import type { Stage } from "./store";

export interface About {
  sharingOpen: boolean;
  termsVersion: string;
  limitsSerial: number;
}

export interface Overview {
  stage: Stage;
  docs: { open: number; newToday: number; withLanguages: number };
  readers: { today: number; yesterday: number | null };
  keys: { total: number; newToday: number; newADay: number };
  uploads: { today: number; newDocs: number };
  stored: { gb: number | null; heldBytes: number; newKeysBytesToday: number; atMostGb: number; newKeysStopGb: number };
  reports: Record<ReportLevel, number>;
  spend: { bill: number | null; line: number | null; capUsd: number; at: number | null };
  beats: { sweptHour: number | null; spentAt: number | null; digestedHour: number | null };
}

export interface ServiceDay {
  day: number;
  readers: number;
  uploads: number;
}

export interface Logged {
  at: number;
  action: string;
  on: string;
  note: string | null;
}

export interface NetNearItsTop {
  net: string;
  docs: number;
  bytes: number;
  keys: number;
  uploadsThisHour: number;
  share: number;
}

export interface NetsNearTheirTop {
  limits: { docs: number; bytes: number; keys: number; uploadsAnHour: number };
  nets: NetNearItsTop[];
}

export type TopOrder = "readers" | "weight" | "edits" | "oldest";

export interface TopDoc {
  id: string;
  owner: string;
  keyDay: number | null;
  languages: number;
  today: DayReading;
  yesterday: DayReading | null;
  ownerAtTop: boolean;
  bytes: number;
  latest: number;
  latestAt: number | null;
  firstDay: number | null;
  ttlDays: number;
  diesOn: number;
  blocked: boolean;
  paused: boolean;
  stopped: boolean;
  signals: Signal[];
}

export interface Top {
  order: TopOrder;
  flaggedOnly: boolean;
  docs: TopDoc[];
}

export interface Owner {
  root: string;
  firstDay: number | null;
  blockedAt: number | null;
  holds: number;
}

export interface Reviewed extends Queue {
  owners?: Record<string, Owner>;
}

export interface KeyDoc {
  id: string;
  anchor: string | null;
  latest: number;
  bytes: number;
  firstDay: number | null;
  diesOn: number;
  blockedAt: number | null;
  pausedAt: number | null;
  legalUntil: number | null;
  alive: boolean;
}

export interface KeyView extends Owner {
  termsVersion: string | null;
  termsHour: number | null;
  holdsAtMost: number;
  docs: { open: number; expired: number; blocked: number };
  versions: number;
  asEditor: number;
  reports: Record<ReportLevel, number>;
  listed: KeyDoc[];
}

export type Found =
  | { kind: "doc"; id: string; owner: string }
  | { kind: "key"; root: string }
  | { kind: "net"; net: string; days: { day: number; docs: number; bytes: number; keys: number }[] }
  | { kind: "reporter"; net: string; reports: number }
  | { kind: "none" };

export interface Dashboard {
  overview(now: number): Promise<Overview>;
  days(now: number): Promise<ServiceDay[]>;
  log(): Promise<Logged[]>;
  nets(now: number): Promise<NetsNearTheirTop>;
  top(now: number, order: TopOrder, flaggedOnly: boolean): Promise<Top>;
  owners(docs: string[], now: number): Promise<Record<string, Owner>>;
  key(root: string, now: number): Promise<KeyView | null>;
  keyRecords(root: string, now: number): Promise<unknown>;
  find(asked: string, now: number): Promise<Found>;
}
