import { element } from "./frame";
import { said } from "./speak";

export type Desktop = "windows" | "mac";

export interface Platform {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
}

const DOWNLOADS: Record<Desktop, string> = {
  windows: "https://apps.microsoft.com/detail/9PGVWXD8X93N",
  mac: "https://github.com/rgdevment/Tisty/releases/latest",
};
const HANDHELD = /android|iphone|ipad|ipod|cros/i;

export const desktopOf = ({
  userAgentData,
  platform = "",
  userAgent = "",
  maxTouchPoints = 0,
}: Platform): Desktop | null => {
  const named = userAgentData?.platform || platform;
  if (HANDHELD.test(`${named} ${userAgent}`)) return null;
  if (/^win/i.test(named)) return "windows";
  // An iPad asks for the desktop site by calling itself a Mac, and only its touch gives it away.
  if (/^mac/i.test(named)) return maxTouchPoints > 1 ? null : "mac";
  return null;
};

const drawWays = (desktop: Desktop | null): void => {
  const { notOpened, onlyDesktop, getOnWindows, getOnMac } = said();
  const get = element<HTMLAnchorElement>("get-tisty");
  get.hidden = desktop === null;
  if (desktop) {
    get.href = DOWNLOADS[desktop];
    get.textContent = desktop === "windows" ? getOnWindows : getOnMac;
  }
  element("opening-said").hidden = desktop === null;
  element("not-opened").textContent = desktop ? notOpened : onlyDesktop;
  element("open-again").hidden = desktop === null;
};

export const offerTisty = (edit: HTMLAnchorElement, desktop: Desktop | null): void => {
  const notice = element("opening-tisty");
  let leftForTheApp = false;
  const close = (): void => {
    notice.hidden = true;
    leftForTheApp = false;
  };
  const closeOnComingBackFromTheApp = (): void => {
    if (leftForTheApp) close();
  };
  edit.addEventListener("click", (event) => {
    if (desktop === null) event.preventDefault();
    leftForTheApp = false;
    drawWays(desktop);
    notice.hidden = false;
  });
  element("open-again").addEventListener("click", () => edit.click());
  element("opening-tisty-close").addEventListener("click", close);
  addEventListener("blur", () => {
    leftForTheApp = !notice.hidden;
  });
  addEventListener("focus", closeOnComingBackFromTheApp);
};
