import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, screen } from "@testing-library/react";
import { ApiError, NetworkError } from "~/lib/api/client";
import { renderApp } from "../../../test/render";
import { EmptyState, ErrorState, OfflineBanner, Skeleton } from "./states";

describe("Skeleton", () => {
  test("is hidden from assistive tech and exposes a busy region label when wrapped", () => {
    renderApp(<Skeleton className="h-4 w-24" data-testid="sk" />);
    expect(screen.getByTestId("sk")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("EmptyState", () => {
  test("shows a title, a description and an action", () => {
    renderApp(
      <EmptyState title="No appointments" description="Book your first visit.">
        <a href="/book">Book now</a>
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { name: "No appointments" })).toBeInTheDocument();
    expect(screen.getByText("Book your first visit.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book now" })).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  test("offers a retry that calls the handler", () => {
    const onRetry = mock();
    renderApp(<ErrorState error={new ApiError("internal_error", 500, "boom")} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("distinguishes a network failure from a server error", () => {
    renderApp(<ErrorState error={new NetworkError()} onRetry={() => {}} />);
    expect(screen.getByText("You appear to be offline")).toBeInTheDocument();
  });

  test("tells the visitor how long to wait when rate limited", () => {
    renderApp(
      <ErrorState error={new ApiError("rate_limited", 429, "slow", 42)} onRetry={() => {}} />,
    );
    expect(screen.getByText(/42 seconds/)).toBeInTheDocument();
  });
});

describe("OfflineBanner", () => {
  test("appears when the browser goes offline and disappears when it returns", async () => {
    renderApp(<OfflineBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(
      await screen.findByText("You are offline. Some actions are unavailable."),
    ).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(
      screen.queryByText("You are offline. Some actions are unavailable."),
    ).not.toBeInTheDocument();
  });
});
