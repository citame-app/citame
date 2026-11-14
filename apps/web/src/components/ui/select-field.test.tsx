import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { SelectField, TextAreaField } from "./select-field";

describe("SelectField", () => {
  const options = [
    { value: "a", label: "Ana" },
    { value: "b", label: "Bea" },
  ];

  test("is a labelled native select with its options", () => {
    renderApp(<SelectField label="Team member" value="b" options={options} onChange={() => {}} />);
    const select = screen.getByLabelText("Team member");
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveValue("b");
    expect(screen.getByRole("option", { name: "Ana" })).toBeInTheDocument();
  });

  test("reports the chosen value", () => {
    const onChange = mock();
    renderApp(<SelectField label="Team member" value="a" options={options} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Team member"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  test("ties an error message to the control", () => {
    renderApp(
      <SelectField
        label="Team member"
        value=""
        options={options}
        onChange={() => {}}
        error="Choose a team member"
      />,
    );
    const select = screen.getByLabelText("Team member");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAccessibleDescription("Choose a team member");
  });
});

describe("TextAreaField", () => {
  test("is labelled and reports changes", () => {
    const onChange = mock();
    renderApp(
      <TextAreaField label="Notes" value="hi" onChange={(e) => onChange(e.target.value)} />,
    );
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledWith("hello");
  });
});
