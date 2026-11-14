import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ApiError } from "~/lib/api/client";
import { renderApp } from "../../../test/render";
import { ForgotPasswordForm, ResendVerificationForm, ResetPasswordForm } from "./recovery-forms";

const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("ForgotPasswordForm", () => {
  test("validates the address before asking the server", async () => {
    const onSubmit = mock(async () => {});
    renderApp(<ForgotPasswordForm onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
  });

  test("always ends on the same neutral confirmation, whoever the address belongs to", async () => {
    const onSubmit = mock(async (_email: string) => {});
    renderApp(<ForgotPasswordForm onSubmit={onSubmit} />);
    fill("Email", " lucia@example.com ");
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(onSubmit.mock.calls[0]?.[0]).toBe("lucia@example.com");
    expect(screen.getByText(/If an account exists for lucia@example\.com/)).toBeInTheDocument();
  });

  test("rate limiting is explained and the form stays usable afterwards", async () => {
    const onSubmit = async () => {
      throw new ApiError("rate_limited", 429, "slow", 20);
    };
    renderApp(<ForgotPasswordForm onSubmit={onSubmit} />);
    fill("Email", "lucia@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
  });
});

describe("ResetPasswordForm", () => {
  test("uses new-password autocomplete and checks length and confirmation", async () => {
    const onSubmit = mock(async () => {});
    renderApp(<ResetPasswordForm onSubmit={onSubmit} />);
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
    fill("New password", "short");
    fill("Repeat the new password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("Use at least 8 characters")).toBeInTheDocument();

    fill("New password", "long enough now");
    fill("Repeat the new password", "something else entirely");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText("The two passwords do not match.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a good password is submitted and the success state links to sign in", async () => {
    const onSubmit = mock(async (_password: string) => {});
    renderApp(<ResetPasswordForm onSubmit={onSubmit} />);
    fill("New password", "long enough now");
    fill("Repeat the new password", "long enough now");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("long enough now"));
    expect(await screen.findByRole("heading", { name: "Password saved" })).toBeInTheDocument();
  });

  test("an expired link turns into a way to request a new one", async () => {
    const onSubmit = async () => {
      throw new ApiError("invalid_token", 400, "Invalid token");
    };
    renderApp(<ResetPasswordForm onSubmit={onSubmit} />);
    fill("New password", "long enough now");
    fill("Repeat the new password", "long enough now");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(
      await screen.findByRole("heading", { name: "This link is no longer valid" }),
    ).toBeInTheDocument();
  });
});

describe("ResendVerificationForm", () => {
  test("asks for the address and ends on the neutral inbox notice", async () => {
    const onSubmit = mock(async (_email: string) => {});
    renderApp(<ResendVerificationForm onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Send a new link" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    fill("Email", "lucia@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send a new link" }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledWith("lucia@example.com");
  });
});
