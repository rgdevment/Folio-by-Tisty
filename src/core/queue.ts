export interface QueuedReport {
  doc: string;
  net: string;
  category: string;
  level: string;
  detail: string | null;
  sealedLink: string | null;
  version: number;
  at: number;
  asn: number;
}

export interface QueuedDoc {
  id: string;
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
  reports: QueuedReport[];
  docs: QueuedDoc[];
}
