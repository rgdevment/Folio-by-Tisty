import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Lookup } from "../scripts/dns";
import {
  approvedIn,
  failingLines,
  listFaults,
  SHARDS,
  shardFaults,
  shardsOf,
  signShards,
  writeShards,
} from "../scripts/domains";
import { createKeys } from "../scripts/limits-key";
import { proofOf, shardOf } from "../src/core/checked-domain";
import { isChecked } from "../src/page/checked";
import { standingFor } from "../src/page/read";

const ROOT = "AfnGoRnNecrr5RMnprcTbdZdk7_LABXtpqchY-L0b0s";
const OTHER = "B".repeat(43);
const naming =
  (roots: Record<string, string>): Lookup =>
  async (_resolver, name) => {
    const root = roots[name.replace("_tisty.", "")];
    return root === undefined ? [] : [`tisty-root=${root}`];
  };

describe("a domain's proof", () => {
  it("is the start of sha256 over the root and the domain, in the shard of its first two characters", async () => {
    const proof = await proofOf(ROOT, "rgdevment.dev");
    expect(proof).toBe("7532a62348e8a81b78e532d9e81c87e0");
    expect(shardOf(proof)).toBe("75");
  });
});

describe("the private list", () => {
  it("reads one domain and its root per line, skipping blank lines", () => {
    expect(approvedIn(`ana.dev ${ROOT}\n\n  luis.cl   ${OTHER}  \n`)).toEqual([
      { domain: "ana.dev", root: ROOT },
      { domain: "luis.cl", root: OTHER },
    ]);
  });

  it("refuses a bad domain or root, and a domain or root named twice", () => {
    expect(listFaults(approvedIn(`Ana.dev ${ROOT}\nluis.cl short`))).toEqual([
      "line 1: not a lowercase ASCII domain",
      "line 2: not a root",
    ]);
    expect(listFaults(approvedIn(`ana.dev ${ROOT}\nana.dev ${OTHER}`))).toEqual(["ana.dev has more than one root"]);
    expect(listFaults(approvedIn(`ana.dev ${ROOT}\nluis.cl ${ROOT}`))).toEqual([`${ROOT} has more than one domain`]);
  });

  it("asks the resolvers a few domains at a time", async () => {
    let now = 0;
    let most = 0;
    const counting: Lookup = async () => {
      now += 1;
      most = Math.max(most, now);
      await new Promise((done) => setTimeout(done, 1));
      now -= 1;
      return [];
    };
    const many = Array.from({ length: 100 }, (_, at) => ({ domain: `d${at}.dev`, root: ROOT }));
    await failingLines(many, counting);
    expect(most).toBeLessThanOrEqual(32);
  });

  it("names failing domains by their line, never by the domain", async () => {
    const approved = approvedIn(`ana.dev ${ROOT}\nluis.cl ${OTHER}`);
    const failing = await failingLines(approved, naming({ "ana.dev": ROOT }));
    expect(failing).toEqual(["line 2"]);
  });
});

