export interface QueuedReport {
  doc: string;
  owner: string | null;
  net: string;
  category: string;
  level: string;
  detail: string | null;
  sealedLink: string | null;
  version: number;
  at: number;
  asn: number;
  fromFalseNet: boolean;
}

export interface QueuedDoc {
  id: string;
  owner: string;
  latest: number;
  blockedAt: number;
  appealedAt: number | null;
  waitsForOperator: boolean;
  mayCorrect: boolean;
  signers: { n: number; byOwner: boolean }[];
}

export interface Queue {
  stage: string;
  newKeys: number;
  reportsTotal: number;
  reports: QueuedReport[];
  docs: QueuedDoc[];
  blockedKeys: { root: string; blockedAt: number }[];
}
