import {
  type CampaignEmailLayout,
  campaignEmailLayoutSchema,
  campaignEmailLayoutText,
} from "@sob/contracts";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

function renderEmailLayout(
  layout: CampaignEmailLayout,
  renderText: (text: string) => string,
  replace: (text: string) => string,
  bookingHref: string,
  headerCid: string,
) {
  const preheader = layout.preheader
    ? `<div aria-hidden="true" style="display:none;max-height:0;overflow:hidden">${escapeHtml(replace(layout.preheader))}</div>`
    : "";
  const header = layout.heading
    ? `<header style="padding:24px;background:#f8edf2;color:#321223"><h1 style="margin:0;font-size:26px">${renderText(layout.heading)}</h1></header>`
    : "";
  const image = layout.headerImage
    ? `<img src="cid:${headerCid}" width="600" alt="${escapeHtml(layout.headerImage.alt)}" style="width:100%;height:auto;display:block">`
    : "";
  const blocks = layout.blocks.map((block) => {
    if (block.kind === "heading")
      return `<h2 style="font-size:20px">${renderText(block.text)}</h2>`;
    if (block.kind === "booking")
      return `<p><a href="${bookingHref}" style="display:inline-block;padding:12px 18px;background:#70264d;color:#fff;border-radius:6px">${escapeHtml(replace(block.label))}</a></p>`;
    const text = renderText(block.text);
    const content =
      block.emphasis === "strong"
        ? `<strong>${text}</strong>`
        : block.emphasis === "italic"
          ? `<em>${text}</em>`
          : text;
    return `<p>${content}</p>`;
  });
  return `${preheader}<div style="max-width:600px;margin:auto;font:16px/1.5 Arial,sans-serif">${image}${header}<div style="padding:16px 24px">${blocks.join("")}</div></div>`;
}

export function renderCampaignMessage(input: {
  messageId: string;
  subject: string;
  emailBody: string;
  emailLayout?: unknown;
  smsBody: string;
  name: string;
  firstName?: string;
  salonName: string;
  bookingUrl: string;
  unsubscribeUrl: string | null;
  reviewUrl?: string;
}) {
  const replace = (text: string) =>
    text.replace(/\{\{(first_name|salon_name|booking_url)\}\}/g, (_, key: string) =>
      key === "first_name"
        ? input.firstName || input.name
        : key === "salon_name"
          ? input.salonName
          : input.bookingUrl,
    );
  const layout =
    input.emailLayout == null ? null : campaignEmailLayoutSchema.parse(input.emailLayout);
  const headerCid = `campaign-header.${input.messageId}@citame.app`;
  const body = replace(layout ? campaignEmailLayoutText(layout) : input.emailBody);
  const bookingHref = escapeHtml(input.bookingUrl);
  const renderText = (text: string) =>
    text
      .split("{{booking_url}}")
      .map((part) => escapeHtml(replace(part)).replace(/\n/g, "<br>"))
      .join(`<a href="${bookingHref}">${bookingHref}</a>`);
  const htmlBody = layout
    ? renderEmailLayout(layout, renderText, replace, bookingHref, headerCid)
    : `<p>${renderText(input.emailBody)}</p>`;
  const reviewText = input.reviewUrl ? `\n\n${input.reviewUrl}` : "";
  const reviewLink = input.reviewUrl
    ? `<p><a href="${escapeHtml(input.reviewUrl)}">${escapeHtml(input.reviewUrl)}</a></p>`
    : "";
  const unsubscribeText = input.unsubscribeUrl ?? "Preview link · Enlace de prueba";
  const unsubscribe = input.unsubscribeUrl
    ? `<a href="${escapeHtml(input.unsubscribeUrl)}">Unsubscribe / Darse de baja</a>`
    : "Unsubscribe / Darse de baja · Preview link / Enlace de prueba";
  return {
    subject: replace(input.subject).replace(/[\r\n]/g, " "),
    text: `${body}${reviewText}\n\nUnsubscribe / Darse de baja: ${unsubscribeText}`,
    html: `<!doctype html><html><body>${htmlBody}${reviewLink}<p>${unsubscribe}</p></body></html>`,
    ...(layout?.headerImage && {
      inlineJpeg: { cid: headerCid, imageBase64: layout.headerImage.imageBase64 },
    }),
    sms: `${replace(input.smsBody)}\n${unsubscribeText}`,
  };
}
