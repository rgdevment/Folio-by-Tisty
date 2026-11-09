import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Plain Windows may find the bash of WSL, which does not see these paths.
const HAS_POSIX_BASH = process.platform !== "win32" || Boolean(process.env.MSYSTEM);
const SCRIPT = resolve("scripts/limits-serial.sh");

describe.runIf(HAS_POSIX_BASH)("the check of the limits branch", { timeout: 30_000 }, () => {
  let place: string;

  const git = (...said: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...said], {
      cwd: place,
      encoding: "utf8",
    }).trim();

  const limits = (serial: number, version?: string, texts = "a"): void => {
    const terms =
      version === undefined
        ? ""
        : `,\n  "terms": {\n    "version": "${version}",\n    "es": "${texts}",\n    "en": "${texts}"\n  }`;
    writeFileSync(join(place, "limits.json"), `{\n  "serial": ${serial}${terms}\n}\n`);
  };

  const committed = (): string => {
    git("add", "-A");
    git("commit", "-qm", "a change", "--allow-empty");
    return git("rev-parse", "HEAD");
  };

  const check = (older: string, newer: string) =>
    spawnSync("bash", [SCRIPT, older, newer], { cwd: place, encoding: "utf8" });

  beforeEach(() => {
    place = mkdtempSync(join(tmpdir(), "limits-serial-"));
    git("init", "-q", "-b", "limits");
    limits(3, "1");
  });

  afterEach(() => {
    rmSync(place, { recursive: true, force: true });
  });

  it("takes a commit that leaves the limits as they were", () => {
    const older = committed();
    expect(check(older, committed()).status).toBe(0);
  });

  it("takes a serial that grew", () => {
    const older = committed();
    limits(4, "1");
    expect(check(older, committed()).status).toBe(0);
  });

  it("refuses a serial that did not grow", () => {
    const older = committed();
    limits(3, "2", "b");
    const answer = check(older, committed());
    expect(answer.status).toBe(1);
    expect(answer.stdout).toContain("sign it again");
  });

  it("refuses terms that changed under the same version", () => {
    const older = committed();
    limits(4, "1", "b");
    const answer = check(older, committed());
    expect(answer.status).toBe(1);
    expect(answer.stdout).toContain("raise it");
  });

  it("refuses a file that lost its terms", () => {
    const older = committed();
    limits(4);
    expect(check(older, committed()).status).toBe(1);
  });

  it("takes terms that changed with their version grown", () => {
    const older = committed();
    limits(4, "2", "b");
    expect(check(older, committed()).status).toBe(0);
  });

  it("takes the first file that names the terms", () => {
    limits(2);
    const older = committed();
    limits(3, "1");
    expect(check(older, committed()).status).toBe(0);
  });
});
