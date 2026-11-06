import { describe, expect, it } from "vitest";
import { sendMail } from "../src/cloudflare/mail";

describe("sending the mail", () => {
  it.each([
    ["no settings", {}],
    ["no password", { MAIL_USER: "a@example.com", ALERT_TO: "b@example.com" }],
    ["nobody to tell", { MAIL_USER: "a@example.com", MAIL_PASSWORD: "p" }],
  ])("fails with %s, rather than telling nobody", async (_says, env) => {
    await expect(sendMail(env, "Folio: resumen", "texto")).rejects.toThrow("there is nowhere to send the mail");
  });
});
