import { readFile } from "node:fs/promises";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";

describe("the written API", () => {
  it("is a valid OpenAPI file, so what a client generates from it can be trusted", async () => {
    const written = await readFile("docs/openapi.yaml", "utf8");
    const answer = await new Validator().validate(written);
    expect(answer.errors ?? []).toEqual([]);
    expect(answer.valid).toBe(true);
  });
});
