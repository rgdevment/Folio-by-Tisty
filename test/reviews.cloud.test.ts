import type { Review, Reviewed, Served, Translation } from "@tisty/contracts";
import VECTORS from "@tisty/contracts/vectors.json";
import { describe, expect, it } from "vitest";
import { type Bytes, fromBase64Url } from "../src/core/bytes";
import { toBase64Url } from "../src/core/start";
import { openEnvelope } from "../src/page/open";
import { keptAsRead, keptBy, printOf, reachedBy, reviewHolds, reviewsCount } from "../src/page/reviews";

interface Held {
  document: string;
  lang: string;
  root: string;
  print: string;
}

interface Scenario {
  says: string;
  anchor: string;
  owner: string;
  link_key: string;
  map: string[];
  languages: Held[];
  reviews: Review[];
  served?: Served;
  seen?: number;
  shown: string[];
}

const SAMPLES = VECTORS as unknown as {
  link_key: string;
  main: { envelope: string; print: string };
  reviews: {
    anchor: string;
    owner: string;
    link_key: string;
    cases: { says: string; holds: boolean; review: Review }[];
  };
  reviewed: {
    anchor: string;
    owner: string;
    reviews: Review[];
    cases: { says: string; holds: boolean; head: Reviewed }[];
  };
  languages_shown: Scenario[];
};

const hex = (said: string): Bytes => Uint8Array.from(said.match(/../g) ?? [], (one) => Number.parseInt(one, 16));

describe("a review of a language (contract 1.9.0)", () => {
  const { anchor, owner, link_key: linkKey, cases } = SAMPLES.reviews;

  it.each(cases)("$says: holds $holds", async ({ holds, review }) => {
    expect(await reviewHolds(anchor, owner, fromBase64Url(linkKey), review)).toBe(holds);
    expect(await reviewHolds(anchor, owner, fromBase64Url(linkKey), { ...review, since: "x" })).toBe(false);
  });

  it("names no kept language under another anchor's key", async () => {
    const [kept] = cases;
    expect(await reviewHolds(anchor, owner, new Uint8Array(32), kept?.review as Review)).toBe(false);
  });
});

describe("the owner's word on an anchor's reviews", () => {
  const { anchor, owner, reviews, cases } = SAMPLES.reviewed;

  it.each(cases)("$says: holds $holds", async ({ holds, head }) => {
    expect(await reviewsCount(anchor, owner, reviews, { reviewed: head })).toBe(holds);
  });

  it("counts nothing with no word served", async () => {
    expect(await reviewsCount(anchor, owner, reviews, {})).toBe(false);
  });
});

describe("the languages a reader shows (contract, review.shown)", () => {
  const unseen = SAMPLES.languages_shown.filter(({ seen = 0 }) => seen === 0);

  it.each(unseen)(
    "$says",
    async ({ anchor, owner, link_key: linkKey, map, languages, reviews, served = {}, shown }) => {
      const kept = await keptBy(anchor, owner, fromBase64Url(linkKey), reviews, served);
      const held = new Map(languages.map((one) => [one.document, one]));
      const mapped = map.map((document): Translation => ({ document, lang: held.get(document)?.lang ?? "" }));
      const reached = reachedBy(mapped, kept).map((one) => one.document);
      const showing = languages.filter(
        (one) =>
          reached.includes(one.document) &&
          (one.root === owner || keptAsRead({ ...one, print: fromBase64Url(one.print) }, kept)),
      );
      expect(showing.map((one) => one.document)).toEqual(shown);
    },
  );

  it("takes no review beside a public anchor, which has no key (contract, review.sealed_only)", async () => {
    const kept = SAMPLES.languages_shown.find(
      ({ says }) => says === "a language its owner keeps, as its owner read it",
    );
    const { anchor, owner, link_key: linkKey, reviews, served = {} } = kept as Scenario;
    expect(await keptBy(anchor, owner, fromBase64Url(linkKey), reviews, served)).toHaveLength(1);
    expect(await keptBy(anchor, owner, undefined, reviews, served)).toEqual([]);
  });

  it("leaves out what the map says waits for its owner's review, whatever it is", () => {
    const map: Translation[] = [
      { document: "marioFrances", lang: "fr" },
      { document: "anaEnglish", lang: "en", pending: true },
    ];
    expect(reachedBy(map, []).map((one) => one.document)).toEqual(["marioFrances"]);
  });
});

describe("the print of a language", () => {
  it("is the one the contract gives for its main envelope, once open and inflated", async () => {
    const id = "k7Qm2xPa";
    const open = await openEnvelope(hex(SAMPLES.main.envelope), { id, kind: "main" }, fromBase64Url(SAMPLES.link_key));
    expect(toBase64Url(await printOf(open.opened))).toBe(SAMPLES.main.print);
  });
});
