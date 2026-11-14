import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { Sheet } from "./sheet";

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
