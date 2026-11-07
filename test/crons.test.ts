import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WRANGLER = readFileSync("wrangler.toml", "utf8");
const WORKER = readFileSync("src/private/index.ts", "utf8");
const crons = [...(/^crons = \[(.*)\]$/m.exec(WRANGLER)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
  ([, cron]) => cron ?? "",
);

describe("the Worker's schedules", () => {
  it("are all there", () => {
    expect(crons).toHaveLength(4);
    expect(crons).toContain("0 0,6,12,18 * * *");
  });

  it.each(crons)("%s is written as Cloudflare takes it, whose week goes from 1 to 7", (cron) => {
    const fields = cron.split(" ");
    expect(fields).toHaveLength(5);
    expect(fields[4]).not.toMatch(/\b0\b/);
  });

  it("each reach the work they are for, and only the hourly sweep goes by default", () => {
    const named = crons.filter((cron) => WORKER.includes(`"${cron}"`));
    expect(crons.filter((cron) => !named.includes(cron))).toEqual(["0 * * * *"]);
  });
});
