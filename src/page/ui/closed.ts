// Apart from the frame, because it has to work when the frame's code could not be loaded.
export const drawClosed = (said: string): void => {
  const text = document.getElementById("loading-text");
  if (text) text.textContent = said;
  document.body.dataset.state = "closed";
};
