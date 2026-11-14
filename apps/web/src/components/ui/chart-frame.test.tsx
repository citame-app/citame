import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { ChartFrame } from "./chart-frame";

const table = {
  caption: "Revenue per day",
  columns: ["Date", "Revenue"],
  rows: [
    ["Mon 9", "$15,000"],
    ["Tue 10", "$10,000"],
  ],
};

describe("ChartFrame", () => {
  test("is a figure with a text summary for screen readers", () => {
    renderApp(
      <ChartFrame title="Revenue" summary="Revenue rose to $25,000 across 2 days" table={table}>
        <svg data-testid="chart" />
      </ChartFrame>,
    );
    const figure = screen.getByRole("figure", { name: "Revenue" });
    expect(within(figure).getByText("Revenue rose to $25,000 across 2 days")).toBeInTheDocument();
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });

  test("the data table alternative is one click away and complete", () => {
    renderApp(
      <ChartFrame title="Revenue" summary="s" table={table}>
        <svg />
      </ChartFrame>,
    );
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show data table" }));
    const data = screen.getByRole("table", { name: "Revenue per day" });
    expect(within(data).getAllByRole("row")).toHaveLength(3);
    expect(within(data).getByRole("cell", { name: "$10,000" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide data table" }));
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("an empty chart shows a clear empty state instead of the plot", () => {
    renderApp(
      <ChartFrame title="Revenue" summary="s" table={{ ...table, rows: [] }} empty>
        <svg data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByText("No data for this period")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).toBeNull();
  });
});
