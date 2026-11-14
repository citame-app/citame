import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ApiError, NetworkError } from "~/lib/api/client";
import { renderApp } from "../../../test/render";
import { AuthForm } from "./auth-form";

const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("AuthForm sign in", () => {
  test("uses the right input types and autocomplete hints", () => {
    renderApp(<AuthForm mode="sign-in" onSubmit={async () => {}} />);
    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(email).toHaveAttribute("inputmode", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
  });

  test("does not call the API while the form is invalid and shows errors tied to the inputs", async () => {
    const onSubmit = mock(async () => {});
    renderApp(<AuthForm mode="sign-in" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).not.toHaveBeenCalled();
    const email = await screen.findByLabelText("Email");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a valid email address")).toBeInTheDocument();
    expect(screen.getByText("Enter your password")).toBeInTheDocument();
  });

  test("submits trimmed, validated values", async () => {
    const onSubmit = mock(async (_values: unknown) => {});
    renderApp(<AuthForm mode="sign-in" onSubmit={onSubmit} />);
    fill("Email", " lucia@example.com ");
    fill("Password", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      email: "lucia@example.com",
      password: "correct horse",
    });
  });

  test("wrong credentials show a form-level alert without blaming a field", async () => {
    const onSubmit = async () => {
      throw new ApiError("invalid_credentials", 401, "Invalid email or password");
    };
    renderApp(<AuthForm mode="sign-in" onSubmit={onSubmit} />);
    fill("Email", "lucia@example.com");
    fill("Password", "wrong password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("The email or password is incorrect.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("rate limiting explains the wait and blocks the button until it passes", async () => {
    const onSubmit = async () => {
      throw new ApiError("rate_limited", 429, "slow", 30);
    };
    renderApp(<AuthForm mode="sign-in" onSubmit={onSubmit} />);
    fill("Email", "lucia@example.com");
    fill("Password", "whatever");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
    expect(screen.getByText(/30 seconds/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign in/ })).toBeDisabled();
  });

  test("a network failure says so", async () => {
    renderApp(
      <AuthForm
        mode="sign-in"
        onSubmit={async () => {
          throw new NetworkError();
        }}
      />,
    );
    fill("Email", "lucia@example.com");
    fill("Password", "whatever");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("You appear to be offline")).toBeInTheDocument();
  });
});

describe("AuthForm sign up", () => {
  test("asks for name, email and a new password with the right autocomplete", () => {
    renderApp(<AuthForm mode="sign-up" onSubmit={async () => {}} />);
    expect(screen.getByLabelText("Full name")).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  test("an existing email is reported on the email field", async () => {
    renderApp(
      <AuthForm
        mode="sign-up"
        onSubmit={async () => {
          throw new ApiError("email_taken", 422, "exists");
        }}
      />,
    );
    fill("Full name", "Lucia");
    fill("Email", "lucia@example.com");
    fill("Password", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText("An account with this email already exists."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("AuthForm account security", () => {
  test("sign in links to the password reset page", () => {
    renderApp(<AuthForm mode="sign-in" onSubmit={async () => {}} />);
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  test("sign up does not show the reset link", () => {
    renderApp(<AuthForm mode="sign-up" onSubmit={async () => {}} />);
    expect(screen.queryByRole("link", { name: "Forgot your password?" })).toBeNull();
  });

  test("an unconfirmed address is told to open the link that was just sent", async () => {
    const onSubmit = async () => {
      throw new ApiError("email_not_verified", 403, "Email not verified");
    };
    renderApp(<AuthForm mode="sign-in" onSubmit={onSubmit} />);
    fill("Email", "lucia@example.com");
    fill("Password", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/not confirmed yet/)).toBeInTheDocument();
  });

  test("after sign up that needs confirmation the form gives way to the inbox notice, and can resend", async () => {
    const onResend = mock(async (_email: string) => {});
    renderApp(
      <AuthForm
        mode="sign-up"
        onSubmit={async () => ({ verifyEmail: "lucia@example.com" })}
        onResendVerification={onResend}
      />,
    );
    fill("Full name", "Lucia");
    fill("Email", "lucia@example.com");
    fill("Password", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send the email again" }));
    await waitFor(() => expect(onResend).toHaveBeenCalledWith("lucia@example.com"));
  });
});