describe("the shards", () => {
  let place: string;
  let keyFile: string;
  let publicKey: string;

  beforeEach(() => {
    place = mkdtempSync(join(tmpdir(), "domains-"));
    keyFile = join(place, "the.key");
    publicKey = join(place, "limits.pub");
    createKeys(keyFile, {
      limits: join(place, "limits.json"),
      publicKey,
      termsEs: join(place, "es.md"),
      termsEn: join(place, "en.md"),
    });
  });

  afterEach(() => {
    rmSync(place, { recursive: true, force: true });
  });

  it("hold only proofs, sorted, each in its own shard, and sign each one", async () => {
    const dir = join(place, "domains");
    const approved = approvedIn(`rgdevment.dev ${ROOT}\nana.dev ${OTHER}`);
    writeShards(await shardsOf(approved), dir);
    expect(signShards(keyFile, Date.UTC(2026, 10, 8), dir, publicKey)).toBe(2);
    expect(shardFaults(dir, readFileSync(publicKey, "utf8"))).toEqual([]);
    const said = readFileSync(join(dir, "75.json"), "utf8");
    expect(said).not.toContain("rgdevment");
    expect(said).not.toContain(ROOT);
    expect(JSON.parse(said)).toEqual(["7532a62348e8a81b78e532d9e81c87e0"]);
  });

  it("drop the old signature of a shard whose proofs changed, and keep an unchanged one's", async () => {
    const dir = join(place, "domains");
    writeShards(
      await shardsOf(
        approvedIn(`rgdevment.dev ${ROOT}
ana.dev ${OTHER}`),
      ),
      dir,
    );
    signShards(keyFile, Date.UTC(2026, 10, 8), dir, publicKey);
    const kept = await shardsOf(
      approvedIn(`rgdevment.dev ${ROOT}
ana.dev ${OTHER}`),
    );
    writeShards(kept, dir);
    expect(shardFaults(dir, readFileSync(publicKey, "utf8"))).toEqual([]);
    const anaShard = shardOf(await proofOf(OTHER, "ana.dev"));
    const changed = new Map(kept);
    changed.set(
      anaShard,
      `${JSON.stringify([`${anaShard}${"0".repeat(30)}`], null, 1)}
`,
    );
    writeShards(changed, dir);
    expect(existsSync(join(dir, `${anaShard}.json.minisig`))).toBe(false);
    expect(existsSync(join(dir, "75.json.minisig"))).toBe(true);
  });

  it("drop a shard nobody is left in", async () => {
    const dir = join(place, "domains");
    writeShards(await shardsOf(approvedIn(`rgdevment.dev ${ROOT}\nana.dev ${OTHER}`)), dir);
    writeShards(await shardsOf(approvedIn(`ana.dev ${OTHER}`)), dir);
    expect(shardFaults(dir, "").filter((fault) => fault.includes("75.json"))).toEqual([]);
  });

  it("are refused unsigned, past 70 KB, or holding another shard's proof", () => {
    const dir = join(place, "domains");
    writeShards(new Map([["3f", '["3f000000000000000000000000000000"]\n']]), dir);
    expect(shardFaults(dir, readFileSync(publicKey, "utf8"))).toEqual(["domains/3f.json is not signed"]);
    writeFileSync(join(dir, "3f.json"), '["40000000000000000000000000000000"]');
    expect(shardFaults(dir, "")).toContain("domains/3f.json holds a proof that is not its own");
    writeFileSync(join(dir, "3f.json"), JSON.stringify(Array(2200).fill("3f000000000000000000000000000000")));
    expect(shardFaults(dir, "")).toContain("domains/3f.json passes 70 KB");
  });
});

describe("the shards Folio publishes", () => {
  it("hold, signed with the key Tisty is built with", () => {
    expect(shardFaults(SHARDS)).toEqual([]);
  });
});

describe("the page asking for a domain", () => {
  const shardHolding = (proofs: string[]) => async () => proofs;
  const BUILT = new Set(["75"]);
  const never = async () => {
    throw new Error("asked");
  };

  it("finds a checked domain in its shard", async () => {
    const proof = await proofOf(ROOT, "rgdevment.dev");
    expect(await isChecked(ROOT, "rgdevment.dev", shardHolding([proof]), BUILT)).toBe(true);
  });

  it("does not take the same domain under another root", async () => {
    const proof = await proofOf(ROOT, "rgdevment.dev");
    expect(await isChecked(OTHER, "rgdevment.dev", shardHolding([proof]), new Set([shardOf(proof)]))).toBe(false);
  });

  it("asks nothing for a name that is not a domain", async () => {
    expect(await isChecked(ROOT, "Ana", never, BUILT)).toBe(false);
    expect(await isChecked(ROOT, undefined, never, BUILT)).toBe(false);
  });

  it("asks nothing when its shard was not built, as none is today", async () => {
    expect(await isChecked(ROOT, "rgdevment.dev", never, new Set())).toBe(false);
    expect(await isChecked(ROOT, "rgdevment.dev", never)).toBe(false);
  });

  it("takes a shard that is unreadable or out of reach as holding nothing", async () => {
    expect(await isChecked(ROOT, "rgdevment.dev", async () => "<!doctype html>", BUILT)).toBe(false);
    expect(await isChecked(ROOT, "rgdevment.dev", never, BUILT)).toBe(false);
  });

  it("checks a domain only while its signature still speaks", async () => {
    const proof = await proofOf(OTHER, "ana.dev");
    const built = new Set([shardOf(proof)]);
    expect(await standingFor(OTHER, "holds", "ana.dev", shardHolding([proof]), built)).toBe("checked");
    expect(await standingFor(OTHER, "doubtful", "ana.dev", shardHolding([proof]), built)).toBe("plain");
  });
});
