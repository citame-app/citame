export type Locale = "en" | "es-AR";
export const LOCALES: readonly Locale[] = ["en", "es-AR"];
export type MessageKind =
  | "confirmation"
  | "reminder_24h"
  | "reminder_2h"
  | "cancellation"
  | "rescheduled";

/**
 * Everything a message may say. It is built from the recipient's own appointment only: no
 * notes, no other clients, no contact details of staff, no secrets.
 */
export interface MessageData {
  kind: MessageKind;
  locale: Locale;
  salonName: string;
  /** Salon IANA timezone: times are always shown in it. */
  timeZone: string;
  startsAt: Date;
  endsAt: Date;
  /** Appointment version, used as the calendar SEQUENCE so updates replace the old entry. */
  version: number;
  services: string[];
  staffName: string;
  appointmentId: string;
  manageUrl: string;
  rescheduleUrl: string;
  /** Signed opt-out URL; present for reminders only. */
  optOutUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /** iCalendar body (`text/calendar`), for confirmations and reschedules. */
  ics?: string;
}

interface Copy {
  subject: Record<MessageKind, (d: string) => string>;
  heading: Record<MessageKind, string>;
  intro: Record<MessageKind, string>;
  when: string;
  services: string;
  with: string;
  at: string;
  manage: string;
  reschedule: string;
  rebook: string;
  optOut: string;
  optOutLead: string;
  transactionalNote: string;
  sms: Record<MessageKind, string>;
  smsStop: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: {
      confirmation: (d) => `Appointment confirmed: ${d}`,
      reminder_24h: (d) => `Reminder: your appointment is ${d}`,
      reminder_2h: (d) => `Reminder: your appointment is today, ${d}`,
      cancellation: (d) => `Appointment cancelled: ${d}`,
      rescheduled: (d) => `Appointment moved to ${d}`,
    },
    heading: {
      confirmation: "Your appointment is confirmed",
      reminder_24h: "Your appointment is tomorrow",
      reminder_2h: "Your appointment is coming up",
      cancellation: "Your appointment was cancelled",
      rescheduled: "Your appointment was moved",
    },
    intro: {
      confirmation: "Thank you for booking with us. Here are the details.",
      reminder_24h: "This is a friendly reminder of your upcoming appointment.",
      reminder_2h: "This is a reminder that your appointment starts in about two hours.",
      cancellation: "This appointment was cancelled and will not take place.",
      rescheduled: "Your appointment has a new time. Here are the updated details.",
    },
    when: "When",
    services: "Services",
    with: "With",
    at: "Where",
    manage: "Manage or cancel your appointment",
    reschedule: "Reschedule your appointment",
    rebook: "Book a new appointment",
    optOut: "Stop these reminders",
    optOutLead: "You receive this reminder because you booked with us.",
    transactionalNote: "This is a service message about your booking.",
    sms: {
      confirmation: "{salon}: appointment confirmed for {when}.",
      reminder_24h: "{salon}: reminder, your appointment is {when}.",
      reminder_2h: "{salon}: reminder, your appointment is {when}.",
      cancellation: "{salon}: your appointment on {when} was cancelled.",
      rescheduled: "{salon}: your appointment moved to {when}.",
    },
    smsStop: "Reply STOP to opt out.",
  },
  "es-AR": {
    subject: {
      confirmation: (d) => `Turno confirmado: ${d}`,
      reminder_24h: (d) => `Recordatorio: tu turno es ${d}`,
      reminder_2h: (d) => `Recordatorio: tu turno es hoy, ${d}`,
      cancellation: (d) => `Turno cancelado: ${d}`,
      rescheduled: (d) => `Tu turno se movió a ${d}`,
    },
    heading: {
      confirmation: "Tu turno está confirmado",
      reminder_24h: "Tu turno es mañana",
      reminder_2h: "Tu turno se acerca",
      cancellation: "Tu turno fue cancelado",
      rescheduled: "Tu turno cambió de horario",
    },
    intro: {
      confirmation: "Gracias por reservar con nosotras. Estos son los datos.",
      reminder_24h: "Te recordamos tu próximo turno.",
      reminder_2h: "Te recordamos que tu turno empieza en unas dos horas.",
      cancellation: "Este turno fue cancelado y no se va a realizar.",
      rescheduled: "Tu turno tiene un nuevo horario. Estos son los datos actualizados.",
    },
    when: "Cuándo",
    services: "Servicios",
    with: "Con",
    at: "Lugar",
    manage: "Administrar o cancelar tu turno",
    reschedule: "Cambiar el horario de tu turno",
    rebook: "Reservar un turno nuevo",
    optOut: "Dejar de recibir estos recordatorios",
    optOutLead: "Recibís este recordatorio porque reservaste un turno con nosotras.",
    transactionalNote: "Este es un mensaje de servicio sobre tu reserva.",
    sms: {
      confirmation: "{salon}: turno confirmado para {when}.",
      reminder_24h: "{salon}: recordatorio, tu turno es {when}.",
      reminder_2h: "{salon}: recordatorio, tu turno es {when}.",
      cancellation: "{salon}: se canceló tu turno del {when}.",
      rescheduled: "{salon}: tu turno pasó a {when}.",
    },
    smsStop: "Respondé STOP para no recibir más mensajes.",
  },
};

