import { type ClientContactDetails, clientContactDetailsSchema } from "@sob/contracts";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { useI18n } from "~/i18n/react";
import { inputCents } from "../commerce/money";

export const contactDraft = (details: ClientContactDetails = {}) => ({
  firstName: details.firstName ?? "",
  lastName: details.lastName ?? "",
  taxId: details.taxId ?? "",
  address: details.address ?? "",
  month: details.birthday ? String(details.birthday.month) : "",
  day: details.birthday ? String(details.birthday.day) : "",
  year: details.birthday?.year ? String(details.birthday.year) : "",
  discount: String((details.discountBasisPoints ?? 0) / 100),
});
export type ContactDraft = ReturnType<typeof contactDraft>;
export function contactDetailsInput(value: ContactDraft) {
  return {
    firstName: value.firstName,
    lastName: value.lastName,
    taxId: value.taxId,
    address: value.address,
    birthday:
      value.month || value.day || value.year
        ? {
            month: Number(value.month),
            day: Number(value.day),
            year: value.year ? Number(value.year) : null,
          }
        : null,
    discountBasisPoints: inputCents(value.discount),
  };
}
export const parseContactDraft = (value: ContactDraft) =>
  clientContactDetailsSchema.safeParse(contactDetailsInput(value));
export function ContactDetailFields({
  value,
  onChange,
  errors = {},
  includeNames = true,
}: {
  value: ContactDraft;
  onChange: (key: keyof ContactDraft, value: string) => void;
  errors?: Record<string, string>;
  includeNames?: boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <>
      {includeNames && (
        <>
          <TextField
            label={t("pos.firstName")}
            value={value.firstName}
            maxLength={100}
            onChange={(e) => onChange("firstName", e.target.value)}
            error={errors.firstName}
          />
          <TextField
            label={t("pos.lastName")}
            value={value.lastName}
            maxLength={100}
            onChange={(e) => onChange("lastName", e.target.value)}
            error={errors.lastName}
          />
        </>
      )}
      <TextField
        label={t("pos.taxId")}
        value={value.taxId}
        maxLength={50}
        onChange={(e) => onChange("taxId", e.target.value)}
        error={errors.taxId}
      />
      <TextField
        label={t("pos.customerDiscount")}
        inputMode="decimal"
        value={value.discount}
        onChange={(e) => onChange("discount", e.target.value)}
        error={errors.discountBasisPoints}
      />
      <TextAreaField
        label={t("pos.address")}
        value={value.address}
        maxLength={500}
        onChange={(e) => onChange("address", e.target.value)}
        error={errors.address}
      />
      <fieldset className="sm:col-span-2">
        <legend className="mb-2 text-sm font-medium">{t("pos.birthday")}</legend>
        <div className="grid grid-cols-3 gap-3">
          <SelectField
            label={t("pos.month")}
            value={value.month}
            options={[
              { value: "", label: "—" },
              ...Array.from({ length: 12 }, (_, i) => ({
                value: String(i + 1),
                label: new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(
                  new Date(Date.UTC(2000, i, 1)),
                ),
              })),
            ]}
            onChange={(next) => onChange("month", next)}
          />
          <TextField
            label={t("pos.day")}
            type="number"
            min={1}
            max={31}
            value={value.day}
            onChange={(e) => onChange("day", e.target.value)}
          />
          <TextField
            label={t("pos.yearOptional")}
            type="number"
            min={1900}
            max={new Date().getFullYear()}
            value={value.year}
            onChange={(e) => onChange("year", e.target.value)}
          />
        </div>
        {errors.birthday && (
          <p role="alert" className="mt-2 text-sm text-danger-fg">
            {errors.birthday}
          </p>
        )}
      </fieldset>
    </>
  );
}
