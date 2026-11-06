import { CONTRACTS } from "@tisty/contracts";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../src/page/sample";
import { domPurifyCleaner } from "../src/page/ui/clean";
import { finished } from "../src/page/ui/finish";

interface HtmlCase {
  says: string;
  html: string;
  holds: boolean;
}

const CASES = (CONTRACTS.document as unknown as { html_cases: HtmlCase[] }).html_cases;

const { window } = new JSDOM("<!doctype html><body></body>");
const place = window as unknown as Window & typeof globalThis;
const cleaner = domPurifyCleaner(place);

const parsed = (html: string): DocumentFragment => {
  const template = window.document.createElement("template");
  template.innerHTML = html;
  return template.content;
};

const shapeOf = (words: DocumentFragment): string[] =>
  [...words.querySelectorAll("*")].map((one) => {
    const attributes = [...one.attributes]
      .filter(({ name }) => name !== "style")
      .map(({ name, value }) => `${name}=${value}`)
      .sort();
    return `${one.nodeName.toLowerCase()} ${attributes.join(" ")}`;
  });

const FORBIDDEN_TAGS = "script, iframe, object, embed, foreignObject, style, form, input, base, meta, link";
const NOT_AN_ADDRESS = /^\s*(javascript|data|vbscript|file):/i;

