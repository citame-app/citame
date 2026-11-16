import { z } from "zod";
import { idSchema, instantSchema, localDateSchema } from "./common";

const uniqueIds = (values: string[]) =>
  new Set(values.map((value) => value.toLowerCase())).size === values.length;
const plainText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => !value.includes("\u0000"), "Null characters are not supported");
const title = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]+$/u);
const fieldBase = z.object({
  id: idSchema,
  label: title,
  help: plainText(500).default(""),
  required: z.boolean().default(false),
});
const options = z
  .array(z.object({ id: idSchema, label: title.max(120) }).strict())
  .min(1)
  .max(30)
  .superRefine((values, ctx) => {
    if (!uniqueIds(values.map((value) => value.id)))
      ctx.addIssue({ code: "custom", message: "Choice identities must be unique" });
    if (
      new Set(values.map((value) => value.label.normalize("NFKC").trim().toLowerCase())).size !==
      values.length
    )
      ctx.addIssue({ code: "custom", message: "Choice labels must be distinct" });
  });
export const intakeFieldSchema = z.discriminatedUnion("kind", [
  fieldBase
    .extend({ kind: z.literal("text"), maxLength: z.number().int().min(1).max(4000).default(200) })
    .strict(),
  fieldBase
    .extend({
      kind: z.literal("textarea"),
      maxLength: z.number().int().min(1).max(4000).default(2000),
    })
    .strict(),
  fieldBase.extend({ kind: z.literal("date") }).strict(),
  fieldBase.extend({ kind: z.literal("boolean") }).strict(),
  fieldBase.extend({ kind: z.literal("consent") }).strict(),
  fieldBase.extend({ kind: z.literal("single_choice"), options }).strict(),
  fieldBase.extend({ kind: z.literal("multiple_choice"), options }).strict(),
  fieldBase
    .extend({
      kind: z.literal("number"),
      minimum: z.number().finite().nullable().default(null),
      maximum: z.number().finite().nullable().default(null),
    })
    .strict(),
]);
export const intakeDefinitionSchema = z
  .object({
    kind: z.enum(["intake", "waiver"]).default("intake"),
    title: title.max(120),
    description: plainText(12000).default(""),
    fields: z.array(intakeFieldSchema).min(1).max(30),
    requiredAtBooking: z.boolean().default(false),
    allowTeamResponses: z.boolean().default(false),
    allServices: z.boolean().default(true),
    serviceIds: z.array(idSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!uniqueIds(value.fields.map((field) => field.id)))
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: "Question identities must be unique",
      });
    if (
      !uniqueIds(value.serviceIds) ||
      (value.allServices ? value.serviceIds.length !== 0 : value.serviceIds.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["serviceIds"],
        message: "Choose all services or a unique explicit service selection",
      });
    if (
      value.kind === "waiver" &&
      !value.fields.some((field) => field.kind === "consent" && field.required)
    )
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: "A waiver needs an explicitly required consent question",
      });
    value.fields.forEach((field, index) => {
      if (
        field.kind === "number" &&
        field.minimum !== null &&
        field.maximum !== null &&
        field.minimum > field.maximum
      )
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "maximum"],
          message: "The upper bound must not precede the lower bound",
        });
    });
  });
export const intakeAnswersSchema = z
  .record(
    idSchema,
    z.union([plainText(4000), z.boolean(), z.number().finite(), z.array(idSchema).max(30)]),
  )
  .refine(
    (value) => Object.keys(value).length <= 30 && uniqueIds(Object.keys(value)),
    "Answer up to 30 unique questions",
  );
export const intakeSubmissionInputSchema = z
  .object({
    idempotencyKey: idSchema,
    revisionId: idSchema,
    confirmation: z.literal(true),
    appointmentId: idSchema.optional(),
    answers: intakeAnswersSchema,
  })
  .strict();
export const intakeInlineResponseSchema = intakeSubmissionInputSchema.omit({
  idempotencyKey: true,
  appointmentId: true,
});
export const intakeBookingShape = {
  intakeReviewHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  intakeSubmissionIds: z
    .array(idSchema)
    .max(10)
    .refine(uniqueIds, "Choose unique responses")
    .optional(),
  intakeResponses: z
    .array(intakeInlineResponseSchema)
    .max(10)
    .refine(
      (responses) => uniqueIds(responses.map((response) => response.revisionId)),
      "Answer each form once",
    )
    .optional(),
};
/** Clinical choices are part of a retry's identity; review hashes are refreshable fences. */
export function intakeBookingIdentity(input: {
  intakeSubmissionIds?: string[];
  intakeResponses?: z.infer<typeof intakeInlineResponseSchema>[];
}): string {
  if (!input.intakeSubmissionIds?.length && !input.intakeResponses?.length) return "";
  return JSON.stringify({
    ids: [...(input.intakeSubmissionIds ?? [])].sort(),
    responses: [...(input.intakeResponses ?? [])]
      .sort((a, b) => (a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0))
      .map((response) => ({
        revisionId: response.revisionId,
        answers: Object.fromEntries(
          Object.entries(response.answers)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .flatMap(([key, value]) =>
              (typeof value === "string" && !value.trim()) ||
              (Array.isArray(value) && !value.length)
                ? []
                : [
                    [
                      key,
                      typeof value === "string"
                        ? value.trim()
                        : Array.isArray(value)
                          ? [...value].sort()
                          : value,
                    ],
                  ],
            ),
        ),
      })),
  });
}
export const intakeDraftInputSchema = z
  .object({ version: z.number().int().positive(), definition: intakeDefinitionSchema })
  .strict();
