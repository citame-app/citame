import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { UnsavedGuard } from "./unsaved-guard";

const g = globalThis as {
  __blockerState?: unknown;
  __blockerOptions?: {
    shouldBlockFn: (locations: {
      current: { pathname: string };
      next: { pathname: string };
    }) => boolean;
  };
};
afterEach(() => {
  g.__blockerState = undefined;
});

describe("UnsavedGuard", () => {
  test("blocks navigation only while the form is dirty", () => {
    renderApp(<UnsavedGuard dirty />);
    expect(
      g.__blockerOptions?.shouldBlockFn({
        current: { pathname: "/admin/commerce" },
        next: { pathname: "/admin/calendar" },
      }),
    ).toBe(true);
    renderApp(<UnsavedGuard dirty={false} />);
    expect(
      g.__blockerOptions?.shouldBlockFn({
        current: { pathname: "/admin/commerce" },
        next: { pathname: "/admin/calendar" },
      }),
    ).toBe(false);
  });

  test("a persistent basket can switch its view without discarding but still guards leaving commerce", () => {
    renderApp(<UnsavedGuard dirty preserveOnSearchChange />);
    expect(
      g.__blockerOptions?.shouldBlockFn({
        current: { pathname: "/admin/commerce" },
        next: { pathname: "/admin/commerce" },
      }),
    ).toBe(false);
    expect(
      g.__blockerOptions?.shouldBlockFn({
        current: { pathname: "/admin/commerce" },
        next: { pathname: "/admin/calendar" },
      }),
    ).toBe(true);
  });

  test("shows nothing while navigation is allowed", () => {
    renderApp(<UnsavedGuard dirty />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a blocked navigation asks to keep editing or discard", async () => {
    const proceed = mock();
    const reset = mock();
    g.__blockerState = { status: "blocked", proceed, reset };
    renderApp(<UnsavedGuard dirty />);
    expect(
      await screen.findByRole("dialog", { name: "Discard your changes?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(reset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});
