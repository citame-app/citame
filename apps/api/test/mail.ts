import type { FakeEmailProvider } from "../src/notifications/providers/fake";
import type { EmailMessage } from "../src/notifications/providers/types";

/** First http(s) link in a plain-text message. */
export function linkIn(message: EmailMessage): string {
  const match = message.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`No link in message:\n${message.text}`);
  return match[0];
}

/** `http://host/api/auth/x?y` -> `/api/auth/x?y`, ready for `app.request`. */
export const pathOf = (link: string) => {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
};

/**
 * Account emails are sent in the background (never awaited: a timing difference would reveal
 * whether an address has an account), so tests wait for them.
 */
export async function mailTo(
  provider: FakeEmailProvider,
  to: string,
  options: { after?: number; timeoutMs?: number } = {},
): Promise<EmailMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    const found = provider.calls.slice(options.after ?? 0).find((m) => m.to === to);
    if (found) return found;
    await Bun.sleep(20);
  }
  throw new Error(`No email to ${to} within the timeout`);
}

/** Asserts that nothing is sent to `to`, after giving background sends a moment to happen. */
export async function expectNoMailTo(provider: FakeEmailProvider, to: string, after = 0) {
  await Bun.sleep(300);
  const found = provider.calls.slice(after).filter((m) => m.to === to);
  if (found.length > 0) throw new Error(`Unexpected email to ${to}: ${found[0]?.subject}`);
}
