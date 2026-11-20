import { expect, test } from "bun:test";
import { readSignupEvent } from "./meta-signup";

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
