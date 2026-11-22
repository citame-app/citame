import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { SMTPServer } from "smtp-server";
import { loadConfig } from "../../config";
import { createProviders } from ".";
import { createSmtpProvider } from "./smtp";
import { createTwilioProvider } from "./twilio";
import { PermanentProviderError, TransientProviderError } from "./types";

describe("SMTP provider against a real local SMTP server", () => {
  const received: string[] = [];
  let rejectWith: number | null = null;
  let server: SMTPServer;
  let port = 0;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onRcptTo(_address, _session, callback) {
        if (rejectWith) {
          const error = Object.assign(new Error("mailbox rejected"), { responseCode: rejectWith });
          return callback(error);
        }
        callback();
      },
      onData(stream, _session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          received.push(Buffer.concat(chunks).toString());
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve(null)));
  });

  const message = {
    to: "lucia@example.com",
    subject: "Turno confirmado: lun 9 mar",
    text: "plain body",
    html: "<p>html body</p>",
    ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    headers: { "List-Unsubscribe": "<https://salon.example/u>" },
    idempotencyKey: "0190aaaa-0000-7000-8000-000000000009",
  };

  test("delivers multipart text+html with calendar attachment and deterministic Message-ID", async () => {
    const provider = createSmtpProvider({
      url: `smtp://127.0.0.1:${port}`,
      from: "Salon <no-reply@salon.example>",
    });
    const result = await provider.send(message);
    await provider.close?.();
    expect(result.messageId).toBe("<0190aaaa-0000-7000-8000-000000000009@salon.example>");
    const raw = received.at(-1) ?? "";
    expect(raw).toContain("List-Unsubscribe: <https://salon.example/u>");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("text/calendar");
    expect(raw).toContain("invite.ics");
    expect(raw).toContain("plain body");
  });

  test("maps a 5xx recipient rejection to a permanent error and 4xx to transient", async () => {
    const provider = createSmtpProvider({
      url: `smtp://127.0.0.1:${port}`,
      from: "a@salon.example",
    });
    rejectWith = 550;
    await expect(provider.send(message)).rejects.toBeInstanceOf(PermanentProviderError);
    rejectWith = 451;
    await expect(provider.send(message)).rejects.toBeInstanceOf(TransientProviderError);
    rejectWith = null;
    await provider.close?.();
  });

  test.each(["default", "retry parameter", "nested URL"])(
    "rejects a disconnected send after one SMTP connection (%s)",
    async (configuration) => {
      let connections = 0;
      const disconnecting = createServer((socket) => {
        connections++;
        socket.end();
      });
      await new Promise<void>((resolve) => disconnecting.listen(0, "127.0.0.1", resolve));
      const address = disconnecting.address();
      if (!address || typeof address === "string") throw new Error("Missing SMTP address");
      const url = new URL(`smtp://127.0.0.1:${address.port}`);
      if (configuration === "retry parameter") url.searchParams.set("maxRequeues", "1");
      if (configuration === "nested URL") url.searchParams.set("url", `${url.href}?maxRequeues=1`);
      const provider = createSmtpProvider({
        url: url.href,
        from: "a@salon.example",
        timeouts: { connectionMs: 500, greetingMs: 500, socketMs: 500 },
      });
      try {
        await expect(provider.send(message)).rejects.toBeInstanceOf(TransientProviderError);
        expect(connections).toBe(1);
      } finally {
        await provider.close?.();
        await new Promise<void>((resolve) => disconnecting.close(() => resolve()));
      }
    },
    15_000,
  );

  test("an unreachable server is transient", async () => {
    const provider = createSmtpProvider({ url: "smtp://127.0.0.1:1", from: "a@salon.example" });
    await expect(provider.send(message)).rejects.toBeInstanceOf(TransientProviderError);
    await provider.close?.();
  });
});

