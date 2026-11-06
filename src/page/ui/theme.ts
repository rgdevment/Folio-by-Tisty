type Theme = "light" | "dark";

// The key and values www.tisty.app uses, and the key public/theme.js reads before anything is painted.
const CHOSEN = "theme";
const DARK = "(prefers-color-scheme: dark)";

// A browser that keeps nothing still reads: the choice just lasts until the page is closed.
const keep = (change: (kept: Storage) => void): void => {
  try {
    change(localStorage);
  } catch {}
};

export const offerThemes = (): void => {
  const root = document.documentElement;
  const system = matchMedia(DARK);
  const toggle = document.getElementById("theme") as HTMLButtonElement;
  const sheet = document.getElementById("sheet") as HTMLElement;

  const ofSystem = (): Theme => (system.matches ? "dark" : "light");
  const shown = (): Theme => (root.dataset.theme as Theme | undefined) ?? ofSystem();

  const draw = (): void => {
    const theme = shown();
    // The sheet's shadow root cannot see the page's root, and a diagram travels in one drawing per theme.
    sheet.dataset.theme = theme;
    const offer = theme === "dark" ? "Usar el modo claro" : "Usar el modo oscuro";
    toggle.setAttribute("aria-label", offer);
    toggle.title = offer;
  };

  // Only what differs from the system is kept, so going back to its theme also goes back to following it.
  const choose = (theme: Theme): void => {
    if (theme === ofSystem()) {
      delete root.dataset.theme;
      keep((kept) => kept.removeItem(CHOSEN));
    } else {
      root.dataset.theme = theme;
      keep((kept) => kept.setItem(CHOSEN, theme));
    }
    draw();
  };

  toggle.addEventListener("click", () => {
    const theme = shown() === "dark" ? "light" : "dark";
    const change = (): void => choose(theme);
    if ("startViewTransition" in document) document.startViewTransition(change);
    else change();
  });
  system.addEventListener("change", draw);
  draw();
};
