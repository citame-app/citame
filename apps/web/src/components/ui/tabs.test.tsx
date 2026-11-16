import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { TabPanel, Tabs } from "./tabs";

const items = [
  { value: "hours", label: "Working hours" },
  { value: "timeoff", label: "Time off" },
];

function ChangingLabels() {
  const [spanish, setSpanish] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setSpanish(true)}>
        Translate tabs
      </button>
      <Tabs
        label="Staff sections"
        items={[
          ...items,
          { value: "dates", label: spanish ? "Fechas y turnos" : "Dates and shifts" },
        ]}
        value="dates"
        onValueChange={() => {}}
      >
        <TabPanel value="dates">Dates panel</TabPanel>
      </Tabs>
    </>
  );
}

describe("Tabs", () => {
  test("a translated active tab scrolls horizontally into view without moving the page", async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const rect = original.call(this);
      if (this.getAttribute("role") === "tablist")
        return { ...rect, left: 0, right: 300, width: 300 } as DOMRect;
      if (this.getAttribute("role") === "tab" && this.getAttribute("aria-selected") === "true") {
        const offset = this.parentElement?.scrollLeft ?? 0;
        return {
          ...rect,
          left: 200 - offset,
          right: (this.textContent === "Fechas y turnos" ? 400 : 280) - offset,
        } as DOMRect;
      }
      return rect;
    };
    const view = renderApp(<ChangingLabels />);
    try {
      const list = screen.getByRole("tablist", { name: "Staff sections" });
      const scrollY = window.scrollY;
      expect(list.scrollLeft).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Translate tabs" }));
      await waitFor(() => expect(list.scrollLeft).toBe(100));
      expect(window.scrollY).toBe(scrollY);
    } finally {
      view.unmount();
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
  test("exposes a tablist with the active tab selected and its panel shown", () => {
    renderApp(
      <Tabs label="Staff sections" items={items} value="hours" onValueChange={() => {}}>
        <TabPanel value="hours">Hours panel</TabPanel>
        <TabPanel value="timeoff">Time off panel</TabPanel>
      </Tabs>,
    );
    expect(screen.getByRole("tablist", { name: "Staff sections" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Working hours" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Hours panel")).toBeVisible();
    expect(screen.queryByText("Time off panel")).toBeNull();
  });

  test("choosing a tab reports its value", () => {
    const onValueChange = mock();
    renderApp(
      <Tabs label="Staff sections" items={items} value="hours" onValueChange={onValueChange}>
        <TabPanel value="hours">Hours panel</TabPanel>
      </Tabs>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Time off" }));
    expect(onValueChange).toHaveBeenCalledWith("timeoff");
  });
});
