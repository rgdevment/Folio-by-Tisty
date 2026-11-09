import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("opening the service", () => {
  it("opens the Worker before it tells clients, or every share they try would be refused", () => {
    const { sharing_open: told } = JSON.parse(readFileSync(".limits/limits.json", "utf8")) as {
      sharing_open?: boolean;
    };
    const workerOpen = /^SHARING_OPEN = "true"$/m.test(readFileSync("wrangler.toml", "utf8"));
    expect(told !== true || workerOpen).toBe(true);
  });
});
