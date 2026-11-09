import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Plain Windows may find the bash of WSL, which does not see these paths.
const HAS_POSIX_BASH = process.platform !== "win32" || Boolean(process.env.MSYSTEM);
const ADDRESS = "https://example.test";

const CLOUDFLARE = `
curl() {
  local out=/dev/stdout head=/dev/null url="" browser=0 file
  while [ $# -gt 0 ]; do
    case $1 in
      -o) out=$2; shift 2 ;;
      -D) head=$2; shift 2 ;;
      -A) browser=1; shift 2 ;;
      -H | --max-time) shift 2 ;;
      -s) shift ;;
      *) url=$1; shift ;;
    esac
  done
  file=\${url#${ADDRESS}/}
  case $file in
    AAAAAAAA) file=index.html ;;
    "") file=home.html ;;
    404) file=404.html ;;
    widget-frame) file=widget-frame.html ;;
  esac
  if [ "$out" = /dev/null ]; then :; else cat "$SITE/$file" > "$out"; fi
  if [ "$browser" = 1 ] && [ -n "\${ADDS_SCRIPT:-}" ]; then echo cloudflareinsights >> "$out"; fi
  printf 'HTTP/2 200\\n' > "$head"
  case $file in
    assets/*) printf '%s\\n%s\\n' "\${ASSET_CACHE:-Cache-Control: public, immutable}" "\${ASSET_ENCODING:-Content-Encoding: br}" >> "$head" ;;
    *) printf '%s\\n' "\${MORE_HEADERS:-X-None: 1}" >> "$head" ;;
  esac
}
export -f curl
`;

describe.runIf(HAS_POSIX_BASH)("comparing what is served with what was written", () => {
  let site: string;

  const run = (said: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync("bash", ["-c", `${CLOUDFLARE}\nbash scripts/page-code.sh ${said}`], {
      encoding: "utf8",
      env: { ...process.env, SITE: site, ...env },
    });

  beforeEach(() => {
    site = mkdtempSync(join(tmpdir(), "page-code-")).replaceAll("\\", "/");
    mkdirSync(join(site, "assets"));
    writeFileSync(join(site, "index.html"), "<p>page</p>\n");
    writeFileSync(join(site, "widget-frame.html"), "<p>frame</p>\n");
    writeFileSync(join(site, "home.html"), "<p>home</p>\n");
    writeFileSync(join(site, "404.html"), "<p>missing</p>\n");
    writeFileSync(join(site, "assets/app.js"), "code\n");
  });

  afterEach(() => {
    rmSync(site, { recursive: true, force: true });
  });

  it("takes a site that serves what was attested", () => {
    const answer = run(`served "${site}" ${ADDRESS}`);
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain("serves what was attested");
  });

  it("lists the frame's page, the home and the missing page among what is attested", () => {
    const listed = run(`sums "${site}"`).stdout;
    expect(listed).toContain("widget-frame.html");
    expect(listed).toContain("home.html");
    expect(listed).toContain("404.html");
  });

  it("sees a script Cloudflare adds only for a browser, also on the frame's page", () => {
    const answer = run(`served "${site}" ${ADDRESS}`, { ADDS_SCRIPT: "1" });
    expect(answer.status).toBe(1);
    expect(answer.stdout).toContain("index.html");
    expect(answer.stdout).toContain("widget-frame.html");
    expect(answer.stdout).toContain("home.html");
    expect(answer.stdout).toContain("404.html");
    expect(answer.stdout).not.toContain("app.js");
  });

  it("refuses assets that stopped being cached for good", () => {
    const answer = run(`served "${site}" ${ADDRESS}`, { ASSET_CACHE: "Cache-Control: public, max-age=0" });
    expect(answer.status).toBe(1);
    expect(answer.stdout).toContain("the cache of assets/app.js");
  });

  it("refuses assets served without compression", () => {
    const answer = run(`served "${site}" ${ADDRESS}`, { ASSET_ENCODING: "X-None: 1" });
    expect(answer.status).toBe(1);
    expect(answer.stdout).toContain("the compression of assets/app.js");
  });

  it("does not blame a deploy for a challenge to its runner", () => {
    const answer = run(`served "${site}" ${ADDRESS}`, { ADDS_SCRIPT: "1", MORE_HEADERS: "cf-mitigated: challenge" });
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain("::warning::");
  });

  it("warns if its request no longer gets what a browser gets", () => {
    expect(run(`detects ${ADDRESS}/`, { ADDS_SCRIPT: "1" }).stdout).not.toContain("::warning::");
    const answer = run(`detects ${ADDRESS}/`);
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain("::warning::");
  });

  it("warns when Cloudflare makes browsers prefetch, without failing", () => {
    const answer = run(`served "${site}" ${ADDRESS}`, { MORE_HEADERS: 'Speculation-Rules: "/cdn-cgi/speculation"' });
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain("Speed Brain");
  });
});
