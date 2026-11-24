import { expect, test } from "bun:test";
import { readSignupEvent, startMetaSignup } from "./meta-signup";

test("Meta v5 coexistence accepts only an exact Facebook origin and one Messaging account", () => {
  const data = JSON.stringify({
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    data: { messaging_account_ids: ["123456"], phone_number_id: "876543" },
  });
  expect(readSignupEvent({ origin: "https://not-facebook.com", data })).toBeNull();
  expect(readSignupEvent({ origin: "https://www.facebook.com", data })).toEqual({
    type: "success",
    wabaId: "123456",
    phoneId: "876543",
  });
  expect(
    readSignupEvent({
      origin: "https://www.facebook.com",
      data: data.replace('"123456"', '"123456","111111"'),
    }),
  ).toEqual({ type: "invalid" });
});

test("a malformed selected phone cannot be interpreted as an omitted phone", () => {
  const origin = "https://www.facebook.com";
  const event = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH" };
  const read = (data: Record<string, unknown>) =>
    readSignupEvent({ origin, data: { ...event, data } });
  expect(read({ messaging_account_ids: ["123456"], phone_number_id: "unknown" })).toEqual({
    type: "invalid",
  });
  expect(read({ messaging_account_ids: ["123456"], phone_number_id: "" })).toEqual({
    type: "invalid",
  });
  expect(read({ messaging_account_ids: ["123456"], phone_number_id: 765432 })).toEqual({
    type: "invalid",
  });
  expect(read({ messaging_account_ids: ["123456"], phone_number_id: null })).toEqual({
    type: "invalid",
  });
  expect(read({ messaging_account_ids: "123456", waba_id: "123456" })).toEqual({ type: "invalid" });
  expect(read({ messaging_account_ids: ["123456"] })).toEqual({
    type: "success",
    wabaId: "123456",
    phoneId: undefined,
  });
});

test("an empty SDK callback ends a cancelled popup and a fresh attempt can complete", () => {
  const previous = window.FB;
  let finish: Parameters<NonNullable<Window["FB"]>["login"]>[0] | undefined;
  window.FB = {
    init() {},
    login(callback) {
      finish = callback;
    },
  };
  const completions: string[] = [];
  const failures: string[] = [];
  const start = () =>
    startMetaSignup(
      "234567",
      "",
      ({ code }) => {
        completions.push(code);
      },
      (reason) => {
        failures.push(reason);
      },
    );
  const complete = () => {
    finish?.({ authResponse: { code: "synthetic-accepted" } });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://web.facebook.com",
        data: {
          type: "WA_EMBEDDED_SIGNUP",
          event: "FINISH",
          data: { messaging_account_ids: ["123456"], phone_number_id: "765432" },
        },
      }),
    );
  };
  let dispose = start();
  try {
    finish?.(undefined);
    complete();
    expect(failures).toEqual(["cancel"]);
    expect(completions).toEqual([]);
    dispose = start();
    complete();
    expect(completions).toEqual(["synthetic-accepted"]);
  } finally {
    dispose();
    window.FB = previous;
  }
});
