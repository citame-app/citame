import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { TabPanel, Tabs } from "./tabs";

const items = [
  { value: "hours", label: "Working hours" },
  { value: "timeoff", label: "Time off" },
];

describe("Tabs", () => {
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
