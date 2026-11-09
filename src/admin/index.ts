import SIGNED_LIMITS from "../../.limits/limits.json";
import { CloudDashboard } from "../cloudflare/dashboard";
import { CloudModeration } from "../cloudflare/moderation";
import { certsFrom } from "./access";
import { answer } from "./api";

interface Env {
  DB: D1Database;
  ACCESS_TEAM: string;
  ACCESS_AUDIENCE: string;
  OPERATOR_EMAIL?: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await answer(request, {
        moderation: new CloudModeration(env.DB),
        dashboard: new CloudDashboard(env.DB),
        about: {
          sharingOpen: SIGNED_LIMITS.sharing_open,
          termsVersion: SIGNED_LIMITS.terms.version,
          limitsSerial: SIGNED_LIMITS.serial,
        },
        access: { team: env.ACCESS_TEAM, audience: env.ACCESS_AUDIENCE, email: env.OPERATOR_EMAIL ?? "" },
        certs: certsFrom(env.ACCESS_TEAM),
        now: Date.now(),
      });
    } catch (error) {
      console.error("an answer failed", String(error));
      return new Response('{"refused":"failed"}', { status: 500, headers: { "Content-Type": "application/json" } });
    }
  },
} satisfies ExportedHandler<Env>;
