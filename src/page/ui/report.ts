import { LEVEL_ONE, levelOfReport } from "../../core/limits";
import { holdsALink } from "../../core/sealed-link";
import { element } from "./frame";
import { sealContact, sealLink } from "./seal";
import { solved } from "./solve";
import { said } from "./speak";

export interface Reportable {
  id: string;
  linkKey: string;
  operatorKey: string;
  version?: number;
}

interface Sending {
  id: string;
  body: string;
}

const refusalSaid = (refused: string | undefined): string => {
  const { reportQuota, reportSlow, reportCouldNotSend } = said();
  const why: Record<string, string> = { quota: reportQuota, slow: reportSlow };
  return why[refused ?? ""] ?? reportCouldNotSend;
};

const post = ({ id, body }: Sending, proof?: string): Promise<Response> =>
  fetch(`/api/v1/docs/${id}/report`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json", ...(proof === undefined ? {} : { "Folio-Proof": proof }) },
    body,
  });

const refusalIn = async (response: Response): Promise<{ refused?: string; salt?: string; bits?: number }> =>
  response.json().catch(() => ({}));

// It says what went wrong, or null when the report arrived.
const sent = async (sending: Sending): Promise<string | null> => {
  const first = await post(sending);
  if (first.ok) return null;
  const { salt, bits, refused } = await refusalIn(first);
  const answer = salt !== undefined && bits !== undefined ? await post(sending, await solved(salt, bits)) : null;
  if (answer?.ok) return null;
  const lastRefusal = answer ? (await refusalIn(answer)).refused : refused;
  return refusalSaid(lastRefusal);
};

export const offerReport = (shown: () => Reportable): void => {
  const button = element<HTMLButtonElement>("report");
  const dialog = element<HTMLDialogElement>("report-dialog");
  const form = element<HTMLFormElement>("report-form");
  const consent = element<HTMLElement>("report-consent");
  const contactBox = element<HTMLElement>("report-contact");
  const detailOptional = element<HTMLElement>("report-detail-optional");
  const handOver = element<HTMLInputElement>("report-hand-over");
  const handingOverSaid = element<HTMLElement>("report-consent-said");
  const told = element<HTMLElement>("report-said");
  const submit = element<HTMLButtonElement>("report-send");

  const categoryOf = (): string => new FormData(form).get("category")?.toString() ?? "";
  const detailOf = (): string => new FormData(form).get("detail")?.toString().trim() ?? "";
  const contactOf = (): string => new FormData(form).get("contact")?.toString().trim() ?? "";
  const bodyOf = async ({ id, linkKey, operatorKey, version }: Reportable): Promise<string> => {
    const category = categoryOf();
    const detail = detailOf();
    const level = levelOfReport(category);
    const withLink = (level === "grave" || (handOver.checked && level !== "light")) && linkKey !== "";
    const contact = level === "light" || level === null ? "" : contactOf();
    return JSON.stringify({
      category,
      ...(detail === "" ? {} : { detail }),
      ...(version === undefined ? {} : { version }),
      ...(withLink ? { sealedLink: await sealLink(id, linkKey, operatorKey) } : {}),
      ...(contact === "" ? {} : { sealedContact: await sealContact(id, contact, operatorKey) }),
    });
  };

  button.disabled = false;
  button.addEventListener("click", () => dialog.showModal());
  element<HTMLButtonElement>("report-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("change", () => {
    const category = categoryOf();
    const level = levelOfReport(category);
    const wasRequired = handOver.disabled;
    consent.hidden = level === "light" || level === null;
    contactBox.hidden = consent.hidden;
    detailOptional.hidden = !consent.hidden;
    handOver.disabled = level === "grave";
    if (level === "grave") handOver.checked = true;
    else if (wasRequired || consent.hidden) handOver.checked = false;
    const { reportChildAbuse, reportAlwaysOnGrave, reportSealed } = said();
    handingOverSaid.textContent =
      category === "csam" ? reportChildAbuse : level === "grave" ? reportAlwaysOnGrave : reportSealed;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const reportable = shown();
    const { linkKey } = reportable;
    const detail = detailOf();
    if (holdsALink(detail) || (linkKey !== "" && detail.includes(linkKey))) {
      told.textContent = said().reportLinkInDetail;
      return;
    }
    const level = levelOfReport(categoryOf());
    if (level !== "light" && level !== null && detail.length < LEVEL_ONE.reportDetailAtLeast) {
      told.textContent = said().reportDetailNeeded;
      return;
    }
    submit.disabled = true;
    told.textContent = said().reportSending;
    const failed = await bodyOf(reportable)
      .then((body) => sent({ id: reportable.id, body }))
      .catch(() => said().reportCouldNotSend);
    told.textContent = failed ?? said().reportReceived;
    submit.disabled = failed === null;
  });
};
