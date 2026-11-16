import type { IntakeAnswers, IntakeDefinition, IntakeField } from "@sob/contracts";
import { useId } from "react";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { useI18n } from "~/i18n/react";

export function IntakeQuestions({
  definition,
  answers,
  onChange,
  disabled = false,
  readOnly = false,
}: {
  definition: IntakeDefinition;
  answers: IntakeAnswers;
  onChange?: (answers: IntakeAnswers) => void;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const prefix = useId();
  const set = (field: IntakeField, value: IntakeAnswers[string] | undefined) => {
    const next = { ...answers };
    if (value === undefined) delete next[field.id];
    else next[field.id] = value;
    onChange?.(next);
  };
  return (
    <div className="space-y-5">
      {definition.fields.map((field) => {
        const value = answers[field.id];
        const label = field.label;
        if (readOnly) {
          const display =
            value === undefined
              ? t("intake.unanswered")
              : typeof value === "boolean"
                ? t(value ? "intake.yes" : "intake.no")
                : field.kind === "single_choice"
                  ? (field.options.find((option) => option.id === value)?.label ??
                    t("intake.unanswered"))
                  : field.kind === "multiple_choice" && Array.isArray(value)
                    ? field.options
                        .filter((option) => value.includes(option.id))
                        .map((option) => option.label)
                        .join(", ")
                    : String(value);
          return (
            <div key={field.id}>
              <p className="font-medium">{label}</p>
              {field.help && <p className="text-sm text-muted whitespace-pre-wrap">{field.help}</p>}
              <p className="mt-1 break-words whitespace-pre-wrap">{display}</p>
            </div>
          );
        }
        const common = {
          label,
          hint: field.help || (field.required ? t("intake.required") : undefined),
          disabled,
          required: field.required,
        };
        if (field.kind === "text" || field.kind === "textarea") {
          const props = {
            ...common,
            value: typeof value === "string" ? value : "",
            maxLength: field.maxLength,
            onChange: (event: { target: { value: string } }) => set(field, event.target.value),
          };
          return field.kind === "text" ? (
            <TextField key={field.id} {...props} />
          ) : (
            <TextAreaField key={field.id} {...props} rows={3} />
          );
        }
        if (field.kind === "number")
          return (
            <TextField
              key={field.id}
              {...common}
              type="number"
              step="any"
              min={field.minimum ?? undefined}
              max={field.maximum ?? undefined}
              value={typeof value === "number" ? value : ""}
              onChange={(event) =>
                set(field, event.target.value === "" ? undefined : Number(event.target.value))
              }
            />
          );
        if (field.kind === "date")
          return (
            <TextField
              key={field.id}
              {...common}
              type="date"
              value={typeof value === "string" ? value : ""}
              onChange={(event) => set(field, event.target.value || undefined)}
            />
          );
        if (field.kind === "boolean" || field.kind === "single_choice")
          return (
            <SelectField
              key={field.id}
              {...common}
              value={value === undefined ? "" : String(value)}
              onChange={(selected) =>
                set(
                  field,
                  !selected ? undefined : field.kind === "boolean" ? selected === "true" : selected,
                )
              }
              options={[
                { value: "", label: t("intake.choose") },
                ...(field.kind === "boolean"
                  ? [
                      { value: "true", label: t("intake.yes") },
                      { value: "false", label: t("intake.no") },
                    ]
                  : field.options.map((option) => ({ value: option.id, label: option.label }))),
              ]}
            />
          );
        if (field.kind === "consent")
          return (
            <div key={field.id}>
              <label className="flex min-h-11 items-start gap-3 py-2">
                <input
                  id={`${prefix}-${field.id}`}
                  type="checkbox"
                  className="mt-1 size-5 shrink-0 accent-accent"
                  checked={value === true}
                  disabled={disabled}
                  required={field.required}
                  onChange={(event) => set(field, event.target.checked)}
                />
                <span className="min-w-0 break-words whitespace-pre-wrap">{label}</span>
              </label>
              {field.help && <p className="text-sm text-muted">{field.help}</p>}
            </div>
          );
        if (field.kind === "multiple_choice")
          return (
            <fieldset key={field.id} disabled={disabled} className="space-y-1">
              <legend className="font-medium">{label}</legend>
              {field.help && <p className="text-sm text-muted">{field.help}</p>}
              {field.options.map((option) => (
                <label key={option.id} className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-accent"
                    checked={Array.isArray(value) && value.includes(option.id)}
                    onChange={(event) =>
                      set(
                        field,
                        event.target.checked
                          ? [...(Array.isArray(value) ? value : []), option.id]
                          : (Array.isArray(value) ? value : []).filter((id) => id !== option.id),
                      )
                    }
                  />
                  <span className="break-words">{option.label}</span>
                </label>
              ))}
            </fieldset>
          );
        return null;
      })}
    </div>
  );
}
