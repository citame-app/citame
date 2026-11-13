import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../test/render";
import { LocaleSwitch, ThemeToggle } from "./shell";

describe("ThemeToggle", () => {
  test("switches to dark, stores the choice and offers the way back", () => {
    renderApp(<ThemeToggle initial={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("sob_theme=dark");
    fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.cookie).toContain("sob_theme=light");
  });

  test("reports the new theme so the app can keep its own copy in sync", () => {
    const onChange = mock();
    renderApp(<ThemeToggle initial="light" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  test("starts from the stored theme", () => {
    renderApp(<ThemeToggle initial="dark" />);
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
  });

  test("meets the touch target size", () => {
    renderApp(<ThemeToggle initial="light" />);
    expect(screen.getByRole("button").className).toContain("size-11");
  });
});

describe("LocaleSwitch", () => {
  test("lists both languages, marks the current one and reports a change", () => {
    const onChange = mock();
    renderApp(<LocaleSwitch locale="en" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Español" }));
    expect(onChange).toHaveBeenCalledWith("es-AR");
    expect(document.cookie).toContain("sob_locale=es-AR");
  });
});