describe("Twilio provider against a stub", () => {
  const seen: { path: string; auth: string | null; form: URLSearchParams }[] = [];
  let status = 201;
  let stub: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    stub = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          form: new URLSearchParams(await request.text()),
        });
        return status >= 400
          ? new Response("nope", { status })
          : Response.json({ sid: "SM123" }, { status });
      },
    });
  });
  afterAll(() => stub.stop(true));

  const make = (from = "+15005550006") =>
    createTwilioProvider({
      accountSid: "ACtest",
      authToken: "tok",
      from,
      baseUrl: `http://127.0.0.1:${stub.port}`,
    });
  const sms = { to: "+5491100000000", body: "hi", idempotencyKey: "k1" };

  test("posts form-encoded with basic auth and returns the sid", async () => {
    status = 201;
    const result = await make().send(sms);
    expect(result.messageId).toBe("SM123");
    const call = seen.at(-1);
    expect(call?.path).toBe("/2010-04-01/Accounts/ACtest/Messages.json");
    expect(call?.auth).toBe(`Basic ${Buffer.from("ACtest:tok").toString("base64")}`);
    expect(call?.form.get("From")).toBe("+15005550006");
    expect(call?.form.get("To")).toBe("+5491100000000");
  });

  test("uses a messaging service sid when configured", async () => {
    status = 201;
    await make("MG123").send(sms);
    expect(seen.at(-1)?.form.get("MessagingServiceSid")).toBe("MG123");
    expect(seen.at(-1)?.form.get("From")).toBeNull();
  });

  test("429 and 5xx are transient, other 4xx permanent", async () => {
    status = 429;
    await expect(make().send(sms)).rejects.toBeInstanceOf(TransientProviderError);
    status = 503;
    await expect(make().send(sms)).rejects.toBeInstanceOf(TransientProviderError);
    status = 400;
    await expect(make().send(sms)).rejects.toBeInstanceOf(PermanentProviderError);
  });
});

describe("createProviders", () => {
  const env = { BETTER_AUTH_SECRET: "x".repeat(32) };
  test("is fully disabled by default", () => {
    const p = createProviders(loadConfig(env).notifications);
    expect(p).toEqual({ email: null, sms: null });
  });
  test("requires credentials for the selected providers", () => {
    expect(() => loadConfig({ ...env, NOTIFY_EMAIL_PROVIDER: "smtp" })).toThrow(/SMTP_URL/);
    expect(() => loadConfig({ ...env, NOTIFY_SMS_PROVIDER: "twilio" })).toThrow(/TWILIO/);
  });
});

describe("SMTP provider timeouts", () => {
  test("a server that accepts the connection but never greets fails fast and retryably", async () => {
    // A black hole: the TCP handshake completes, nothing is ever said.
    const hole = createServer(() => {});
    await new Promise<void>((resolve) => hole.listen(0, "127.0.0.1", resolve));
    const port = (hole.address() as { port: number }).port;
    const provider = createSmtpProvider({
      url: `smtp://127.0.0.1:${port}`,
      from: "Salon <no-reply@salon.example>",
      timeouts: { connectionMs: 500, greetingMs: 500, socketMs: 500 },
    });
    const started = Date.now();
    try {
      await expect(
        provider.send({
          to: "lucia@example.com",
          subject: "s",
          text: "t",
          html: "h",
          idempotencyKey: "0190aaaa-0000-7000-8000-00000000000a",
        }),
      ).rejects.toBeInstanceOf(TransientProviderError);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await provider.close?.();
      hole.close();
    }
  }, 10_000);

  test("sensible defaults are in place for production use", async () => {
    // The defaults must stay well under the 120 s job lease (NOTIFY_VISIBILITY_TIMEOUT_SECONDS).
    const { SMTP_TIMEOUTS } = await import("./smtp");
    expect(
      SMTP_TIMEOUTS.connectionMs + SMTP_TIMEOUTS.greetingMs + SMTP_TIMEOUTS.socketMs,
    ).toBeLessThan(60_000);
  });
});
