// Runs before the first paint, so a visitor never sees the other language flash.
(() => {
  const STORED = "language";
  const root = document.documentElement;

  const show = (language) => {
    root.lang = language;
    root.dataset.shown = language;
    for (const button of document.querySelectorAll("[data-language]")) {
      button.setAttribute("aria-pressed", String(button.dataset.language === language));
    }
  };

  const chosen = () => {
    try {
      return localStorage.getItem(STORED);
    } catch {
      return null;
    }
  };

  const keep = (language) => {
    try {
      localStorage.setItem(STORED, language);
    } catch {}
  };

  const held = chosen();
  const browser = navigator.language?.toLowerCase().startsWith("es") ? "es" : "en";
  const language = held === "es" || held === "en" ? held : browser;
  show(language);

  document.addEventListener("DOMContentLoaded", () => {
    show(root.dataset.shown);
    for (const button of document.querySelectorAll("[data-language]")) {
      button.addEventListener("click", () => {
        show(button.dataset.language);
        keep(button.dataset.language);
      });
    }
  });
})();
