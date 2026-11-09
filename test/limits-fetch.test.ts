import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Plain Windows may find the bash of WSL, which does not see these paths.
const HAS_POSIX_BASH = process.platform !== "win32" || Boolean(process.env.MSYSTEM);

describe.runIf(HAS_POSIX_BASH)("taking the limits from their branch", { timeout: 30_000 }, () => {
  let place: string;
  let origin: string;
  let work: string;

  const git = (cwd: string, ...said: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...said], {
      cwd,
      encoding: "utf8",
    }).trim();

  const signed = (serial: number): string => {
    writeFileSync(join(origin, "limits.json"), `{\n  "serial": ${serial}\n}\n`);
    writeFileSync(join(origin, "limits.json.minisig"), `signature ${serial}\n`);
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", `serial ${serial}`);
    return git(origin, "rev-parse", "HEAD");
  };

  const fetching = (env: Record<string, string> = {}) => {
    const { LIMITS_SHA: _sha, GITHUB_ENV: _env, GITHUB_OUTPUT: _output, ...outside } = process.env;
    return spawnSync("bash", ["scripts/limits-fetch.sh"], { cwd: work, encoding: "utf8", env: { ...outside, ...env } });
  };

  beforeEach(() => {
    place = mkdtempSync(join(tmpdir(), "limits-fetch-"));
    origin = join(place, "origin");
    work = join(place, "work");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "limits");
    git(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");
    mkdirSync(join(work, "scripts"), { recursive: true });
    copyFileSync(resolve("scripts/limits-fetch.sh"), join(work, "scripts/limits-fetch.sh"));
    git(work, "init", "-q", "-b", "main");
    git(work, "remote", "add", "origin", origin);
  });

  afterEach(() => {
    rmSync(place, { recursive: true, force: true });
  });

  it("copies the branch's tip into .limits and names its commit for the jobs after", () => {
    const tip = signed(5);
    const output = join(place, "output");
    const env = join(place, "env");
    writeFileSync(output, "");
    writeFileSync(env, "");
    const answer = fetching({ GITHUB_OUTPUT: output, GITHUB_ENV: env });
    expect(answer.status).toBe(0);
    expect(readFileSync(join(work, ".limits/limits.json"), "utf8")).toContain('"serial": 5');
    expect(readFileSync(join(work, ".limits/limits.json.minisig"), "utf8")).toBe("signature 5\n");
    expect(readFileSync(output, "utf8")).toBe(`limits_sha=${tip}\n`);
    expect(readFileSync(env, "utf8")).toBe(`LIMITS_SHA=${tip}\n`);
  });

  it("takes the commit it is told, so the Worker and the panel build with what the page built with", () => {
    const first = signed(5);
    signed(6);
    expect(fetching({ LIMITS_SHA: first }).status).toBe(0);
    expect(readFileSync(join(work, ".limits/limits.json"), "utf8")).toContain('"serial": 5');
  });

  it("fails when there is no limits branch, rather than build without limits", () => {
    expect(fetching().status).not.toBe(0);
  });
});
