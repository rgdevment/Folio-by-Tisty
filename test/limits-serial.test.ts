import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Plain Windows may find the bash of WSL, which does not see these paths.
const HAS_POSIX_BASH = process.platform !== "win32" || Boolean(process.env.MSYSTEM);

describe.runIf(HAS_POSIX_BASH)("the check of the signed limits", { timeout: 30_000 }, () => {
  let place: string;

  const git = (...said: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...said], {
      cwd: place,
      encoding: "utf8",
    }).trim();

  const limits = (serial: number, version?: string): void => {
    const terms =
      version === undefined ? "" : `,\n  "terms": {\n    "version": "${version}",\n    "es": "a",\n    "en": "b"\n  }`;
    writeFileSync(join(place, "docs/limits.json"), `{\n  "serial": ${serial}${terms}\n}\n`);
  };

  const terms = (said: string): void => writeFileSync(join(place, "docs/TERMS.md"), `${said}\n`);

  const committed = (): string => {
    git("add", "-A");
    git("commit", "-qm", "a change", "--allow-empty");
    return git("rev-parse", "HEAD");
  };

  const check = (base: string, head: string) =>
    spawnSync("bash", ["scripts/limits-serial.sh", base, head], { cwd: place, encoding: "utf8" });

  beforeEach(() => {
    place = mkdtempSync(join(tmpdir(), "limits-serial-"));
    mkdirSync(join(place, "scripts"));
    mkdirSync(join(place, "docs"));
    copyFileSync("scripts/limits-serial.sh", join(place, "scripts/limits-serial.sh"));
    git("init", "-q", "-b", "main");
    limits(3, "1");
    terms("one");
  });

  afterEach(() => {
    rmSync(place, { recursive: true, force: true });
  });

  it("takes a change that touches neither the limits nor the terms", () => {
    const base = committed();
    writeFileSync(join(place, "other.md"), "x\n");
    expect(check(base, committed()).status).toBe(0);
  });

  it("refuses a text that changed with nothing signed", () => {
    const base = committed();
    terms("two");
    const answer = check(base, committed());
    expect(answer.status).toBe(1);
    expect(answer.stdout).toContain("the terms changed");
  });

  it("refuses a text that changed when only the serial grew", () => {
    const base = committed();
    terms("two");
    limits(4, "1");
    expect(check(base, committed()).status).toBe(1);
  });

  it("takes a text that changed with its version grown", () => {
    const base = committed();
    terms("two");
    limits(4, "2");
    expect(check(base, committed()).status).toBe(0);
  });

  it("refuses a file that lost its terms when a text changed", () => {
    const base = committed();
    terms("two");
    limits(4);
    expect(check(base, committed()).status).toBe(1);
  });

  it("takes the first file that names the terms", () => {
    limits(2);
    const base = committed();
    limits(3, "1");
    terms("two");
    expect(check(base, committed()).status).toBe(0);
  });

  it("refuses a serial that did not grow", () => {
    const base = committed();
    limits(3, "2");
    expect(check(base, committed()).status).toBe(1);
  });

  it("does not blame a branch for what main signed after it left", () => {
    const left = committed();
    git("switch", "-q", "-c", "feat/other");
    writeFileSync(join(place, "other.md"), "x\n");
    const head = committed();
    git("switch", "-q", "main");
    terms("two");
    limits(4, "2");
    const base = committed();
    expect(left).not.toBe(base);
    expect(check(base, head).status).toBe(0);
  });
});