export const intakeCreateInputSchema = z
  .object({ idempotencyKey: idSchema, definition: intakeDefinitionSchema })
  .strict();
export const intakeRevisionSchema = z.object({
  id: idSchema,
  formId: idSchema,
  number: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  definition: intakeDefinitionSchema,
  createdAt: instantSchema,
});
export const intakeAdminFormSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  active: z.boolean(),
  draft: intakeDefinitionSchema,
  published: intakeRevisionSchema.nullable(),
  updatedAt: instantSchema,
});
export type IntakeDefinition = z.infer<typeof intakeDefinitionSchema>;
export type IntakeField = z.infer<typeof intakeFieldSchema>;
export type IntakeAnswers = z.infer<typeof intakeAnswersSchema>;
export type IntakeSubmissionInput = z.infer<typeof intakeSubmissionInputSchema>;
export type IntakeRevision = z.infer<typeof intakeRevisionSchema>;
export type IntakeAdminForm = z.infer<typeof intakeAdminFormSchema>;
export const intakeVersionInputSchema = z.object({ version: z.number().int().positive() }).strict();
export const intakeRequirementsQuerySchema = z
  .object({
    clientId: idSchema.optional(),
    serviceIds: z
      .string()
      .transform((value) => value.split(","))
      .pipe(z.array(idSchema).min(1).max(24).refine(uniqueIds, "Choose unique services")),
  })
  .strict();
export const intakeRequirementsSchema = z.object({
  forms: z.array(intakeRevisionSchema).max(10),
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  readyResponses: z
    .array(z.object({ id: idSchema, revisionId: idSchema, createdAt: instantSchema }))
    .max(10)
    .default([]),
});
export const intakeFormsSchema = z.object({ forms: z.array(intakeAdminFormSchema).max(100) });
export const intakeSubmissionSchema = z.object({
  id: idSchema,
  clientId: idSchema,
  appointmentId: idSchema.nullable(),
  source: z.enum(["client", "team"]),
  confirmationVersion: z.string(),
  createdAt: instantSchema,
  answers: intakeAnswersSchema,
  revision: intakeRevisionSchema,
});
export const intakeSubmissionsQuerySchema = z.object({ before: idSchema.optional() }).strict();
export const intakeSubmissionsSchema = z.object({
  submissions: z
    .array(
      z.object({
        id: idSchema,
        clientId: idSchema,
        appointmentId: idSchema.nullable(),
        source: z.enum(["client", "team"]),
        createdAt: instantSchema,
        revisionId: idSchema,
        formId: idSchema,
        formTitle: z.string(),
        number: z.number().int().positive(),
      }),
    )
    .max(20),
  nextCursor: idSchema.nullable(),
});
export type IntakeSubmission = z.infer<typeof intakeSubmissionSchema>;
export type IntakeAnswerIssue = {
  fieldId: string;
  code: "required" | "text" | "date" | "number" | "boolean" | "choice" | "consent" | "unexpected";
};

/** Definition-specific checks retain false/zero and never coerce an unreviewed answer. */
export function validateIntakeAnswers(
  definition: IntakeDefinition,
  answers: Record<string, unknown>,
): IntakeAnswerIssue[] {
  const issues: IntakeAnswerIssue[] = [];
  const known = new Set(definition.fields.map((field) => field.id));
  for (const key of Object.keys(answers))
    if (!known.has(key)) issues.push({ fieldId: key, code: "unexpected" });
  for (const field of definition.fields) {
    const value = answers[field.id];
    const add = (code: IntakeAnswerIssue["code"]) => issues.push({ fieldId: field.id, code });
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && !value.trim()) ||
      (Array.isArray(value) && !value.length);
    if (empty) {
      if (field.required) add("required");
      continue;
    }
    switch (field.kind) {
      case "text":
      case "textarea":
        if (typeof value !== "string" || value.length > field.maxLength || value.includes("\u0000"))
          add("text");
        break;
      case "date":
        if (!localDateSchema.safeParse(value).success) add("date");
        break;
      case "boolean":
        if (typeof value !== "boolean") add("boolean");
        break;
      case "consent":
        if (typeof value !== "boolean" || (field.required && value !== true)) add("consent");
        break;
      case "number":
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          (field.minimum !== null && value < field.minimum) ||
          (field.maximum !== null && value > field.maximum)
        )
          add("number");
        break;
      case "single_choice":
        if (typeof value !== "string" || !field.options.some((option) => option.id === value))
          add("choice");
        break;
      case "multiple_choice":
        if (
          !Array.isArray(value) ||
          value.some(
            (id) => typeof id !== "string" || !field.options.some((option) => option.id === id),
          ) ||
          new Set(value).size !== value.length
        )
          add("choice");
        break;
    }
  }
  return issues;
}
