import { describe, expect, it } from "vitest";
import { hourOf, proofHolds, proofIsFresh, saltFor, startHolds, startNow } from "../src/core/start";

const SECRET = "09".repeat(32);
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const zeroBits = async (said: string): Promise<number> => {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(said)));
  let bits = 0;
  for (const byte of hash) {
    const inByte = Math.clz32(byte) - 24;
    bits += inByte;
    if (inByte < 8) break;
  }
  return bits;
};

describe("start", () => {
  it("gives an id of 8 letters and a mac that holds", async () => {
    const start = await startNow(SECRET, NOW);
    expect(start.id).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(await startHolds(SECRET, start.id, start.mac, NOW)).toBe(true);
  });

  it("gives another id each time, since nobody chooses it", async () => {
    const ids = new Set<string>();
    for (let n = 0; n < 200; n += 1) ids.add((await startNow(SECRET, NOW)).id);
    expect(ids.size).toBe(200);
  });

  it("still holds in the next hour, and no later", async () => {
    const start = await startNow(SECRET, NOW);
    expect(await startHolds(SECRET, start.id, start.mac, NOW + HOUR)).toBe(true);
    expect(await startHolds(SECRET, start.id, start.mac, NOW + 2 * HOUR)).toBe(false);
  });

  it("does not hold before the hour it was made in", async () => {
    const start = await startNow(SECRET, NOW + HOUR);
    expect(await startHolds(SECRET, start.id, start.mac, NOW)).toBe(false);
  });

  it("refuses an id its mac was not made for, and another secret", async () => {
    const start = await startNow(SECRET, NOW);
    expect(await startHolds(SECRET, "AAAAAAAA", start.mac, NOW)).toBe(false);
    expect(await startHolds("other", start.id, start.mac, NOW)).toBe(false);
  });
});

describe("proof of work", () => {
  it("asks for exactly the bits it says, odd counts included", async () => {
    for (let nonce = 0; nonce < 400; nonce += 1) {
      const zeros = await zeroBits(`s|${nonce}`);
      expect(await proofHolds("s", String(nonce), zeros)).toBe(true);
      expect(await proofHolds("s", String(nonce), zeros + 1)).toBe(false);
    }
  });

  it("covers the salt and the nonce, which is all a client is told", async () => {
    let nonce = 0;
    while ((await zeroBits(`s|${nonce}`)) < 12) nonce += 1;
    expect(await proofHolds("s", String(nonce), 12)).toBe(true);
    expect(await proofHolds("other", String(nonce), 12)).toBe(false);
    expect(await proofHolds("s", String(nonce + 1), 12)).toBe(false);
  });

  it("is bound to what is being done by its salt", async () => {
    const salt = await saltFor(SECRET, "doc", hourOf(NOW));
    let nonce = 0;
    while (!(await proofHolds(salt, String(nonce), 8))) nonce += 1;
    expect(await proofIsFresh(SECRET, "doc", String(nonce), 8, NOW)).toBe(true);
    expect(await proofIsFresh(SECRET, "doc", String(nonce), 8, NOW + 2 * HOUR)).toBe(false);
    const other = await saltFor(SECRET, "other", hourOf(NOW));
    expect(await proofHolds(other, String(nonce), 8)).toBe(false);
  });

  it("changes salt with the hour and the scope, so proofs cannot pile up", async () => {
    expect(await saltFor(SECRET, "doc", 1)).not.toBe(await saltFor(SECRET, "doc", 2));
    expect(await saltFor(SECRET, "doc", 1)).not.toBe(await saltFor(SECRET, "other", 1));
  });
});
