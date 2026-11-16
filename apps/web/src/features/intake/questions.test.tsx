import { expect, test } from "bun:test";
import { type IntakeAnswers, intakeDefinitionSchema, validateIntakeAnswers } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { IntakeQuestions } from "./questions";

const IDs = Array.from({ length: 4 }, (_, i) => `0198f5a0-7b1c-7000-8000-00000000000${i + 1}`);
const definition = intakeDefinitionSchema.parse({
  title: "Visit form",
  fields: [
    { id: IDs[0], label: "Previous treatment?", kind: "boolean", required: true },
    { id: IDs[1], label: "How many?", kind: "number", required: true, minimum: 0 },
    { id: IDs[2], label: "I agree to the displayed terms", kind: "consent", required: true },
    { id: IDs[3], label: "Preferences", kind: "textarea", required: true },
  ],
});
function Example() {
  const [answers, setAnswers] = useState<IntakeAnswers>({});
  return (
    <>
      <IntakeQuestions definition={definition} answers={answers} onChange={setAnswers} />
      <output aria-label="Answer issues">
        {validateIntakeAnswers(definition, answers).length}
      </output>
      <output aria-label="Answers">{JSON.stringify(answers)}</output>
    </>
  );
}
test("questions preserve explicit no and zero, require consent and never coerce an empty number into zero", () => {
  renderApp(<Example />);
  expect(screen.getByLabelText("Answer issues").textContent).toBe("4");
  fireEvent.change(screen.getByLabelText("Previous treatment?"), { target: { value: "false" } });
  fireEvent.change(screen.getByLabelText("How many?"), { target: { value: "0" } });
  fireEvent.click(screen.getByLabelText("I agree to the displayed terms"));
  fireEvent.change(screen.getByLabelText("Preferences"), { target: { value: "Short style" } });
  expect(screen.getByLabelText("Answer issues").textContent).toBe("0");
  const answers = JSON.parse(screen.getByLabelText("Answers").textContent ?? "{}");
  expect(answers[IDs[0] ?? ""]).toBe(false);
  expect(answers[IDs[1] ?? ""]).toBe(0);
  fireEvent.change(screen.getByLabelText("How many?"), { target: { value: "" } });
  expect(screen.getByLabelText("Answer issues").textContent).toBe("1");
});
