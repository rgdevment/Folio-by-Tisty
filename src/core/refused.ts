import type { EnvelopeRefusal } from "../rules/envelope";
import { hourOf, saltFor } from "./start";

export type Refused =
  | {
      refused:
        | "missing"
        | "paused"
        | "blocked"
        | "bad_report"
        | "too_big"
        | "not_blocked"
        | "appealed"
        | "failed"
        | "behind"
        | "not_yours"
        | "shares_full"
        | "bad_upload"
        | "uploads_off"
        | "outdated"
        | "revoked"
        | "bad_revocation";
    }
  | { refused: "envelope"; why: EnvelopeRefusal }
  | { refused: "slow" | "quota"; until: number }
  | { refused: "proof"; salt: string; bits: number };

const LIMITER_WINDOW_MS = 60_000;

export const tooFast = (now: number): Refused => ({ refused: "slow", until: now + LIMITER_WINDOW_MS });

export const askForProof = async (secret: string, scope: string, bits: number, now: number): Promise<Refused> => ({
  refused: "proof",
  salt: await saltFor(secret, scope, hourOf(now)),
  bits,
});
