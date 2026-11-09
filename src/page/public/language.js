// Runs before the first paint, so a visitor never sees the other language flash.
(() => {
  const root = document.documentElement;

  const show = (language) => {
    root.lang = language;
    root.dataset.shown = language;
    for (const button of document.querySelectorAll("[data-language]")) {
      button.setAttribute("aria-pressed", String(button.dataset.language === language));
    }
  };

  show(navigator.language?.toLowerCase().startsWith("es") ? "es" : "en");

  document.addEventListener("DOMContentLoaded", () => {
    show(root.dataset.shown);
    for (const button of document.querySelectorAll("[data-language]")) {
      button.addEventListener("click", () => show(button.dataset.language));
    }
  });
})();
