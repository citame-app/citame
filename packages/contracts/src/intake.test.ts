import { expect, test } from "bun:test";
import {
  intakeDefinitionSchema,
  intakeSubmissionInputSchema,
  validateIntakeAnswers,
} from "./intake";

const id = (n: number) => `0198f5a0-7b1c-7000-8000-${String(n).padStart(12, "0")}`;
const definition = () => ({
  title: "Visit preparation",
  description: "Questions supplied by the salon",
  kind: "intake",
  allServices: true,
  serviceIds: [],
  requiredAtBooking: true,
  allowTeamResponses: true,
  fields: [
    { id: id(1), kind: "boolean", label: "First visit?", required: true },
    { id: id(2), kind: "text", label: "Preferences", required: true, maxLength: 200 },
    { id: id(3), kind: "date", label: "Preferred date", required: false },
    {
      id: id(4),
      kind: "number",
      label: "Preference level",
      required: false,
      minimum: 0,
      maximum: 10,
    },
    {
      id: id(5),
      kind: "single_choice",
      label: "Choose one",
      required: true,
      options: [
        { id: id(10), label: "One" },
        { id: id(11), label: "Two" },
      ],
    },
    {
      id: id(6),
      kind: "multiple_choice",
      label: "Choose several",
      required: false,
      options: [
        { id: id(12), label: "A" },
        { id: id(13), label: "B" },
      ],
    },
    {
      id: id(7),
      kind: "consent",
      label: "I have reviewed the displayed information",
      required: true,
    },
  ],
});
const validAnswers = () => ({
  [id(1)]: false,
  [id(2)]: "Please explain the process",
  [id(3)]: "2026-03-09",
  [id(4)]: 0,
  [id(5)]: id(10),
  [id(6)]: [id(12)],
  [id(7)]: true,
});

test("form definitions require stable unique questions, explicit service scope and an affirmative waiver field", () => {
  expect(intakeDefinitionSchema.safeParse(definition()).success).toBe(true);
  const form = definition();
  for (const change of [
    { fields: [] },
    { fields: [form.fields[0], form.fields[0]] },
    { allServices: false, serviceIds: [] },
    { allServices: true, serviceIds: [id(100)] },
    { kind: "waiver", fields: [form.fields[0]] },
    { fields: Array.from({ length: 31 }, (_, n) => ({ ...form.fields[0], id: id(200 + n) })) },
  ])
    expect(intakeDefinitionSchema.safeParse({ ...form, ...change }).success).toBe(false);
});
test("choice labels and option identities cannot be ambiguous and number bounds must be ordered", () => {
  const form = definition();
  const choice = form.fields[4];
  expect(
    intakeDefinitionSchema.safeParse({
      ...form,
      fields: [
        {
          ...choice,
          options: [
            { id: id(10), label: "One" },
            { id: id(10), label: "Two" },
          ],
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    intakeDefinitionSchema.safeParse({
      ...form,
      fields: [
        {
          ...choice,
          options: [
            { id: id(10), label: "One" },
            { id: id(11), label: " ONE " },
          ],
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    intakeDefinitionSchema.safeParse({
      ...form,
      fields: [
        { id: id(4), kind: "number", label: "Number", required: true, minimum: 10, maximum: 1 },
      ],
    }).success,
  ).toBe(false);
});
test("false and zero are answers; required consent must be explicitly affirmative", () => {
  const form = intakeDefinitionSchema.parse(definition());
  expect(validateIntakeAnswers(form, validAnswers())).toEqual([]);
  expect(validateIntakeAnswers(form, { ...validAnswers(), [id(7)]: false })).toEqual([
    { fieldId: id(7), code: "consent" },
  ]);
  expect(validateIntakeAnswers(form, { ...validAnswers(), [id(1)]: undefined })).toEqual([
    { fieldId: id(1), code: "required" },
  ]);
  expect(validateIntakeAnswers(form, { ...validAnswers(), [id(2)]: "   " })).toEqual([
    { fieldId: id(2), code: "required" },
  ]);
});
test("answers bind the published question types, dates, bounds and choice options", () => {
  const form = intakeDefinitionSchema.parse(definition());
  for (const [fieldId, value, code] of [
    [id(1), "false", "boolean"],
    [id(2), "x".repeat(201), "text"],
    [id(3), "2026-02-30", "date"],
    [id(4), 11, "number"],
    [id(5), id(99), "choice"],
    [id(6), [id(12), id(12)], "choice"],
  ] as const)
    expect(validateIntakeAnswers(form, { ...validAnswers(), [fieldId]: value })).toEqual([
      { fieldId, code },
    ]);
  expect(validateIntakeAnswers(form, { ...validAnswers(), [id(999)]: "Unshown question" })).toEqual(
    [{ fieldId: id(999), code: "unexpected" }],
  );
});
test("optional consent may be declined without silently becoming permission", () => {
  const form = intakeDefinitionSchema.parse({
    ...definition(),
    fields: [{ id: id(7), kind: "consent", label: "Optional permission", required: false }],
  });
  expect(validateIntakeAnswers(form, { [id(7)]: false })).toEqual([]);
  expect(validateIntakeAnswers(form, {})).toEqual([]);
});
test("submissions require explicit confirmation and a bounded, typed answer envelope", () => {
  const input = {
    idempotencyKey: id(900),
    revisionId: id(901),
    confirmation: true,
    answers: validAnswers(),
  };
  expect(intakeSubmissionInputSchema.safeParse(input).success).toBe(true);
  for (const change of [
    { confirmation: false },
    { source: "client" },
    { answers: { [id(1)]: { hidden: "object" } } },
    { answers: { [id(1)]: Number.POSITIVE_INFINITY } },
    { answers: { [id(1)]: "x".repeat(4001) } },
  ])
    expect(intakeSubmissionInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
});
