import { type MailBindings, sendMail } from "../cloudflare/mail";
import { CloudSpend, type SpendBindings } from "../cloudflare/spend";
import { type Bindings, Cloud } from "../cloudflare/store";
import { sendDigest } from "../core/digest";
import { dayOf, LEVEL_ONE } from "../core/limits";
import { DayKeys } from "../core/net";
import { checkSpend } from "../core/spend";
import { answer } from "./api";

interface Env extends Bindings, SpendBindings, MailBindings {
  FOLIO_SECRET: string;
  READS: RateLimit;
  SYNCS: RateLimit;
  BILLING_DAY: string;
  HEARTBEAT_URL?: string;
  SPEND_HEARTBEAT_URL?: string;
  DIGEST_HEARTBEAT_URL?: string;
  ADMIN_URL?: string;
  FOLIO_TAG?: string;
}

const WEEKLY = "0 4 * * 0";
const SPEND = "*/15 * * * *";
const DIGEST = "0 0,12 * * *";
const dayKeys = new DayKeys();
const evidenceKeys = new DayKeys();

const reviewSpend = async (now: number, env: Env): Promise<void> => {
  const spend = new CloudSpend(env);
  const stage = await checkSpend(now, Number(env.BILLING_DAY), {
    store: new Cloud(env),
    usageSince: (start, until) => spend.usageSince(start, until),
    setBlocked: (blocked) => spend.setBlocked(blocked),
  });
  console.log(JSON.stringify({ stage }));
  // It stops arriving when the review fails, and that is the alert: without it nothing cuts the bill.
  if (env.SPEND_HEARTBEAT_URL) await fetch(env.SPEND_HEARTBEAT_URL);
};

export default {
  async fetch(request, env, context): Promise<Response> {
    const store = new Cloud(env);
    const started = Date.now();
    const response = await answer(request, {
      now: started,
      waitUntil: (work) => context.waitUntil(work),
      tools: {
        store,
        limits: LEVEL_ONE,
        secret: env.FOLIO_SECRET,
        limiter: { allows: async (key) => (await env.READS.limit({ key })).success },
        syncLimiter: { allows: async (key) => (await env.SYNCS.limit({ key })).success },
        dayKey: (today) => dayKeys.of(today, (day) => store.dayKey(day)),
        evidenceKey: (today) => evidenceKeys.of(today, (day) => store.evidenceKey(day)),
      },
    });
    response.headers.set("Server-Timing", `total;dur=${Date.now() - started}`);
    if (env.FOLIO_TAG) response.headers.set("Folio-Worker", env.FOLIO_TAG);
    return response;
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === SPEND) {
      await reviewSpend(controller.scheduledTime, env);
      return;
    }
    const store = new Cloud(env);
    if (controller.cron === DIGEST) {
      const sent = await sendDigest(controller.scheduledTime, {
        store,
        send: (subject, text) => sendMail(env, subject, text),
        panel: env.ADMIN_URL,
      });
      console.log(JSON.stringify({ sent }));
      // It stops arriving when the mail fails, and that is the alert.
      if (env.DIGEST_HEARTBEAT_URL) await fetch(env.DIGEST_HEARTBEAT_URL);
      return;
    }
    if (controller.cron === WEEKLY) {
      console.log(JSON.stringify({ orphans: await store.forgetOrphans(controller.scheduledTime) }));
      return;
    }
    const swept = await store.sweep(dayOf(controller.scheduledTime));
    // Only numbers, never an id (decision 98). The heartbeat stops arriving when a sweep fails, and that is the alert.
    console.log(JSON.stringify(swept));
    if (swept.failed === 0 && env.HEARTBEAT_URL) await fetch(env.HEARTBEAT_URL);
  },
} satisfies ExportedHandler<Env>;