const expectHarmless = (words: DocumentFragment): void => {
  expect(words.querySelector(FORBIDDEN_TAGS)).toBeNull();
  for (const node of words.querySelectorAll("*")) {
    for (const { name, value } of node.attributes) {
      expect(name.startsWith("on"), `${name} on ${node.nodeName}`).toBe(false);
      if (["href", "src", "cite"].includes(name)) expect(value).not.toMatch(NOT_AN_ADDRESS);
      if (value.includes("url(")) expect(value).toMatch(/^\s*url\(#[^\s()]+\)\s*$/i);
    }
  }
};

describe("the cleaner, against the contract's own HTML", () => {
  const holding = CASES.filter((one) => one.holds);
  const refused = CASES.filter((one) => !one.holds);

  it("has samples of both kinds to work with", () => {
    expect(holding.length).toBeGreaterThan(10);
    expect(refused.length).toBeGreaterThan(10);
  });

  it.each(holding.map((one) => [one.says, one.html]))("changes nothing of what holds: %s", (_says, html) => {
    expect(shapeOf(cleaner.clean(html as string))).toEqual(shapeOf(parsed(html as string)));
  });

  it.each(refused.map((one) => [one.says, one.html]))("leaves nothing harmful of what fails: %s", (_says, html) => {
    expectHarmless(cleaner.clean(html as string));
  });

  it("keeps the sample whole", () => {
    expect(shapeOf(cleaner.clean(SAMPLE.html))).toEqual(shapeOf(parsed(SAMPLE.html)));
  });
});

describe("the cleaner, where a browser reads HTML otherwise", () => {
  it.each([
    ["a script hidden by nesting", '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">'],
    [
      "a title that closes itself",
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
    ],
    ["a noscript that opens", '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
    ["a link hidden by a tab", '<a href="java\tscript:alert(1)">a</a>'],
    ["a link hidden by a line", '<a href="java\nscript:alert(1)">a</a>'],
    ["a link hidden by an entity", '<a href="javascript&colon;alert(1)">a</a>'],
    ["a picture written into the page", '<img src="data:image/svg+xml,<svg onload=alert(1)>">'],
    ["a base that moves every address", '<base href="https://a.example/"><a href="x">a</a>'],
    ["a form that steals", '<form action="https://a.example"><input name="key"></form>'],
    ["a link in a drawing", '<svg><a href="javascript:alert(1)"><text>a</text></a></svg>'],
    ["a paint from elsewhere", '<svg><path d="M0 0" fill="url(https://a.example/x)"></path></svg>'],
  ])("takes out %s", (_says, html) => {
    expectHarmless(cleaner.clean(html));
  });

  it("takes out a reference that is not one, as the contract reads it", () => {
    const words = cleaner.clean(
      '<a href="tisty:page/x">a</a><a href="tisty:other/1">b</a><a href="TISTY:page/1">c</a>',
    );
    expect([...words.querySelectorAll("a")].map((one) => one.getAttribute("href"))).toEqual([
      null,
      null,
      "TISTY:page/1",
    ]);
  });

  it("does not leave a class the contract does not know", () => {
    const words = cleaner.clean('<div class="table sheet bar">a</div>');
    expect(words.querySelector("div")?.getAttribute("class")).toBe("table");
  });

  it("keeps an attribute only on the tag that may have it", () => {
    const words = cleaner.clean('<h1 id="a">a</h1><dd id="b">b</dd>');
    expect(words.querySelector("h1")?.id).toBe("a");
    expect(words.querySelector("dd")?.hasAttribute("id")).toBe(false);
  });

  it("keeps a heading named as something the document has", () => {
    const words = cleaner.clean('<h2 id="title">a</h2><h2 id="location">b</h2>');
    expect([...words.querySelectorAll("h2")].map((one) => one.id)).toEqual(["title", "location"]);
  });

  it("forgets its work between one clean and the next", () => {
    cleaner.clean('<td style="text-align: left">a</td>');
    expect(shapeOf(cleaner.clean("<p>a</p>"))).toEqual(["p "]);
  });
});

describe("what the contract says of styles", () => {
  const styleOf = (html: string, tag: string) =>
    (cleaner.clean(`<table><colgroup>${html}</colgroup></table>`).querySelector(tag) as HTMLElement).style;

  it("is set by hand, so the page's CSP never meets a style attribute", () => {
    const adopt = window.document.adoptNode.bind(window.document);
    const asAdopted: (string | null)[] = [];
    window.document.adoptNode = (node: DocumentFragment) => {
      asAdopted.push(node.querySelector("col")?.getAttribute("style") ?? null);
      return adopt(node);
    };
    const style = styleOf('<col style="width: 120px">', "col");
    window.document.adoptNode = adopt;
    expect(asAdopted).toEqual([null]);
    expect(style.getPropertyValue("width")).toBe("120px");
  });

  it("is all that gets through", () => {
    const style = styleOf('<col style="width: 120px; position: fixed; width: calc(1px)">', "col");
    expect(style.getPropertyValue("position")).toBe("");
    expect(style.getPropertyValue("width")).toBe("120px");
  });
});

describe("the finishing touches", () => {
  const PNG = "blob:picture-0";

  it("give a picture its address, and leave one that failed without any", () => {
    const words = finished(
      cleaner.clean(
        '<img src="tisty:picture/0" alt="a" width="1" height="1"><img src="tisty:picture/1" alt="b" width="1" height="1">',
      ),
      [PNG, null],
    );
    const [held, failed] = words.querySelectorAll("img");
    expect(held?.getAttribute("src")).toBe(PNG);
    expect(failed?.hasAttribute("src")).toBe(false);
    expect(failed?.getAttribute("alt")).toBe("b");
  });

  it("never draw a picture from anywhere else (decision 7)", () => {
    const words = finished(cleaner.clean('<img src="https://a.example/x.png" alt="a">'), []);
    expect(words.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  it("leave a file's link as its words, since nothing can ask for it yet", () => {
    const link = finished(cleaner.clean('<a href="tisty:file/0">Cartilla</a>'), []).querySelector("a");
    expect(link?.hasAttribute("href")).toBe(false);
    expect(link?.textContent).toBe("Cartilla");
  });

  it("send what leaves to another tab, telling it nothing", () => {
    const words = finished(cleaner.clean('<a href="https://a.example">a</a><a href="#b">b</a>'), []);
    const [out, inside] = words.querySelectorAll("a");
    expect(out?.getAttribute("target")).toBe("_blank");
    expect(out?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(inside?.hasAttribute("target")).toBe(false);
  });
});
