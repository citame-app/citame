import { LOCALES, type Locale } from "./templates";

/**
 * Account emails: address verification, password reset, staff invitation and the notice sent
 * when someone signs up with an address that already has an account. They are transactional
 * (no opt-out) and carry exactly one link. Kept apart from the appointment templates because
 * they have no appointment, and must keep working when none exists.
 */
export type AuthEmailKind = "verify_email" | "reset_password" | "staff_invite" | "account_exists";

export interface AuthEmailData {
  kind: AuthEmailKind;
  locale: Locale;
  salonName: string;
  /** The single action link. For `account_exists` it points at the password reset page. */
  url: string;
  expiresInMinutes: number;
}

export interface RenderedAuthEmail {
  subject: string;
  text: string;
  html: string;
}

interface Copy {
  subject: Record<AuthEmailKind, (salon: string) => string>;
  heading: Record<AuthEmailKind, string>;
  body: Record<AuthEmailKind, string>;
  action: Record<AuthEmailKind, string>;
  expires: (when: string) => string;
  ignore: Record<AuthEmailKind, string>;
  minutes: (n: number) => string;
  hours: (n: number) => string;
  days: (n: number) => string;
  linkFallback: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: {
      verify_email: (s) => `Confirm your email address for ${s}`,
      reset_password: (s) => `Reset your ${s} password`,
      staff_invite: (s) => `You have been invited to ${s}`,
      account_exists: (s) => `You already have an account at ${s}`,
    },
    heading: {
      verify_email: "Confirm your email address",
      reset_password: "Reset your password",
      staff_invite: "Set up your account",
      account_exists: "You already have an account",
    },
    body: {
      verify_email: "Thanks for signing up. Confirm this address to finish creating your account.",
      reset_password:
        "We received a request to reset your password. Choose a new one with the link below.",
      staff_invite:
        "You have been invited to join the team. Choose a password to activate your account.",
      account_exists:
        "Someone tried to create an account with this email address, but you already have one. If it was you, you can reset your password below.",
    },
    action: {
      verify_email: "Confirm email address",
      reset_password: "Choose a new password",
      staff_invite: "Set my password",
      account_exists: "Reset my password",
    },
    expires: (when) => `This link works for ${when}.`,
    ignore: {
      verify_email: "If you did not create this account, you can ignore this message.",
      reset_password:
        "If you did not ask for this, you can ignore this message: your password stays the same.",
      staff_invite: "If you were not expecting this invitation, you can ignore this message.",
      account_exists: "If it was not you, you can ignore this message: nothing has changed.",
    },
    minutes: (n) => `${n} ${n === 1 ? "minute" : "minutes"}`,
    hours: (n) => `${n} ${n === 1 ? "hour" : "hours"}`,
    days: (n) => `${n} ${n === 1 ? "day" : "days"}`,
    linkFallback: "If the button does not work, copy this address into your browser:",
  },
  "es-AR": {
    subject: {
      verify_email: (s) => `Confirmá tu email en ${s}`,
      reset_password: (s) => `Restablecé tu contraseña de ${s}`,
      staff_invite: (s) => `Te invitaron a ${s}`,
      account_exists: (s) => `Ya tenés una cuenta en ${s}`,
    },
    heading: {
      verify_email: "Confirmá tu email",
      reset_password: "Restablecé tu contraseña",
      staff_invite: "Configurá tu cuenta",
      account_exists: "Ya tenés una cuenta",
    },
    body: {
      verify_email:
        "Gracias por registrarte. Confirmá esta dirección para terminar de crear tu cuenta.",
      reset_password:
        "Recibimos un pedido para restablecer tu contraseña. Elegí una nueva con el enlace de abajo.",
      staff_invite:
        "Te invitaron a sumarte al equipo. Elegí una contraseña para activar tu cuenta.",
      account_exists:
        "Alguien intentó crear una cuenta con este email, pero ya tenés una. Si fuiste vos, podés restablecer tu contraseña abajo.",
    },
    action: {
      verify_email: "Confirmar email",
      reset_password: "Elegir una contraseña nueva",
      staff_invite: "Elegir mi contraseña",
      account_exists: "Restablecer mi contraseña",
    },
    expires: (when) => `Este enlace funciona durante ${when}.`,
    ignore: {
      verify_email: "Si no creaste esta cuenta, ignorá este mensaje.",
      reset_password: "Si no lo pediste, ignorá este mensaje: tu contraseña no cambia.",
      staff_invite: "Si no esperabas esta invitación, ignorá este mensaje.",
      account_exists: "Si no fuiste vos, ignorá este mensaje: no cambió nada.",
    },
    minutes: (n) => `${n} ${n === 1 ? "minuto" : "minutos"}`,
    hours: (n) => `${n} ${n === 1 ? "hora" : "horas"}`,
    days: (n) => `${n} ${n === 1 ? "día" : "días"}`,
    linkFallback: "Si el botón no funciona, copiá esta dirección en tu navegador:",
  },
};

const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

function duration(c: Copy, minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return c.days(minutes / 1440);
  if (minutes >= 60 && minutes % 60 === 0) return c.hours(minutes / 60);
  return c.minutes(minutes);
}

export function renderAuthEmail(d: AuthEmailData): RenderedAuthEmail {
  const c = COPY[d.locale];
  const subject = c.subject[d.kind](d.salonName);
  const expiry = c.expires(duration(c, d.expiresInMinutes));
  const text = [
    c.heading[d.kind],
    "",
    c.body[d.kind],
    "",
    `${c.action[d.kind]}: ${d.url}`,
    "",
    expiry,
    c.ignore[d.kind],
    "",
    `-- ${d.salonName}`,
  ].join("\n");
  const html = `<!doctype html>
<html lang="${d.locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px;background:#faf7f5;color:#1f1a1c;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">
<main style="max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px">
<p style="margin:0 0 8px;font-size:14px;color:#555">${esc(d.salonName)}</p>
<h1 style="font-size:22px;margin:0 0 12px">${esc(c.heading[d.kind])}</h1>
<p>${esc(c.body[d.kind])}</p>
<p style="margin:24px 0"><a href="${esc(d.url)}" style="display:inline-block;background:#7a2e5a;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">${esc(c.action[d.kind])}</a></p>
<p style="font-size:14px;color:#555">${esc(c.linkFallback)}<br><a href="${esc(d.url)}" style="color:#7a2e5a;word-break:break-all">${esc(d.url)}</a></p>
<p style="font-size:14px;color:#555">${esc(expiry)} ${esc(c.ignore[d.kind])}</p>
</main>
</body>
</html>`;
  return { subject, text, html };
}

const COOKIE_NAME = "sob_locale";

/** Language for an email triggered by a web request: cookie, then Accept-Language, then the default. */
export function localeFromRequest(request: Request | undefined, fallback: Locale): Locale {
  if (!request) return fallback;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      const value = rest.join("=");
      if ((LOCALES as readonly string[]).includes(value)) return value as Locale;
    }
  }
  const accept = request.headers.get("accept-language")?.toLowerCase() ?? "";
  for (const entry of accept.split(",")) {
    const tag = entry.split(";")[0]?.trim() ?? "";
    if (tag.startsWith("es")) return "es-AR";
    if (tag.startsWith("en")) return "en";
  }
  return fallback;
}
