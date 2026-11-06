// Runs before the first paint, so a reader who chose a theme never sees the other one flash.
try {
  const chosen = localStorage.getItem("theme");
  if (chosen === "light" || chosen === "dark") document.documentElement.dataset.theme = chosen;
} catch {}