const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

function formatWhen(d: MessageData, style: "long" | "short") {
  const options: Intl.DateTimeFormatOptions =
    style === "long"
      ? {
          timeZone: d.timeZone,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }
      : {
          timeZone: d.timeZone,
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        };
  return new Intl.DateTimeFormat(d.locale, options).format(d.startsAt);
}

const isReminder = (kind: MessageKind) => kind === "reminder_24h" || kind === "reminder_2h";

export function renderEmail(d: MessageData): RenderedEmail {
  const c = COPY[d.locale];
  const when = formatWhen(d, "long");
  const shortWhen = formatWhen(d, "short");
  const cancelled = d.kind === "cancellation";
  const services = d.services.join(", ");

  const lines = [
    c.heading[d.kind],
    "",
    c.intro[d.kind],
    "",
    `${c.when}: ${when}`,
    `${c.services}: ${services}`,
    `${c.with}: ${d.staffName}`,
    `${c.at}: ${d.salonName}`,
    "",
  ];
  if (cancelled) {
    lines.push(`${c.rebook}: ${d.manageUrl}`);
  } else {
    lines.push(`${c.manage}: ${d.manageUrl}`, `${c.reschedule}: ${d.rescheduleUrl}`);
  }
  lines.push("", `-- ${d.salonName}`);
  if (isReminder(d.kind) && d.optOutUrl) {
    lines.push(c.optOutLead, `${c.optOut}: ${d.optOutUrl}`);
  } else {
    lines.push(c.transactionalNote);
  }

  const link = (href: string, label: string) =>
    `<a href="${esc(href)}" style="color:#7a2e5a;font-weight:600">${esc(label)}</a>`;
  const row = (label: string, value: string) =>
    `<tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0;font-weight:600">${esc(label)}</th><td style="padding:4px 0">${esc(value)}</td></tr>`;
  const actions = cancelled
    ? `<p>${link(d.manageUrl, c.rebook)}</p>`
    : `<p>${link(d.manageUrl, c.manage)}</p><p>${link(d.rescheduleUrl, c.reschedule)}</p>`;
  const footer =
    isReminder(d.kind) && d.optOutUrl
      ? `<p style="font-size:14px;color:#555">${esc(c.optOutLead)} ${link(d.optOutUrl, c.optOut)}</p>`
      : `<p style="font-size:14px;color:#555">${esc(c.transactionalNote)}</p>`;
  const subject = c.subject[d.kind](shortWhen);
  const html = `<!doctype html>
<html lang="${d.locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px;background:#faf7f5;color:#1f1a1c;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">
<main style="max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px">
<p style="margin:0 0 8px;font-size:14px;color:#555">${esc(d.salonName)}</p>
<h1 style="font-size:22px;margin:0 0 12px">${esc(c.heading[d.kind])}</h1>
<p>${esc(c.intro[d.kind])}</p>
<table role="presentation" style="border-collapse:collapse;margin:16px 0">
${row(c.when, when)}
${row(c.services, services)}
${row(c.with, d.staffName)}
${row(c.at, d.salonName)}
</table>
${actions}
${footer}
</main>
</body>
</html>`;

  const withCalendar = d.kind === "confirmation" || d.kind === "rescheduled";
  return {
    subject,
    text: lines.join("\n"),
    html,
    ...(withCalendar ? { ics: buildIcs(d) } : {}),
  };
}

export function renderSms(d: MessageData): string {
  const c = COPY[d.locale];
  const body = c.sms[d.kind]
    .replace("{salon}", d.salonName)
    .replace("{when}", formatWhen(d, "short"));
  return isReminder(d.kind) ? `${body} ${c.smsStop}` : body;
}

const icsStamp = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const icsEscape = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/;/g, ";").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 section 3.1: at most 75 octets per line, continuation lines start with a space. */
function fold(line: string): string[] {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(out.length === 0 ? current : ` ${current}`);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(out.length === 0 ? current : ` ${current}`);
  return out;
}

/**
 * Calendar entry for the booking. The UID is the appointment id and SEQUENCE grows with its
 * version, so a rescheduled message updates the entry instead of adding a second one.
 */
export function buildIcs(d: MessageData, now: Date = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sisters of Beauty//Notifications//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${d.appointmentId}@sistersofbeauty`,
    `SEQUENCE:${Math.max(0, d.version - 1)}`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(d.startsAt)}`,
    `DTEND:${icsStamp(d.endsAt)}`,
    `SUMMARY:${icsEscape(`${d.salonName}: ${d.services.join(", ")}`)}`,
    `DESCRIPTION:${icsEscape(`${d.services.join(", ")} / ${d.staffName}`)}`,
    `LOCATION:${icsEscape(d.salonName)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.flatMap(fold).join("\r\n")}\r\n`;
}
