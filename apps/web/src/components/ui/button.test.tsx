import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { Button, buttonClasses } from "./button";

describe("Button", () => {
  test("renders a button that defaults to type=button so forms are not submitted by accident", () => {
    renderApp(<Button>Continue</Button>);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toHaveAttribute("type", "button");
  });

  test("calls onClick", () => {
    const onClick = mock();
    renderApp(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("loading disables the button, announces busy and swallows clicks", () => {
    const onClick = mock();
    renderApp(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: /Save/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("meets the 44px touch target at every size", () => {
    for (const size of ["md", "lg"] as const) {
      expect(buttonClasses({ size })).toContain("min-h-11");
    }
  });

  test("variants change the look but keep a visible focus treatment", () => {
    expect(buttonClasses({ variant: "primary" })).toContain("bg-accent");
    expect(buttonClasses({ variant: "danger" })).toContain("danger");
    expect(buttonClasses({ variant: "ghost" })).not.toContain("bg-accent ");
  });
});
