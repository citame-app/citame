import { describe, expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { PasswordField, TextField } from "./field";

describe("TextField", () => {
  test("associates the label with the input", () => {
    renderApp(<TextField label="Email" name="email" type="email" />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
  });

  test("ties hint and error to the input and flags it invalid", () => {
    renderApp(
      <TextField label="Email" name="email" hint="We never share it" error="Enter a valid email" />,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const error = screen.getByText("Enter a valid email");
    const hint = screen.getByText("We never share it");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toContain(error.id);
    expect(describedBy).toContain(hint.id);
  });

  test("a field without an error is not marked invalid", () => {
    renderApp(<TextField label="Name" name="name" />);
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("marks required fields without relying on color alone", () => {
    renderApp(<TextField label="Name" name="name" required />);
    expect(screen.getByLabelText(/Name/)).toBeRequired();
  });

  test("uses a 16px+ font on the input so iOS does not zoom on focus", () => {
    renderApp(<TextField label="Name" name="name" />);
    expect(screen.getByLabelText("Name").className).toContain("text-base");
  });
});

describe("PasswordField", () => {
  test("hides the password and toggles visibility with an accessible button", () => {
    renderApp(<PasswordField label="Password" name="password" />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
