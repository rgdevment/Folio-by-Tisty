type Theme = "light" | "dark";
type Themed<T> = Record<Theme, T>;
type Colors = Record<string, string>;

interface Idea {
  fill: Themed<Colors>;
  ink: Themed<string>;
  pins: Themed<string[]>;
  tape: Themed<string>;
}

export interface StyleValues {
  colors: Themed<Colors>;
  callouts: { idea: Idea };
  text_font: string[];
  body: { size: string };
}

interface Design extends Themed<Colors> {
  type: { text: string; headings: string; size: string; line_height: number; align: "left" | "justify" };
  title: string;
  table: string;
}

export interface DesignsValues {
  default: string;
  colors: { said: string[]; accent_soft_percent: Themed<number> };
  fonts: Record<string, string | string[]>;
  titles: Record<string, { border_bottom: string }>;
  tables: Record<string, string | { head: { color: string; background: string } }>;
  designs: Record<string, Design>;
}

const variables = ({ light, dark }: Themed<Colors>): string =>
  Object.entries(light)
    .map(([name, value]) => {
      const night = dark[name];
      if (night === undefined) throw new Error(`the contract gives --tisty-${name} no dark colour`);
      return `--tisty-${name}:light-dark(${value},${night});`;
    })
    .join("");

const ideaColors = ({ fill, ink, pins, tape }: Idea, theme: Theme): Colors => ({
  ...Object.fromEntries(Object.entries(fill[theme]).map(([hue, value]) => [`idea-${hue}`, value])),
  ...Object.fromEntries(pins[theme].map((value, at) => [`idea-pin-${at}`, value])),
  "idea-ink": ink[theme],
  "idea-tape": tape[theme],
});

export const styleTokens = ({ colors, callouts }: StyleValues): string =>
  `:root{${variables({
    light: { ...colors.light, ...ideaColors(callouts.idea, "light") },
    dark: { ...colors.dark, ...ideaColors(callouts.idea, "dark") },
  })}}`;

const named = <T>(all: Record<string, T>, name: string): T => {
  const one = all[name];
  if (one === undefined) throw new Error(`the contract names ${name} and does not say it`);
  return one;
};

const sheer = (hex: string, percent: number): string => {
  const said = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (!said) throw new Error(`the contract's accent ${hex} is no #rrggbb`);
  const [red, green, blue] = said.slice(1).map((part) => Number.parseInt(part, 16));
  return `rgb(${red} ${green} ${blue} / ${percent / 100})`;
};

const themed = (design: Design, theme: Theme, { said, accent_soft_percent }: DesignsValues["colors"]): Colors => {
  const colors = design[theme];
  const own = Object.fromEntries(said.map((name) => [name, named(colors, name)]));
  return { ...own, "accent-soft": sheer(named(colors, "accent"), accent_soft_percent[theme]) };
};

const colorsOf = (design: Design, said: DesignsValues["colors"]): Themed<Colors> => ({
  light: themed(design, "light", said),
  dark: themed(design, "dark", said),
});

const stack = (fonts: string[]): string => fonts.map((font) => (/\s/.test(font) ? `"${font}"` : font)).join(",");

const fontOf = (name: string, { fonts }: DesignsValues, { text_font }: StyleValues): string => {
  const said = named(fonts, name);
  return stack(typeof said === "string" ? text_font : said);
};

const border = (said: string): string => said.replace(/\S+$/, (color) => `var(--tisty-${color})`);

const headOf = (design: Design, { tables }: DesignsValues): { color: string; background: string } | null => {
  const said = named(tables, design.table);
  return typeof said === "string" ? null : said.head;
};

const worn = (design: Design, designs: DesignsValues, style: StyleValues): string => {
  const { text, headings, size, line_height, align } = design.type;
  const head = headOf(design, designs);
  return [
    `--design-headings:${headings === text ? "initial" : fontOf(headings, designs, style)};`,
    `--design-title:${border(named(designs.titles, design.title).border_bottom)};`,
    `--design-head:${head ? `var(--tisty-${head.background})` : "initial"};`,
    `--design-head-ink:${head ? `var(--tisty-${head.color})` : "initial"};`,
    `--design-head-print:${head ? "exact" : "initial"};`,
    "color:var(--tisty-ink);",
    `font-family:${fontOf(text, designs, style)};`,
    `font-size:${size};`,
    `line-height:${line_height};`,
    `text-align:${align === "left" ? "start" : align};`,
  ].join("");
};

const OWN_COLORS = ":is(blockquote.callout,figure.code,figure.diagram,figure.widget)";
const UNDESIGNED = ["tisty-heading", "design-headings", "design-head", "design-head-ink", "design-head-print"]
  .map((name) => `--${name}:initial;`)
  .join("");

// What a head holds in colours of its own would be lost over the accent.
const headWords = (selector: string, { color }: { color: string }): string =>
  `${selector} thead th:not(${OWN_COLORS} th){${["accent", "ink", "soft", "faint"]
    .filter((name) => name !== color)
    .map((name) => `--tisty-${name}:var(--tisty-${color});`)
    .join("")}}`;

const designRules = (name: string, design: Design, designs: DesignsValues, style: StyleValues): string => {
  const selector = `[data-design="${name}"]`;
  const head = headOf(design, designs);
  return [
    `${selector}{${variables(colorsOf(design, designs.colors))}${worn(design, designs, style)}}`,
    `${selector} figure.diagram{font-size:${style.body.size};}`,
    head ? headWords(selector, head) : "",
  ].join("");
};

// The default wears what style says, so it has rules only for what keeps its colours inside another.
const defaultRules = (design: Design, { colors }: DesignsValues): string =>
  `${OWN_COLORS}{${variables(colorsOf(design, colors))}${UNDESIGNED}}`;

export const designStyles = (designs: DesignsValues, style: StyleValues): string =>
  Object.entries(designs.designs)
    .map(([name, design]) =>
      name === designs.default ? defaultRules(design, designs) : designRules(name, design, designs, style),
    )
    .join("");
