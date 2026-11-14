import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ApiError } from "~/lib/api/client";
import { renderApp } from "../../../test/render";
import { CheckInbox } from "./check-inbox";

describe("CheckInbox", () => {
  test("says where the link went and offers to send it again", () => {
    renderApp(<CheckInbox email="lucia@example.com" onResend={async () => {}} />);
    expect(screen.getByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(screen.getByText(/lucia@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/spam folder/)).toBeInTheDocument();
  });

  test("resending confirms politely and then makes you wait", async () => {
    const onResend = mock(async () => {});
    renderApp(<CheckInbox email="lucia@example.com" onResend={onResend} cooldownSeconds={30} />);
    fireEvent.click(screen.getByRole("button", { name: "Send the email again" }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("We sent it again. It can take a minute to arrive."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send the email again/ })).toBeDisabled();
    expect(screen.getByText(/30 seconds/)).toBeInTheDocument();
  });

  test("a rate limit is explained, not hidden", async () => {
    const onResend = async () => {
      throw new ApiError("rate_limited", 429, "slow", 45);
    };
    renderApp(<CheckInbox email="lucia@example.com" onResend={onResend} />);
    fireEvent.click(screen.getByRole("button", { name: "Send the email again" }));
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
  });
});
