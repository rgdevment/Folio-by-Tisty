import { DAY_MS, dayOf } from "./limits";
import type { Stage, Store } from "./store";

export interface Usage {
  requests: number;
  rowsRead: number;
  rowsWritten: number;
  classA: number;
  classB: number;
  storedGb: number;
}

// Decision 118. Prices per million as published, with what the 5 USD plan includes.
const PLAN_USD = 5;
const CAP_USD = 20;
const BURST_USD = 3;
const WARN_USD = 10;
const UPLOADS_CUT_AT = 0.75;
const STORED_GB_AT_MOST = 100;
// An estimate: CPU is a small part of the bill, and this is what a read was measured to take.
const CPU_MS_PER_REQUEST = 2;

const overMillions = (used: number, included: number, perMillion: number): number =>
  (Math.max(0, used - included) / 1e6) * perMillion;

export const billOf = ({ requests, rowsRead, rowsWritten, classA, classB, storedGb }: Usage): number =>
  PLAN_USD +
  overMillions(requests, 10e6, 0.3) +
  overMillions(requests * CPU_MS_PER_REQUEST, 30e6, 0.02) +
  overMillions(rowsRead, 25e9, 0.001) +
  overMillions(rowsWritten, 50e6, 1) +
  overMillions(classA, 1e6, 4.5) +
  overMillions(classB, 10e6, 0.36) +
  Math.max(0, storedGb - 10) * 0.015;

export interface Cycle {
  start: number;
  days: number;
  day: number;
}

// What is included starts again on the plan's renewal date, not on the first of the month.
export const cycleOf = (now: number, renewalDay: number): Cycle => {
  // Not past 28, which every month has. Without this check a bad setting would give a line that never blocks.
  if (!Number.isInteger(renewalDay) || renewalDay < 1 || renewalDay > 28) {
    throw new Error(`not a renewal day: ${renewalDay}`);
  }
  const today = new Date(now);
  const back = today.getUTCDate() < renewalDay ? 1 : 0;
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() - back;
  const start = Date.UTC(year, month, renewalDay);
  const days = (Date.UTC(year, month + 1, renewalDay) - start) / DAY_MS;
  return { start, days, day: dayOf(now) - dayOf(start) + 1 };
};

// The margin sits under the rise: as a flat floor, the first days did not move and a block outlived its midnight.
export const lineOf = ({ day, days }: Cycle): number =>
  PLAN_USD + BURST_USD + ((CAP_USD - PLAN_USD - BURST_USD) * day) / days;

export const stageOf = (usage: Usage, cycle: Cycle): Stage => {
  const bill = billOf(usage);
  const line = lineOf(cycle);
  if (bill >= line) return "blocked";
  if (bill >= line * UPLOADS_CUT_AT || usage.storedGb >= STORED_GB_AT_MOST) return "no_uploads";
  return bill >= WARN_USD ? "warned" : "open";
};

export interface SpendTools {
  store: Pick<Store, "stage" | "setStage" | "liftCut">;
  usageSince: (start: number, now: number) => Promise<Usage>;
  setBlocked: (blocked: boolean) => Promise<void>;
}

export const checkSpend = async (now: number, renewalDay: number, tools: SpendTools): Promise<Stage> => {
  const { store, usageSince, setBlocked } = tools;
  const cycle = cycleOf(now, renewalDay);
  const usage = await usageSince(cycle.start, now);
  const stage = stageOf(usage, cycle);
  const was = await store.stage();
  if (stage !== was) {
    if ((stage === "blocked") !== (was === "blocked")) await setBlocked(stage === "blocked");
    if (was === "blocked") await store.liftCut(dayOf(now));
    await store.setStage(stage);
  }
  return stage;
};
