import "virtual:tisty-tokens.css";
import "./frame.css";
import { keyOfFragment } from "../link";
import { askFor } from "./ask";
import { drawClosed } from "./closed";
import { offerThemes } from "./theme";

const ID_PATH = /^\/[A-Za-z0-9]{8}$/;
const NOT_FOUND = "https://www.tisty.app/404";
const COULD_NOT_OPEN = "No se pudo abrir el documento. Recarga la página para volver a intentarlo.";

const showSample = async (): Promise<void> => {
  const [{ SAMPLE, SAMPLE_SEAL }, { drawFrame }, { domPurifyCleaner }] = await Promise.all([
    import("../sample"),
    import("./frame"),
    import("./clean"),
  ]);
  const cleaner = domPurifyCleaner(window);
  drawFrame(SAMPLE, (html) => cleaner.clean(html), SAMPLE_SEAL);
};

const showAsked = async (id: string): Promise<void> => {
  // Asked first, and the rest of the code after, so neither waits for the other.
  const asked = askFor(id);
  const { showLink } = await import("./show");
  await showLink(id, keyOfFragment(location.hash.slice(1)), asked, NOT_FOUND);
};

offerThemes();

if (import.meta.env.MODE !== "production") {
  await showSample();
} else if (ID_PATH.test(location.pathname)) {
  // Here and not further in: the code that failed may be the code that would have said so.
  await showAsked(location.pathname.slice(1)).catch((error: unknown) => {
    console.error(error);
    drawClosed(COULD_NOT_OPEN);
  });
} else {
  location.replace(NOT_FOUND);
}
