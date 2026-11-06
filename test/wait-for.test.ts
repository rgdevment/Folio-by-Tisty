import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Plain Windows may find the bash of WSL, which does not see these paths.
const HAS_POSIX_BASH = process.platform !== "win32" || Boolean(process.env.MSYSTEM);

const waiting = (check: string, tries = 2, env: NodeJS.ProcessEnv = {}) =>
  spawnSync(
    "bash",
    ["-c", `check() { ${check}; }; export -f check; bash scripts/wait-for.sh "the page" ${tries} 0 check`],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );

describe.runIf(HAS_POSIX_BASH)("waiting for an address to answer", () => {
  it("stops at the first answer that holds", () => {
    const answer = waiting("return 0");
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain("the page answers as it should");
    expect(answer.stdout).not.toContain("not yet");
  });

  it("does not blame a deploy for a challenge to its runner", () => {
    const answer = waiting("return 2");
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain("::warning::the page challenged this runner");
  });

  it("tries as many times as it was told, and then fails", () => {
    const answer = waiting("return 1", 3);
    expect(answer.status).toBe(1);
    expect(answer.stdout).toContain("not yet (3/3)");
    expect(answer.stdout).toContain("::error::the page does not answer as it should");
  });

  it("goes on until a later try holds", () => {
    const place = mkdtempSync(join(tmpdir(), "wait-for-"));
    const check = '[ -e "$MARK" ] && return 0; : > "$MARK"; return 1';
    const answer = waiting(check, 3, { MARK: join(place, "tried").replaceAll("\\", "/") });
    rmSync(place, { recursive: true, force: true });
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain("not yet (1/3)");
    expect(answer.stdout).not.toContain("not yet (2/3)");
  });
});
