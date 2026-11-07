export const GRAVEST_FIRST = "category = 'csam' DESC, level = 'grave' DESC";

export interface QueuedReport {
  doc: string;
  ownerToBlock: string | null;
  net: string;
  category: string;
  level: string;
  detail: string | null;
  sealedLink: string | null;
  sealedContact: string | null;
  version: number;
  at: number;
  asn: number;
  fromFalseNet: boolean;
  overCap: boolean;
}

export interface QueuedDoc {
  id: string;
  ownerToBlock: string | null;
  latest: number;
  blockedAt: number;
  appealedAt: number | null;
  waitsForOperator: boolean;
  mayCorrect: boolean;
  versionToOpen: number;
  mayHandOver: boolean;
  signers: { n: number; byOwner: boolean }[];
}

export interface QueuedWarning {
  id: string;
  fixBy: number;
  nets: number;
}

export interface Queue {
  stage: string;
  newKeys: number;
  reportsTotal: number;
  reportsFrom: number;
  reports: QueuedReport[];
  docs: QueuedDoc[];
  warned: QueuedWarning[];
  blockedKeys: { root: string; blockedAt: number }[];
}
