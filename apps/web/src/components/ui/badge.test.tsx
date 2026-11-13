import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { Badge, statusTone } from "./badge";

describe("Badge", () => {
  test("renders its text with a tone class", () => {
    renderApp(<Badge tone="success">Completed</Badge>);
    expect(screen.getByText("Completed").className).toContain("bg-success-soft");
  });

  test("maps appointment statuses to tones", () => {
    expect(statusTone("booked")).toBe("accent");
    expect(statusTone("completed")).toBe("success");
    expect(statusTone("cancelled")).toBe("neutral");
    expect(statusTone("no_show")).toBe("danger");
  });
});
