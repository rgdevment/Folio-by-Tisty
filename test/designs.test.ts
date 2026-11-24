import { readFileSync } from "node:fs";
import { CONTRACTS, check } from "@tisty/contracts";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { type DesignsValues, designStyles, type StyleValues, styleTokens } from "../scripts/style-tokens";

const DESIGNS = (CONTRACTS.designs as { values: DesignsValues }).values;
const STYLE = (CONTRACTS.style as { values: StyleValues }).values;
const SHEET = readFileSync("src/page/ui/sheet.css", "utf8");
const FRAME = readFileSync("src/page/ui/frame.ts", "utf8");
const FRAME_CSS = readFileSync("src/page/ui/frame.css", "utf8");
const OWN = designStyles(DESIGNS, STYLE);
const CSS = `${styleTokens(STYLE)}${SHEET}${OWN}`;

type Theme = "light" | "dark";
const THEMES: Theme[] = ["light", "dark"];
const NAMES = ["tisty", "bosque", "coral", "fiordo", "violeta"];
const DRESSED = NAMES.slice(1);
const COLORS = ["sheet", "ink", "soft", "line", "accent", "heading"];
const OF_STYLE = COLORS.slice(0, 5);
const OWN_COLORS = ["blockquote.callout", "figure.code", "figure.diagram", "figure.widget"];

const ACCENT_SOFT: Record<string, Record<Theme, string>> = {
  tisty: { light: "rgb(0 96 227 / 0.08)", dark: "rgb(67 155 255 / 0.11)" },
  bosque: { light: "rgb(47 125 59 / 0.08)", dark: "rgb(127 201 138 / 0.11)" },
  coral: { light: "rgb(185 68 31 / 0.08)", dark: "rgb(255 154 118 / 0.11)" },
  fiordo: { light: "rgb(46 111 134 / 0.08)", dark: "rgb(136 192 208 / 0.11)" },
  violeta: { light: "rgb(124 77 204 / 0.08)", dark: "rgb(203 166 247 / 0.11)" },
};

const THEMED = /light-dark\(((?:rgb\([^)]*\)|[^,()])*),((?:rgb\([^)]*\)|[^,()])*)\)/g;
const inTheme = (theme: Theme): string => CSS.replace(THEMED, theme === "light" ? "$1" : "$2");
const onPaper = (): string => inTheme("light").replaceAll("@media print", "@media all");

const designOf = (name: string): DesignsValues["designs"][string] => {
  const design = DESIGNS.designs[name];
  if (!design) throw new Error(`no design ${name}`);
  return design;
};

const WITH_FALLBACK = /var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?))?\)/g;

// jsdom cascades the custom properties and leaves each var() as it was written.
const drawn = (css: string, html: string): ((selector: string, name: string) => string) => {
  const { document, getComputedStyle } = new JSDOM(`<style>${css}</style>${html}`).window;
  const property = (selector: string, name: string): string =>
    getComputedStyle(document.querySelector(selector) as Element)
      .getPropertyValue(name)
      .trim()
      .replace(/(\d)\/(\d)/g, "$1 / $2");
  const resolved = (selector: string, said: string): string =>
    said.replace(WITH_FALLBACK, (_, name: string, otherwise = "") => {
      const value = property(selector, name);
      return resolved(selector, value === "" || value === "initial" ? otherwise : value);
    });
  return (selector, name) => resolved(selector, property(selector, name));
};

const sheetIn = (design: string, words = ""): string =>
  [
    `<article class="sheet" data-titled data-design="${design}"><h1>t</h1><blockquote class="q"><h2>h</h2></blockquote>`,
    '<table><thead><tr><th>c <a href="#x">a</a></th></tr></thead><tbody><tr><td>f</td></tr></tbody></table>',
    '<blockquote class="callout" data-callout="tip"><h3>n</h3><table><thead><tr><th class="in-note">x</th></tr></thead></table></blockquote>',
    '<figure class="code"></figure><figure class="widget"></figure>',
    `<figure class="diagram"></figure>${words}</article>`,
  ].join("");

