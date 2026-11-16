import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { Sheet } from "./sheet";

function Panels() {
  const [tall, setTall] = useState(true);
  return (
    <Sheet
      open
      onOpenChange={() => {}}
      title="Small panel"
      footer={<button type="button">Small action</button>}
    >
      Small body
      <Sheet
        open={tall}
        onOpenChange={setTall}
        title="Tall panel"
        footer={
          <button type="button" onClick={() => setTall(false)}>
            Tall action
          </button>
        }
      >
        Tall body
      </Sheet>
    </Sheet>
  );
}

describe("Sheet", () => {
  test("is a labelled modal dialog with its content", async () => {
    renderApp(
      <Sheet open onOpenChange={() => {}} title="Appointment" description="Details">
        <p>Body text</p>
      </Sheet>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Appointment" });
    expect(dialog).toHaveAccessibleDescription("Details");
    expect(screen.getByText("Body text")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Appointment" })).toHaveAttribute("tabindex", "0");
  });

  test("the close button reports the request to close", async () => {
    const onOpenChange = mock();
    renderApp(
      <Sheet open onOpenChange={onOpenChange} title="Appointment">
        <p>Body</p>
      </Sheet>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close panel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("renders nothing while closed", () => {
    renderApp(
      <Sheet open={false} onOpenChange={() => {}} title="Appointment">
        <p>Body</p>
      </Sheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("notifications reserve the tallest open sheet footer and release resized or closed panels", async () => {
  const property = "--sheet-footer-height";
  const root = document.documentElement;
  const previous = root.style.getPropertyValue(property);
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalObserver = globalThis.ResizeObserver;
  let tallHeight = 180;
  const resizes = new Map<Element, () => void>();
  class LayoutObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (target.tagName === "FOOTER") resizes.set(target, () => this.callback([], this));
    }
    unobserve(target: Element) {
      resizes.delete(target);
    }
    disconnect() {}
  }
  globalThis.ResizeObserver = LayoutObserver;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.tagName === "FOOTER"
      ? new DOMRect(0, 0, 390, this.textContent?.includes("Tall") ? tallHeight : 80)
      : originalRect.call(this);
  };
  root.style.setProperty(property, "9px");
  let unmount: (() => void) | undefined;
  try {
    const rendered = renderApp(<Panels />);
    unmount = rendered.unmount;
    await waitFor(() => expect(root.style.getPropertyValue(property)).toBe("180px"));
    tallHeight = 240;
    for (const resize of resizes.values()) resize();
    expect(root.style.getPropertyValue(property)).toBe("240px");
    fireEvent.click(screen.getByRole("button", { name: "Tall action" }));
    await waitFor(() => expect(root.style.getPropertyValue(property)).toBe("80px"));
    unmount();
    expect(root.style.getPropertyValue(property)).toBe("9px");
    for (const resize of resizes.values()) resize();
    expect(root.style.getPropertyValue(property)).toBe("9px");
  } finally {
    unmount?.();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    globalThis.ResizeObserver = originalObserver;
    if (previous) root.style.setProperty(property, previous);
    else root.style.removeProperty(property);
  }
});
