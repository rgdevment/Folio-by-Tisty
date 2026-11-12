(() => {
  const SHOWN_FOR = 7000;
  const box = document.querySelector(".situations");
  if (!box || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // On a touch screen a tap leaves :hover behind until the next tap, which would stop the round for good.
  const hovers = matchMedia("(hover: hover)").matches;
  const situations = [...box.children];
  let at = 0;
  let left = situations.length;
  const turn = setInterval(() => {
    if (document.hidden || (hovers && box.matches(":hover"))) return;
    situations[at].setAttribute("aria-hidden", "true");
    at = (at + 1) % situations.length;
    situations[at].removeAttribute("aria-hidden");
    left -= 1;
    if (left === 0) clearInterval(turn);
  }, SHOWN_FOR);
})();
