(() => {
  const root = document.documentElement;
  const wanted = navigator.language?.toLowerCase().startsWith("es") ? "es" : "en";
  if (wanted === root.lang) return;
  // The links to English send this site as referrer, so a visitor who chose it is not sent back.
  const chosen = document.referrer.startsWith(`${location.origin}/`);
  if (wanted === "es" && !chosen) location.replace(`/es/${location.search}${location.hash}`);
  else root.dataset.offer = wanted;
})();
