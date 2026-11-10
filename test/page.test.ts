import { readFileSync } from "node:fs";
import { CONTRACTS, check, checkHtml } from "@tisty/contracts";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../src/page/sample";

const read = (path: string): string => readFileSync(path, "utf8");

interface StyleValues {
  body: { size: string; line_height: number };
  sheet: { padding: string; radius: string };
  headings: { h1: { size: string; weight: number } };
}

const WRANGLER = read("wrangler.toml");
const HEADERS = read("src/page/public/_headers");
const SHEET = read("src/page/ui/sheet.css");
const FRAME = read("src/page/ui/frame.ts");
const HTML = read("src/page/index.html");
const ROBOTS = read("src/page/public/robots.txt");

describe("the sample", () => {
  it("is a document the contract takes, so the frame is built on what will really arrive", () => {
    expect(check("document", SAMPLE)).toEqual([]);
    expect(checkHtml(SAMPLE.html)).toEqual([]);
  });
});

describe("the page's headers", () => {
  const csp = HEADERS.match(/Content-Security-Policy: (.+)/)?.[1] ?? "";

  it("ask nothing of anyone else (decision 7), and let nothing run that is not the page's", () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' blob:");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/https?:|unsafe|\*/);
  });

  it("ask Cloudflare not to change a page, and keep hashed assets for good, compressed", () => {
    const rules = HEADERS.split("\n\n");
    const pages = rules.find((one) => one.startsWith("/*\n")) ?? "";
    const assets = rules.find((one) => one.startsWith("/assets/*\n")) ?? "";
    expect(pages).toContain("no-transform");
    expect(assets).toContain("! Cache-Control");
    expect(assets).toContain("Cache-Control: public, max-age=31536000, immutable");
    expect(assets).not.toContain("no-transform");
  });

  it("keep every one-segment page, a shared document among them, out of search, and never mark the home, whatever order Cloudflare runs the rules in", () => {
    const marking = HEADERS.split("\n\n")
      .filter((one) => one.includes("\n  X-Robots-Tag: noindex"))
      .map((one) => new RegExp(`^${(one.split("\n")[0] ?? "").replaceAll("*", ".*").replace(/:\w+/g, "[^/]+")}$`));
    const marked = (path: string) => marking.some((rule) => rule.test(path));
    for (const path of [
      "/AAAAAAAA",
      "/404",
      "/home",
      "/widget-frame",
      "/robots.txt",
      "/assets/app.js",
      "/domains/ab.json",
    ]) {
      expect(marked(path)).toBe(true);
    }
    expect(marked("/")).toBe(false);
    expect(marked("/en/")).toBe(false);
    expect(HEADERS).not.toContain("! X-Robots-Tag");
    expect(HTML).toContain('<meta name="robots" content="noindex" />');
    expect(ROBOTS.split("\n\n").at(-1)).toBe(
      "User-agent: *\nAllow: /$\nAllow: /en/$\nAllow: /site.css$\nAllow: /icon.svg$\nAllow: /tisto.svg$\nDisallow: /\n",
    );
  });
});

