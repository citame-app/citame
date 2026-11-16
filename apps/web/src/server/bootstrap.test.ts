import { expect, mock, test } from "bun:test";
import { bootstrapForRequest } from "./bootstrap";

test("public widget bootstrap reads preferences without resolving an authenticated session", async () => {
  const readSession = mock(async () => null);
  const headers = new Headers({
    cookie: "sob_locale=es-AR; sob_theme=dark; session=private",
    "accept-language": "en",
  });
  expect(await bootstrapForRequest(headers, readSession, true)).toMatchObject({
    locale: "es-AR",
    session: null,
  });
  expect(readSession).not.toHaveBeenCalled();
  await bootstrapForRequest(headers, readSession);
  expect(readSession).toHaveBeenCalledTimes(1);
});
test("anonymous bootstrap does not request a session", async () => {
  const readSession = mock(async () => null);
  expect(
    await bootstrapForRequest(new Headers({ "accept-language": "es" }), readSession),
  ).toMatchObject({ locale: "es-AR", session: null });
  expect(readSession).not.toHaveBeenCalled();
});
