(() => {
  const root = document.documentElement;
  const wanted = navigator.language?.toLowerCase().startsWith("es") ? "es" : "en";
  if (wanted !== root.lang) root.dataset.offer = wanted;
})();
