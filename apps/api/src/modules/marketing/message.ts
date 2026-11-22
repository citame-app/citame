const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

export function renderCampaignMessage(input: {
  subject: string;
  emailBody: string;
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
  const body = replace(input.emailBody);
  const bookingHref = escapeHtml(input.bookingUrl);
  const htmlBody = input.emailBody
    .split("{{booking_url}}")
    .map((part) => escapeHtml(replace(part)).replace(/\n/g, "<br>"))
    .join(`<a href="${bookingHref}">${bookingHref}</a>`);
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
    html: `<!doctype html><html><body><p>${htmlBody}</p>${reviewLink}<p>${unsubscribe}</p></body></html>`,
    sms: `${replace(input.smsBody)}\n${unsubscribeText}`,
  };
}
