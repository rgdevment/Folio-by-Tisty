import { describe, expect, it } from "vitest";
import { LEVEL_ONE } from "../src/core/limits";
import { type DayReading, type Signal, signalsOf, type Watched } from "../src/core/signals";

const QUIET: DayReading = { nets: 40, proved: 0, hours: 9, peak: 12 };
const FRIENDS: Watched = {
  today: QUIET,
  yesterday: QUIET,
  ownerRows: 40,
  liveDays: 12,
  mostNetsADay: 38,
  byUploader: false,
  uploader: { keys: 1, docs: 2 },
  editsADay: 4,
  report: null,
};

const kinds = (over: Partial<Watched>): Signal["kind"][] => signalsOf({ ...FRIENDS, ...over }).map((one) => one.kind);

describe("what a document's reading flags", () => {
  it("flags nothing for a link read by a group of friends", () => {
    expect(signalsOf(FRIENDS)).toEqual([]);
  });

  it("flags an owner whose readers reached the day's ceiling, and not one just under it", () => {
    expect(kinds({ ownerRows: LEVEL_ONE.rowsPerOwnerADay })).toEqual(["cap"]);
    expect(kinds({ ownerRows: LEVEL_ONE.rowsPerOwnerADay - 1 })).toEqual([]);
  });

  it("flags most networks coming with a proof of work, and not half of them", () => {
    expect(kinds({ today: { ...QUIET, nets: 300, proved: 151 } })).toEqual(["proved"]);
    expect(kinds({ today: { ...QUIET, nets: 300, proved: 150 } })).toEqual([]);
    expect(kinds({ today: { ...QUIET, nets: 0, proved: 0 } })).toEqual([]);
  });

  it("flags reading spread evenly over the whole day, today or yesterday", () => {
    const even: DayReading = { nets: 2400, proved: 0, hours: 24, peak: 200 };
    expect(kinds({ today: even })).toEqual(["even"]);
    expect(kinds({ yesterday: even })).toEqual(["even"]);
  });

  it("does not flag a day with a peak, too few hours or too few networks", () => {
    const even: DayReading = { nets: 2400, proved: 0, hours: 24, peak: 200 };
    expect(kinds({ today: { ...even, peak: 201 } })).toEqual([]);
    expect(kinds({ today: { ...even, hours: 19, peak: 100 } })).toEqual([]);
    expect(kinds({ today: { nets: 99, proved: 0, hours: 24, peak: 4 } })).toEqual([]);
    expect(kinds({ today: { nets: 100, proved: 0, hours: 20, peak: 10 } })).toEqual(["even"]);
  });

  it("flags one network that keeps a document alive past 30 days, and says when it is the uploader's", () => {
    const alone = { liveDays: 31, mostNetsADay: 1, today: { nets: 1, proved: 0, hours: 1, peak: 1 } };
    expect(signalsOf({ ...FRIENDS, ...alone, byUploader: true })).toEqual([
      { kind: "lone", days: 31, byUploader: true },
    ]);
    expect(kinds({ ...alone, liveDays: 30 })).toEqual([]);
    expect(kinds({ ...alone, mostNetsADay: 2 })).toEqual([]);
    expect(kinds({ ...alone, mostNetsADay: null })).toEqual([]);
    expect(kinds({ ...alone, today: QUIET })).toEqual([]);
  });

  it("flags a network that made the day's most new keys, with what it uploaded", () => {
    expect(signalsOf({ ...FRIENDS, uploader: { keys: LEVEL_ONE.newKeysADay, docs: 31 } })).toEqual([
      { kind: "keys", keys: LEVEL_ONE.newKeysADay, docs: 31 },
    ]);
    expect(kinds({ uploader: { keys: LEVEL_ONE.newKeysADay - 1, docs: 49 } })).toEqual([]);
    expect(kinds({ uploader: null })).toEqual([]);
  });

  it("flags more than 20 edits in a day, and not 20", () => {
    expect(signalsOf({ ...FRIENDS, editsADay: 21 })).toEqual([{ kind: "edits", edits: 21 }]);
    expect(kinds({ editsADay: 20 })).toEqual([]);
  });

  it("flags an open report with its level", () => {
    expect(signalsOf({ ...FRIENDS, report: "medium" })).toEqual([{ kind: "report", level: "medium" }]);
  });

  it("says every reason a farm of readers gives at once", () => {
    const farm: DayReading = { nets: 5000, proved: 4750, hours: 24, peak: 220 };
    expect(kinds({ today: farm, ownerRows: 5000 })).toEqual(["cap", "proved", "even"]);
  });
});
