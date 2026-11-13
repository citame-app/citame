import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { useToast } from "./toast";

function Trigger() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success("Appointment cancelled")}>
        success
      </button>
      <button type="button" onClick={() => toast.error("Something went wrong")}>
        error
      </button>
    </>
  );
}

describe("toast", () => {
  test("shows a success message and an error message", async () => {
    renderApp(<Trigger />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "success" }));
    });
    expect(await screen.findByText("Appointment cancelled")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "error" }));
    });
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
  });

  test("toasts can be dismissed with a labelled button", async () => {
    renderApp(<Trigger />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "success" }));
    });
    const dismiss = await screen.findByLabelText("Dismiss");
    await act(async () => {
      fireEvent.click(dismiss);
    });
    await waitFor(() =>
      expect(screen.queryByText("Appointment cancelled")).not.toBeInTheDocument(),
    );
  });
});
