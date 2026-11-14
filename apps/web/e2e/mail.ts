/**
 * Reads the mail the API sends from Mailpit (an SMTP sink with an HTTP API), so end-to-end
 * tests follow the real verification, reset and invitation links instead of reaching into the
 * database. Start it with `docker compose --profile mail up -d mailpit` and point the API at
 * it with `NOTIFY_EMAIL_PROVIDER=smtp SMTP_URL=smtp://localhost:1025`.
 */
const MAILPIT = (process.env.E2E_MAILPIT_URL ?? "http://localhost:8025").replace(/\/+$/, "");

export interface MailMessage {
  id: string;
  subject: string;
  text: string;
  html: string;
  created: string;
}

interface SearchResult {
  messages: { ID: string; Subject: string; Created: string }[];
}

/** Waits for a message to `to` whose subject matches, newest first. Polls; mail is async. */
export async function waitForMail(
  to: string,
  options: { subject?: RegExp; timeoutMs?: number; ignore?: Set<string> } = {},
): Promise<MailMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let lastError = "no message yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
      );
      const found = (await res.json()) as SearchResult;
      const match = found.messages.find(
        (m) =>
          !options.ignore?.has(m.ID) && (!options.subject || options.subject.test(m.Subject)),
      );
      if (match) {
        const full = (await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json()) as {
          Text: string;
          HTML: string;
        };
        return {
          id: match.ID,
          subject: match.Subject,
          text: full.Text,
          html: full.HTML,
          created: match.Created,
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No mail to ${to} (${options.subject ?? "any subject"}) arrived: ${lastError}`);
}

/** The first link in a plain-text body, as a path relative to the app (works through the proxy). */
export function firstLink(message: MailMessage): string {
  const match = message.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`No link in mail "${message.subject}":\n${message.text}`);
  return match[0];
}

export const pathOf = (link: string) => {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
};