describe("a link pasted where it shows a preview", () => {
  const PREVIEWERS = [
    "Twitterbot",
    "Slackbot",
    "facebookexternalhit",
    "LinkedInBot",
    "Discordbot",
    "WhatsApp",
    "TelegramBot",
  ];
  const meta = (property: string): string | undefined =>
    new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(HTML)?.[1];

  it("lets only the preview bots read the page, and none of them the API", () => {
    const group = ROBOTS.split("\n\n").find((one) => one.includes("User-agent: Twitterbot")) ?? "";
    for (const bot of PREVIEWERS) expect(group).toContain(`User-agent: ${bot}\n`);
    expect(group).toContain("Allow: /\n");
    expect(group).toContain("Disallow: /api/");
  });

  it("shows a card that is the same for every document, in English, with a picture X takes", () => {
    expect(meta("og:title")).toBe("A document shared with Folio by Tisty");
    expect(meta("og:description")).toMatch(/^End-to-end encrypted, it expires on its own\./);
    expect(meta("og:site_name")).toBe("Folio by Tisty");
    expect(meta("og:image")).toBe("https://tisty.cl/preview.png");
    expect(meta("twitter:card")).toBe("summary_large_image");
    const png = readFileSync("src/page/public/preview.png");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it("says nothing of the document, which only the reader's browser ever opens", () => {
    expect(meta("og:url")).toBeUndefined();
    expect(FRAME).not.toMatch(/og:|twitter:/);
  });
});

describe("what the page loads", () => {
  it("carries Tisty's icon and mascot itself, because the CSP lets no image come from anywhere else", () => {
    for (const file of ["icon.svg", "tisto.svg"]) {
      expect(HTML).toContain(`"/${file}"`);
      expect(read(`src/page/public/${file}`)).toContain("<svg");
    }
  });

  it("is all its own: no font, script or image of anyone else", () => {
    expect(HTML).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
    expect(SHEET).not.toMatch(/url\(|@import/);
    expect(read("src/page/ui/frame.css")).not.toMatch(/url\(|@import/);
  });
});

describe("the theme", () => {
  it("is settled before anything is painted, from a file of the page's own that the CSP lets run", () => {
    const script = '<script src="/theme.js">';
    expect(HTML).toContain(script);
    expect(HTML.indexOf(script)).toBeLessThan(HTML.indexOf('<script type="module"'));
  });

  it("is kept under one name, on both sides of the first paint", () => {
    const name = read("src/page/ui/theme.ts").match(/CHOSEN = "(.+)"/)?.[1] ?? "no name";
    expect(read("src/page/public/theme.js")).toContain(`"${name}"`);
  });
});

describe("opening a link", () => {
  const main = read("src/page/ui/main.ts");

  it("asks for the envelope before loading the code that reads it", () => {
    expect(main).toContain('import { askFor } from "./ask"');
    expect(main).not.toMatch(/from "\.\/(frame|show|clean)"/);
    expect(main.indexOf("askFor(id)")).toBeLessThan(main.indexOf('import("./show")'));
  });

  it("says something even when the code that reads it could not load", () => {
    expect(main).toContain('from "./closed"');
    expect(main).toMatch(/opening\([^)]*\)[^;]*\.catch/);
  });
});

describe("the movement of the page", () => {
  it("is left to the stylesheet when jumping, so asking for none stops that too", () => {
    expect(FRAME).toContain("scrollIntoView({ block");
    expect(FRAME).not.toMatch(/scrollIntoView\([^)]*smooth/);
  });
});

describe("the foot of the page", () => {
  it("promises nothing about a document that did not open", () => {
    expect(HTML).toContain('class="page-foot-promise"');
    expect(read("src/page/ui/frame.css")).toMatch(/\[data-state="closed"\] \.page-foot-promise \{\s+display: none;/);
  });
});

describe("who edited it", () => {
  it("shows an editor's tag only for the maker, and its warning only for a name that imitates it", () => {
    expect(HTML).toContain('<template id="editor">');
    expect(read("src/page/ui/frame.css")).toMatch(
      /\.editors li:not\(\[data-standing="verified"\]\) \.name-tag,\s+\.editors li:not\(\[data-standing="imitates"\]\) \.fact-note \{\s+display: none;/,
    );
  });
});

describe("a language its owner has not reviewed", () => {
  it("says so on screen, and not on paper, which carries only the document", () => {
    expect(HTML).toContain('id="unreviewed"');
    expect(read("src/page/ui/frame.css")).toMatch(/@media print[\s\S]*\.loading,\s+\.unreviewed,\s+\.pages-card,/);
  });
});

describe("the button that hands a link to Tisty", () => {
  it("writes the address as the contract's own example does, with the # of the key encoded", () => {
    const { link, address } = (CONTRACTS.link as { values: { edit_example: { link: string; address: string } } }).values
      .edit_example;
    expect(`tisty://edit?link=${encodeURIComponent(link)}`).toBe(address);
    expect(FRAME).toContain("tisty://edit?link=${encodeURIComponent(location.href)}");
  });
});

describe("the panels", () => {
  it("say the verdict once, in the bar, outside the document", () => {
    expect(HTML).toContain('id="seal-text"');
    expect(HTML).not.toContain('id="verdict"');
  });

  it("scroll with the page, with no second scrollbar of their own", () => {
    const panels = read("src/page/ui/frame.css").match(/\.panels \{[^}]*\}/g) ?? [];
    expect(panels.length).toBeGreaterThan(0);
    for (const rule of panels) expect(rule).not.toMatch(/overflow|max-height: calc/);
  });

  it("put the index right after the actions", () => {
    const at = (id: string) => HTML.indexOf(id);
    expect(at("panel-actions")).toBeLessThan(at('id="panel-index"'));
    expect(at('id="panel-index"')).toBeLessThan(at('id="panel-paper"'));
    expect(at('id="panel-paper"')).toBeLessThan(at('id="panel-details"'));
  });

  it("keep who signed it and how to check it in the details", () => {
    const details = HTML.slice(HTML.indexOf('id="panel-details"'), HTML.indexOf('class="foot"'));
    expect(details).toContain('id="signer"');
    expect(details).toContain('id="fingerprint"');
    expect(details).toContain('data-say="howToCheck"');
  });

  it("say in the details only what the sheet does not already say", () => {
    expect(FRAME).not.toContain('"Título"');
    expect(FRAME).not.toContain('"Etiquetas"');
    expect(HTML.slice(HTML.indexOf('id="panel-details"'))).toContain('id="dies-on"');
  });

  it("start the index after the title, which is already the first thing on the sheet", () => {
    expect(FRAME).toContain("headings[0]?.textContent === held.title");
  });
});

describe("the assets in the Worker", () => {
  it("do not wake it: only the API runs it first, so a visit to the page costs no request", () => {
    expect(WRANGLER).toContain('run_worker_first = ["/api/*"]');
    expect(WRANGLER).toContain('not_found_handling = "single-page-application"');
    expect(WRANGLER).toContain('directory = "./dist/page"');
  });
});

describe("the contract's numbers", () => {
  const style = (CONTRACTS.style as { values: StyleValues }).values;
  const sheet = (CONTRACTS.sheet as { values: Record<string, unknown> }).values;

  it("keep a diagram no wider than the sheet", () => {
    expect(SHEET).toMatch(/figure\.diagram svg \{\s+max-width: 100%;/);
  });

  it("are the ones the sheet's CSS writes", () => {
    expect(SHEET).toContain(`font-size: ${style.body.size}`);
    expect(SHEET).toContain(`line-height: ${style.body.line_height}`);
    expect(SHEET).toContain(`padding: ${style.sheet.padding}`);
    expect(SHEET).toContain(`border-radius: ${style.sheet.radius}`);
    expect(SHEET).toContain(`font-size: ${style.headings.h1.size}`);
    expect(SHEET).toContain(`font-weight: ${style.headings.h1.weight}`);
  });

  it("are the ones the paper panel works with", () => {
    const papers = sheet.millimetres as Record<string, number[]>;
    for (const [paper, [short, long]] of Object.entries(papers)) {
      expect(FRAME).toContain(`${paper}: [${short}, ${long}]`);
    }
    const margins = sheet.margin_millimetres as { x: number; y: number };
    expect(FRAME).toContain(`x: ${margins.x}, y: ${margins.y}`);
    expect(FRAME).toContain(`LONG_PAGE_WIDTH_PIXELS = ${sheet.long_page_width_pixels}`);
    expect(FRAME).toContain(`PIXELS_PER_INCH = ${sheet.pixels_per_inch}`);
  });

  it("offer the papers it says to offer", () => {
    for (const paper of sheet.offered as string[]) expect(HTML).toContain(`data-paper="${paper}"`);
  });
});
