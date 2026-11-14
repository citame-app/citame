import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ApiError } from "~/lib/api/client";
import { renderApp } from "../../../test/render";
import { ConsentView } from "./consent-view";
import { type OAuthRequest, parseOAuthRequest } from "./logic";

const SEARCH =
  "?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback&scope=mcp%3Aread+mcp%3Abook+schedule%3Aread+offline_access&exp=1&sig=SIG";
const parsed = parseOAuthRequest(SEARCH);
if (!parsed) throw new Error("fixture must parse");
const request: OAuthRequest = parsed;

const client = { client_id: "abc", client_name: "Claude Desktop" };

function view(overrides: Partial<Parameters<typeof ConsentView>[0]> = {}, locale?: "en" | "es-AR") {
  const decide = mock(async (_d: { accept: true; scopes: string[] }) => ({
    url: "http://127.0.0.1:8976/callback?code=c",
  }));
  const deny = mock(async () => ({ url: "http://127.0.0.1:8976/callback?error=access_denied" }));
  const navigate = mock((_url: string) => {});
  const props = {
    request,
    client,
    role: "client" as const,
    email: "lucia@example.com",
    decide,
    deny,
    navigate,
    ...overrides,
  };
  renderApp(<ConsentView {...props} />, { locale });
  return { decide, deny, navigate };
}

afterEach(() => mock.restore());

describe("ConsentView", () => {
  test("names the app and where the user is sent back, and says the app is unverified", () => {
    view();
    expect(
      screen.getByRole("heading", { level: 1, name: "Connect Claude Desktop?" }),
    ).toBeVisible();
    expect(screen.getByText(/127\.0\.0\.1:8976/)).toBeVisible();
    expect(screen.getByText(/registered itself/i)).toBeVisible();
    expect(screen.getByText("lucia@example.com")).toBeVisible();
  });

  test("lists what the app can do as labelled checkboxes; reading is locked on", () => {
    view();
    const read = screen.getByRole("checkbox", { name: /View services, availability/ });
    expect(read).toBeChecked();
    expect(read).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Book and cancel appointments/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Stay connected/ })).toBeChecked();
    expect(screen.getByRole("group", { name: /This app will be able to/ })).toBeVisible();
  });

  test("a client account is not offered the staff schedule; staff are", () => {
    view();
    expect(screen.queryByRole("checkbox", { name: /staff schedule/i })).toBeNull();
  });

  test("staff accounts see the schedule permission", () => {
    view({ role: "staff" });
    expect(screen.getByRole("checkbox", { name: /staff schedule/i })).toBeChecked();
  });

  test("allow sends only the scopes left on and then navigates to the returned URL", async () => {
    const { decide, navigate } = view();
    fireEvent.click(screen.getByRole("checkbox", { name: /Book and cancel appointments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide.mock.calls[0]?.[0]).toEqual({
      accept: true,
      scopes: ["mcp:read", "offline_access"],
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:8976/callback?code=c"),
    );
  });

  test("deny sends no scopes and still follows the redirect (access_denied)", async () => {
    const { decide, deny, navigate } = view();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:8976/callback?error=access_denied"),
    );
    expect(deny).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
  });

  test("buttons are disabled while the decision is in flight, and a failure is announced", async () => {
    const decide = mock(async () => {
      throw new ApiError("unauthorized", 401, "expired");
    });
    view({ decide });
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow access" })).toBeEnabled();
  });

  test("uses the app's neutral Spanish when the locale is es-AR", () => {
    view({}, "es-AR");
    expect(screen.getByRole("button", { name: "Permitir acceso" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeVisible();
  });

  test("falls back to a generic name when the app registered without one", () => {
    view({ client: { client_id: "abc" } });
    expect(screen.getByRole("heading", { level: 1, name: "Connect this app?" })).toBeVisible();
  });
});
