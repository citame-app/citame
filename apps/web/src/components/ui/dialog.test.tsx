import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { ConfirmDialog } from "./dialog";

const base = {
  title: "Cancel this appointment?",
  description: "You can book again at any time.",
  confirmLabel: "Cancel appointment",
  cancelLabel: "Keep it",
};

describe("ConfirmDialog", () => {
  test("notices reserve the space down to the bottom of centered dialog actions and release it on close", async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    const previous = document.documentElement.style.getPropertyValue("--sheet-footer-height");
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.hasAttribute("data-dialog-actions")
        ? ({ ...original.call(this), height: 96, top: window.innerHeight - 180 } as DOMRect)
        : original.call(this);
    };
    try {
      const view = renderApp(
        <ConfirmDialog open onOpenChange={() => {}} onConfirm={() => {}} {...base} />,
      );
      await screen.findByRole("dialog");
      await waitFor(() =>
        expect(document.documentElement.style.getPropertyValue("--sheet-footer-height")).toBe(
          "180px",
        ),
      );
      view.unmount();
      expect(document.documentElement.style.getPropertyValue("--sheet-footer-height")).toBe(
        previous,
      );
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
  test("is an accessible modal dialog with a title and description", async () => {
    renderApp(<ConfirmDialog open onOpenChange={() => {}} onConfirm={() => {}} {...base} />);
    const dialog = await screen.findByRole("dialog", { name: "Cancel this appointment?" });
    expect(dialog).toHaveAccessibleDescription("You can book again at any time.");
  });

  test("confirm and cancel report the choice", async () => {
    const onConfirm = mock();
    const onOpenChange = mock();
    renderApp(<ConfirmDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} {...base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel appointment" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("nothing is rendered while closed", () => {
    renderApp(
      <ConfirmDialog open={false} onOpenChange={() => {}} onConfirm={() => {}} {...base} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("a pending confirmation disables both buttons", async () => {
    renderApp(
      <ConfirmDialog open pending onOpenChange={() => {}} onConfirm={() => {}} {...base} />,
    );
    expect(await screen.findByRole("button", { name: /Cancel appointment/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeDisabled();
  });
});
