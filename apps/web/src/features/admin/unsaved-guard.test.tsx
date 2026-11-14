import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { UnsavedGuard } from "./unsaved-guard";

const g = globalThis as {
  __blockerState?: unknown;
  __blockerOptions?: { shouldBlockFn: () => boolean };
};
afterEach(() => {
  g.__blockerState = undefined;
});

describe("UnsavedGuard", () => {
  test("blocks navigation only while the form is dirty", () => {
    renderApp(<UnsavedGuard dirty />);
    expect(g.__blockerOptions?.shouldBlockFn()).toBe(true);
    renderApp(<UnsavedGuard dirty={false} />);
    expect(g.__blockerOptions?.shouldBlockFn()).toBe(false);
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