describe("the designs of the contract", () => {
  it("are the closed list the page draws", () => {
    expect(Object.keys(DESIGNS.designs)).toEqual(NAMES);
    expect(FRAME).toContain(`["${NAMES.join('", "')}"]`);
  });

  it("are drawn without one of their colours written by hand", () => {
    const written = `${SHEET}${FRAME}${FRAME_CSS}`;
    const colors = DRESSED.flatMap((name) => THEMES.flatMap((theme) => Object.values(designOf(name)[theme])));
    expect(colors.filter((color) => written.includes(color))).toEqual([]);
  });

  it("leave to the frame and to style every colour they do not say", () => {
    expect(OWN).not.toMatch(/--tisty-(rail|desk|hair|hover|hue|pen|mark|cast|idea)[\w-]*:/);
    expect(OWN).not.toContain(":root");
  });

  it("need no theme of their own, so the one of the page is the one of the sheet", () => {
    const said = OWN.match(/--tisty-[\w-]+:(?!initial|var)[^;]+;/g) ?? [];
    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((one) => !one.includes("light-dark("))).toEqual([]);
    expect(OWN).not.toContain("data-theme");
  });

  describe.each(THEMES)("in %s", (theme) => {
    it.each(DRESSED)("%s wears its own colours", (name) => {
      const worn = drawn(inTheme(theme), sheetIn(name));
      const own = designOf(name)[theme];
      for (const color of COLORS) expect(worn(".sheet", `--tisty-${color}`)).toBe(own[color]);
      expect(worn(".sheet", "--tisty-accent-soft")).toBe(ACCENT_SOFT[name]?.[theme]);
      expect(worn(".sheet", "color")).toBe(own.ink);
      expect(worn("h1", "color")).toBe(own.heading);
      expect(worn("h2", "color")).toBe(own.heading);
    });

    it.each(["tisty", "pergamino"])("a sheet that says %s looks as before there were designs", (name) => {
      const worn = drawn(inTheme(theme), sheetIn(name));
      for (const color of OF_STYLE) expect(worn(".sheet", `--tisty-${color}`)).toBe(STYLE.colors[theme][color]);
      expect(worn(".sheet", "--tisty-accent-soft")).toBe(ACCENT_SOFT.tisty?.[theme]);
      expect(worn(".sheet", "font-size")).toBe("15px");
      expect(worn("h2", "color")).toBe("inherit");
      expect(worn("h1", "font-family")).toBe("inherit");
      expect(worn("th", "--design-head")).toBe("");
      expect(worn("th", "print-color-adjust")).toBe("inherit");
    });

    it.each(DRESSED)("what has colours of its own keeps Tisty's in %s", (name) => {
      const worn = drawn(inTheme(theme), sheetIn(name));
      for (const own of OWN_COLORS) {
        for (const color of OF_STYLE) expect(worn(own, `--tisty-${color}`)).toBe(STYLE.colors[theme][color]);
        expect(worn(own, "--tisty-accent-soft")).toBe(ACCENT_SOFT.tisty?.[theme]);
        expect(worn(own, "color")).toBe(STYLE.colors[theme].ink);
      }
      expect(worn(".callout h3", "color")).toBe("inherit");
      expect(worn(".callout h3", "font-family")).toBe("inherit");
      expect(worn(".in-note", "--design-head")).toBe("");
      expect(worn(".in-note", "--tisty-accent")).toBe(STYLE.colors[theme].accent);
      expect(worn("figure.diagram", "font-size")).toBe("15px");
    });
  });

  it.each([
    ["bosque", "rule", 'Georgia,Cambria,"Times New Roman",serif'],
    ["coral", "bar", "inherit"],
    ["fiordo", "rule", "inherit"],
    ["violeta", "bar", "inherit"],
  ])("%s has its type, its title of kind %s and its tinted head", (name, title, headings) => {
    const worn = drawn(inTheme("light"), sheetIn(name));
    const { line, accent, sheet } = designOf(name).light;
    expect(worn(".sheet", "font-size")).toBe("14.5px");
    expect(worn(".sheet", "line-height")).toBe("1.65");
    expect(worn("h2", "font-family").replaceAll(", ", ",")).toBe(headings);
    expect(worn(".sheet", "--design-title")).toBe(title === "bar" ? `4px solid ${accent}` : `1px solid ${line}`);
    expect(worn(".sheet", "--design-head")).toBe(accent);
    expect(worn("th", "color")).toBe(sheet);
    expect(worn("th a", "--tisty-accent")).toBe(sheet);
    expect(worn("td", "--tisty-accent")).toBe(accent);
  });

  it("dress only the title with its border, and only the head with its tint", () => {
    expect(SHEET.match(/var\(--design-title/g)).toHaveLength(1);
    expect(SHEET.match(/var\(--design-head,/g)).toHaveLength(1);
    expect(SHEET).toMatch(/\nthead th \{\s+background: var\(--design-head, var\(--tisty-hover\)\)/);
  });
});

describe("the title of a sheet", () => {
  const onSheet = (words: string, titled = "data-titled", design = "coral"): string =>
    `<article class="sheet" ${titled} data-design="${design}">${words}</article>`;
  const DRESSED_AS_TITLE = "14px";
  const REST = "<p>sigue</p>";

  it.each(["h1", "h2", "h3", "p"])("is its first block when it is a %s, past its tags and properties", (tag) => {
    const title = `<${tag} class="t">t</${tag}>`;
    for (const before of [
      "",
      '<p class="tags">#a</p>',
      '<dl class="front"></dl>',
      '<p class="tags"></p><dl class="front"></dl>',
    ]) {
      const worn = drawn(inTheme("light"), onSheet(`${before}${title}${REST}`));
      expect(worn(".t", "padding-bottom")).toBe(DRESSED_AS_TITLE);
      expect(worn(".t", "font-size")).toBe("23.925px");
      expect(worn(".t", "color")).toBe(designOf("coral").light.heading);
      expect(worn(".sheet > p:last-child", "padding-bottom")).not.toBe(DRESSED_AS_TITLE);
    }
  });

  it.each(NAMES)("is of the kind %s says, whichever block it is", (name) => {
    const { border_bottom } = DESIGNS.titles[designOf(name).title] as { border_bottom: string };
    const [width] = border_bottom.split(" ");
    for (const tag of ["h1", "h2", "h3", "p"]) {
      const css = inTheme("light").replaceAll(
        "var(--design-title, 1px solid var(--tisty-hair))",
        border_bottom.replace(/\S+$/, "red"),
      );
      expect(
        drawn(css, onSheet(`<${tag} class="t">t</${tag}>${REST}`, "data-titled", name))(".t", "border-bottom-width"),
      ).toBe(width);
    }
  });

  it.each(["h4", "ul", "figure", "blockquote"])("is none when the sheet opens with a %s", (tag) => {
    const worn = drawn(inTheme("light"), onSheet(`<${tag}>x</${tag}><p class="t">t</p><h1>otro</h1>${REST}`));
    expect(worn(".t", "padding-bottom")).not.toBe(DRESSED_AS_TITLE);
    expect(worn("h1", "padding-bottom")).not.toBe(DRESSED_AS_TITLE);
  });

  it("is only the first, and no heading further down", () => {
    const worn = drawn(inTheme("light"), onSheet('<p>intro</p><h1 class="t">t</h1><p>a</p>'));
    expect(worn(".t", "padding-bottom")).not.toBe(DRESSED_AS_TITLE);
    expect(worn(".sheet > p:first-child", "padding-bottom")).toBe(DRESSED_AS_TITLE);
  });

  it.each(["doc-card", "file-player"])("is not a paragraph that holds a %s, drawn whole at its own size", (kind) => {
    const worn = drawn(inTheme("light"), onSheet(`<p class="t"><a class="${kind}"></a></p>${REST}`));
    expect(worn(".t", "padding-bottom")).not.toBe(DRESSED_AS_TITLE);
  });

  it("is none in a document without one, nor a note the page itself writes", () => {
    expect(drawn(inTheme("light"), onSheet(`<h1 class="t">t</h1>${REST}`, ""))(".t", "padding-bottom")).not.toBe(
      DRESSED_AS_TITLE,
    );
    const said = onSheet(`<p class="widget-said">x</p>${REST}`);
    expect(drawn(inTheme("light"), said)(".widget-said", "padding-bottom")).not.toBe(DRESSED_AS_TITLE);
    const tags = onSheet(`<p class="tags">#a</p><h1 class="t">t</h1>${REST}`);
    expect(drawn(inTheme("light"), tags)(".tags", "padding-bottom")).not.toBe(DRESSED_AS_TITLE);
  });

  it.each(["h1", "h2", "h3", "p"])("has no margin, padding or border when it is a %s alone on the sheet", (tag) => {
    for (const before of ["", '<p class="tags">#a</p>', '<dl class="front"></dl>']) {
      const worn = drawn(inTheme("light"), onSheet(`${before}<${tag} class="t">t</${tag}>`));
      expect(worn(".t", "padding-bottom")).toBe("0px");
      expect(worn(".t", "margin-bottom")).toBe("0px");
      expect(worn(".t", "font-size")).toBe("23.925px");
    }
  });

  it("is, on paper, only the document's, whichever page is on screen", () => {
    const page = (side: string, name: string) =>
      `<section class="printed-page ${side}" data-titled><p class="tags">#a</p><h1 class="${name}">x</h1><p>y</p></section>`;
    const fromTheDocument = drawn(
      onPaper(),
      onSheet(`<h1 class="t">t</h1>${REST}${page("after", "one")}${page("after", "two")}`),
    );
    expect(
      ["t", "one", "two"].map((name) => fromTheDocument(`.${name}`, "padding-bottom") === DRESSED_AS_TITLE),
    ).toEqual([true, false, false]);
    const fromAPage = drawn(
      onPaper(),
      onSheet(
        `${page("before", "doc")}${page("before", "one")}<p class="tags">#a</p><h1 class="t">t</h1>${REST}${page("after", "two")}`,
      ),
    );
    expect(
      ["doc", "one", "t", "two"].map((name) => fromAPage(`.${name}`, "padding-bottom") === DRESSED_AS_TITLE),
    ).toEqual([true, false, false, false]);
  });

  it("stays alone on its sheet though pages are printed after it", () => {
    const alone = onSheet('<h1 class="t">t</h1><section class="printed-page after"></section>');
    expect(drawn(onPaper(), alone)(".t", "padding-bottom")).toBe("0px");
  });
});

describe("the pages of a document, printed inside its sheet", () => {
  it.each(DRESSED)("wear %s as the document does", (name) => {
    const own = designOf(name).light;
    const page = '<section class="printed-page"><h1>p</h1><table><thead><tr><th>x</th></tr></thead></table></section>';
    const worn = drawn(onPaper(), sheetIn(name, page));
    expect(worn(".printed-page", "--tisty-ink")).toBe(own.ink);
    expect(worn(".printed-page h1", "color")).toBe(own.heading);
    expect(worn(".printed-page th", "color")).toBe(own.sheet);
  });
});

describe("printing with the page in dark", () => {
  it("goes to the light colours, whatever theme was chosen", () => {
    expect(FRAME_CSS).toMatch(/@media print \{\s+:root,\s+:root\[data-theme\] \{\s+color-scheme: light;/);
  });

  it.each(NAMES)("lays %s over white paper, in its light colours", (name) => {
    const worn = drawn(onPaper(), sheetIn(name, '<blockquote class="callout" data-callout="idea"></blockquote>'));
    expect(worn(".sheet", "background-color")).toBe("rgb(255, 255, 255)");
    expect(worn('[data-callout="idea"]', "--tisty-sheet")).toBe("#ffffff");
    expect(worn(".sheet", "--tisty-ink")).toBe(designOf(name).light.ink);
  });

  it("takes the turns of the screen away, since on paper it is the browser that cuts", () => {
    const worn = drawn(onPaper(), sheetIn("coral", '<div class="sheet-turn"></div>'));
    expect(worn(".sheet-turn", "display")).toBe("none");
  });

  it.each(DRESSED)("tints in %s no heading cell out of the head", (name) => {
    const cells =
      '<table><tbody><tr><th class="side">x</th></tr></tbody><tfoot><tr><th class="foot">y</th></tr></tfoot></table>';
    const worn = drawn(onPaper(), sheetIn(name, cells));
    for (const cell of [".side", ".foot"]) {
      expect(worn(cell, "print-color-adjust")).not.toBe("exact");
      expect(worn(cell, "--tisty-ink")).toBe(designOf(name).light.ink);
    }
  });

  it.each(DRESSED)("keeps the tint of %s, or its words would be white over white", (name) => {
    expect(drawn(onPaper(), sheetIn(name))("th", "print-color-adjust")).toBe("exact");
  });
});

describe("the design a sheet says", () => {
  const held = { id: "k7Qm2xPa", html: "<p>x</p>", body: "x" };
  const page = { id: "p1", page_of: "k7Qm2xPa", at: 1, html: "<p>x</p>", body: "x" };

  it.each([...NAMES, "pergamino"])("is taken when it is the word %s", (design) => {
    expect(check("sheet", { design })).toEqual([]);
    expect(check("document", { ...held, sheet: { design }, pages: [{ ...page, sheet: { design } }] })).toEqual([]);
  });

  it.each([3, true, ["bosque"], {}])("refuses its document, or its page's, when it is %j and no word", (design) => {
    expect(check("sheet", { design })).not.toEqual([]);
    expect(check("document", { ...held, sheet: { design } })).not.toEqual([]);
    expect(check("document", { ...held, pages: [{ ...page, sheet: { design } }] })).not.toEqual([]);
  });
});

describe("a contract that does not add up", () => {
  const bosque = designOf("bosque");
  const withBosque = (change: object): DesignsValues => ({
    ...DESIGNS,
    designs: { ...DESIGNS.designs, bosque: { ...bosque, ...change } },
  });

  it.each([
    ["ink", { dark: Object.fromEntries(Object.entries(bosque.dark).filter(([name]) => name !== "ink")) }],
    ["green", { light: { ...bosque.light, accent: "green" } }],
    ["ribbon", { title: "ribbon" }],
    ["zebra", { table: "zebra" }],
    ["mono", { type: { ...bosque.type, text: "mono" } }],
  ])("stops the build over %s instead of drawing half a design", (amiss, change) => {
    expect(() => designStyles(withBosque(change), STYLE)).toThrow(amiss);
  });

  it("stops the build over a colour with no dark", () => {
    const dark = Object.fromEntries(Object.entries(STYLE.colors.dark).filter(([name]) => name !== "rail"));
    expect(() => styleTokens({ ...STYLE, colors: { ...STYLE.colors, dark } })).toThrow("rail");
  });
});

describe("a design that is justified", () => {
  it("is drawn so", () => {
    const justified = { ...designOf("bosque"), type: { ...designOf("bosque").type, align: "justify" as const } };
    expect(designStyles({ ...DESIGNS, designs: { ...DESIGNS.designs, bosque: justified } }, STYLE)).toContain(
      "text-align:justify",
    );
  });
});
