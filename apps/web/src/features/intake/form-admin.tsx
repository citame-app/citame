import {
  type IntakeAdminForm,
  type IntakeDefinition,
  type IntakeField,
  intakeDefinitionSchema,
} from "@sob/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { servicesQuery } from "~/lib/queries";
import { IntakeQuestions } from "./questions";

function question(kind: IntakeField["kind"] = "text", existing?: IntakeField): IntakeField {
  const base = {
    id: existing?.id ?? crypto.randomUUID(),
    label: existing?.label ?? "",
    help: existing?.help ?? "",
    required: existing?.required ?? false,
  };
  if (kind === "text" || kind === "textarea")
    return { ...base, kind, maxLength: kind === "text" ? 200 : 2000 };
  if (kind === "single_choice" || kind === "multiple_choice")
    return { ...base, kind, options: [{ id: crypto.randomUUID(), label: "" }] };
  if (kind === "number") return { ...base, kind, minimum: null, maximum: null };
  return { ...base, kind };
}
const blank = (): IntakeDefinition => ({
  kind: "intake",
  title: "",
  description: "",
  fields: [question()],
  requiredAtBooking: false,
  allowTeamResponses: false,
  allServices: true,
  serviceIds: [],
});
const kinds = [
  "text",
  "textarea",
  "date",
  "boolean",
  "consent",
  "single_choice",
  "multiple_choice",
  "number",
] as const;

export function IntakeAdmin({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const online = useOnline();
  const toast = useToast();
  const forms = useQuery({ queryKey: ["intake", "admin"], queryFn: () => api().intake.forms() });
  const services = useQuery(servicesQuery);
  const [current, setCurrent] = useState<IntakeAdminForm | null>(null);
  const [draft, setDraft] = useState<IntakeDefinition | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [review, setReview] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [discard, setDiscard] = useState<null | (() => void)>(null);
  const [invalid, setInvalid] = useState(false);
  const dirty =
    Boolean(draft) && (!current || JSON.stringify(draft) !== JSON.stringify(current.draft));
  const save = useMutation({
    mutationFn: () => {
      const parsed = intakeDefinitionSchema.safeParse(draft);
      if (!parsed.success) throw new Error(t("intake.invalid"));
      return current
        ? api().intake.save(current.id, current.version, parsed.data)
        : api().intake.create({ idempotencyKey: key, definition: parsed.data });
    },
    onSuccess: (saved) => {
      setCurrent(saved);
      setDraft(saved.draft);
      toast.success(t("intake.saved"));
      void forms.refetch();
    },
  });
  const publish = useMutation({
    mutationFn: () => {
      if (!current || dirty) throw new Error("Save the draft before publishing");
      return api().intake.publish(current.id, current.version);
    },
    onSuccess: (saved) => {
      setReview(false);
      setCurrent(saved);
      setDraft(saved.draft);
      void forms.refetch();
    },
  });
  const archive = useMutation({
    mutationFn: () => {
      if (!current) throw new Error("Select a published form");
      return api().intake.archive(current.id, current.version);
    },
    onSuccess: (saved) => {
      setArchiving(false);
      setCurrent(saved);
      setDraft(saved.draft);
      void forms.refetch();
    },
  });
  const reload = useMutation({
    mutationFn: () => api().intake.forms(),
    onSuccess: (data) => {
      if (!current) return;
      const saved = data.forms.find((form) => form.id === current.id);
      if (saved) {
        setCurrent(saved);
        setDraft(saved.draft);
        setInvalid(false);
        save.reset();
        publish.reset();
        archive.reset();
      }
      void forms.refetch();
    },
  });
  const busy = save.isPending || publish.isPending || archive.isPending || reload.isPending;
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  function select(form: IntakeAdminForm | null) {
    const action = () => {
      setCurrent(form);
      setDraft(form?.draft ?? blank());
      setKey(crypto.randomUUID());
      setInvalid(false);
      save.reset();
      publish.reset();
      archive.reset();
    };
    if (dirty) setDiscard(() => action);
    else action();
  }
  function update(change: Partial<IntakeDefinition>) {
    if (draft) {
      setDraft({ ...draft, ...change });
      setInvalid(false);
    }
  }
  function field(index: number, next: IntakeField) {
    if (draft) update({ fields: draft.fields.map((value, i) => (i === index ? next : value)) });
  }
  function move(index: number, offset: number) {
    if (!draft) return;
    const fields = [...draft.fields];
    const value = fields[index];
    const other = fields[index + offset];
    if (!value || !other) return;
    fields[index] = other;
    fields[index + offset] = value;
    update({ fields });
  }
  const failure = save.error ?? publish.error ?? archive.error ?? reload.error;
  if (forms.isPending && !forms.data) return <Skeleton className="h-24" />;
  return (
    <section
      aria-label={t("intake.title")}
      className="max-w-3xl space-y-5 border-t border-line pt-8"
    >
      <h2 className="text-heading">{t("intake.title")}</h2>
      <p className="text-muted">{t("intake.blank")}</p>
      {forms.isError && <ErrorState error={forms.error} onRetry={() => void forms.refetch()} />}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <SelectField
            label={t("intake.select")}
            value={current?.id ?? ""}
            disabled={busy}
            options={[
              { value: "", label: t("intake.add") },
              ...(forms.data?.forms ?? []).map((form) => ({
                value: form.id,
                label: `${form.draft.title} · ${t(form.active ? "intake.active" : "intake.draft")}`,
              })),
            ]}
            onChange={(id) => select(forms.data?.forms.find((form) => form.id === id) ?? null)}
          />
        </div>
        <Button variant="secondary" disabled={busy} onClick={() => select(null)}>
          {t("intake.add")}
        </Button>
      </div>
      {!forms.data?.forms.length && !draft && <p className="text-muted">{t("intake.noForms")}</p>}
      {draft && (
        <form
          noValidate
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = intakeDefinitionSchema.safeParse(draft);
            setInvalid(!parsed.success);
            if (parsed.success) save.mutate();
          }}
        >
          {current && (
            <p className="text-sm text-muted">
              {t(current.active ? "intake.active" : "intake.draft")}
              {current.published
                ? ` · ${t("intake.version", { number: current.published.number })}`
                : ""}
            </p>
          )}
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <TextField
              label={t("intake.name")}
              value={draft.title}
              maxLength={120}
              required
              onChange={(event) => update({ title: event.target.value })}
            />
            <SelectField
              label={t("intake.kind")}
              value={draft.kind}
              options={[
                { value: "intake", label: t("intake.questionnaire") },
                { value: "waiver", label: t("intake.waiver") },
              ]}
              onChange={(kind) => update({ kind: kind as IntakeDefinition["kind"] })}
            />
            <TextAreaField
              label={t("intake.description")}
              rows={5}
              value={draft.description}
              maxLength={12000}
              onChange={(event) => update({ description: event.target.value })}
            />
            {(["requiredAtBooking", "allowTeamResponses", "allServices"] as const).map(
              (name, index) => (
                <label key={name} className="flex min-h-11 items-start gap-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-5 shrink-0 accent-accent"
                    checked={draft[name]}
                    onChange={(event) =>
                      update({
                        [name]: event.target.checked,
                        ...(name === "allServices" && event.target.checked
                          ? { serviceIds: [] }
                          : {}),
                      })
                    }
                  />
                  <span>
                    {t(
                      index === 0
                        ? "intake.bookingRequired"
                        : index === 1
                          ? "intake.paperAllowed"
                          : "intake.allServices",
                    )}
                  </span>
                </label>
              ),
            )}
            {!draft.allServices && (
              <fieldset className="max-h-72 overflow-y-auto rounded-lg border border-line p-3">
                <legend className="px-1 font-medium">{t("intake.services")}</legend>
                {services.isError && (
                  <ErrorState error={services.error} onRetry={() => void services.refetch()} />
                )}
                {services.data?.map((service) => (
                  <label key={service.id} className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-5 shrink-0 accent-accent"
                      checked={draft.serviceIds.includes(service.id)}
                      onChange={(event) =>
                        update({
                          serviceIds: event.target.checked
                            ? [...draft.serviceIds, service.id]
                            : draft.serviceIds.filter((id) => id !== service.id),
                        })
                      }
                    />
                    <span className="break-words">{service.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <h3 className="font-semibold">{t("intake.questions")}</h3>
            {draft.fields.map((value, index) => (
              <fieldset
                key={value.id}
                className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4"
              >
                <legend className="px-1 font-semibold">
                  {t("intake.question", { number: index + 1 })}
                </legend>
                <TextField
                  label={t("intake.label")}
                  value={value.label}
                  maxLength={200}
                  onChange={(event) => field(index, { ...value, label: event.target.value })}
                />
                <TextAreaField
                  label={t("intake.help")}
                  value={value.help}
                  maxLength={500}
                  onChange={(event) => field(index, { ...value, help: event.target.value })}
                />
                <SelectField
                  label={t("intake.type")}
                  value={value.kind}
                  options={kinds.map((kind) => ({ value: kind, label: t(`intake.${kind}`) }))}
                  onChange={(kind) => field(index, question(kind as IntakeField["kind"], value))}
                />
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5 accent-accent"
                    checked={value.required}
                    onChange={(event) => field(index, { ...value, required: event.target.checked })}
                  />
                  {t("intake.questionRequired")}
                </label>
                {(value.kind === "text" || value.kind === "textarea") && (
                  <TextField
                    type="number"
                    min={1}
                    max={4000}
                    label={t("intake.maxLength")}
                    value={Number.isNaN(value.maxLength) ? "" : value.maxLength}
                    onChange={(event) =>
                      field(index, {
                        ...value,
                        maxLength:
                          event.target.value === "" ? Number.NaN : Number(event.target.value),
                      })
                    }
                  />
                )}
                {value.kind === "number" && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(["minimum", "maximum"] as const).map((bound) => (
                      <TextField
                        key={bound}
                        type="number"
                        step="any"
                        label={t(`intake.${bound}`)}
                        value={value[bound] ?? ""}
                        onChange={(event) =>
                          field(index, {
                            ...value,
                            [bound]: event.target.value === "" ? null : Number(event.target.value),
                          })
                        }
                      />
                    ))}
                  </div>
                )}
                {(value.kind === "single_choice" || value.kind === "multiple_choice") && (
                  <div className="space-y-3">
                    {value.options.map((option, i) => (
                      <div key={option.id} className="flex flex-wrap items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <TextField
                            label={t("intake.option", { number: i + 1 })}
                            value={option.label}
                            maxLength={120}
                            onChange={(event) =>
                              field(index, {
                                ...value,
                                options: value.options.map((item) =>
                                  item.id === option.id
                                    ? { ...item, label: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </div>
                        <Button
                          variant="ghost"
                          disabled={value.options.length <= 1}
                          onClick={() =>
                            field(index, {
                              ...value,
                              options: value.options.filter((item) => item.id !== option.id),
                            })
                          }
                        >
                          {t("intake.removeOption", { number: i + 1 })}
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="secondary"
                      disabled={value.options.length >= 30}
                      onClick={() =>
                        field(index, {
                          ...value,
                          options: [...value.options, { id: crypto.randomUUID(), label: "" }],
                        })
                      }
                    >
                      {t("intake.addOption")}
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
                    {t("intake.moveUp", { number: index + 1 })}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={index === draft.fields.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    {t("intake.moveDown", { number: index + 1 })}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={draft.fields.length <= 1}
                    onClick={() =>
                      update({ fields: draft.fields.filter((item) => item.id !== value.id) })
                    }
                  >
                    {t("intake.removeQuestion", { number: index + 1 })}
                  </Button>
                </div>
              </fieldset>
            ))}
            <Button
              variant="secondary"
              disabled={draft.fields.length >= 30}
              onClick={() => update({ fields: [...draft.fields, question()] })}
            >
              {t("intake.addQuestion")}
            </Button>
          </fieldset>
          {invalid && (
            <p role="alert" className="text-danger-fg">
              {t("intake.invalid")}
            </p>
          )}
          {failure && <ErrorState error={failure} />}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={save.isPending} disabled={!online || !dirty || busy}>
              {t("intake.save")}
            </Button>
            <Button
              variant="secondary"
              disabled={!online || !current || dirty || busy}
              onClick={() => setReview(true)}
            >
              {t("intake.publish")}
            </Button>
            {current?.active && (
              <Button
                variant="ghost"
                disabled={!online || dirty || busy}
                onClick={() => setArchiving(true)}
              >
                {t("intake.archive")}
              </Button>
            )}
            {current && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (dirty)
                    setDiscard(() => () => {
                      setDraft(current.draft);
                      setInvalid(false);
                    });
                  else reload.mutate();
                }}
              >
                {t(dirty ? "intake.discard" : "intake.refresh")}
              </Button>
            )}
            {current && dirty && (
              <Button
                variant="secondary"
                disabled={busy || !online}
                onClick={() => setDiscard(() => () => reload.mutate())}
              >
                {t("intake.refresh")}
              </Button>
            )}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={review}
        onOpenChange={setReview}
        title={t("intake.publish")}
        description={t("intake.publishHelp")}
        confirmLabel={t("intake.publishConfirm")}
        cancelLabel={t("admin.cancel")}
        pending={publish.isPending}
        onConfirm={() => publish.mutate()}
      >
        <div className="mt-4 max-h-[45dvh] space-y-4 overflow-y-auto break-words">
          <h3 className="font-semibold">{draft?.title}</h3>
          <p className="whitespace-pre-wrap">{draft?.description}</p>
          {draft && <IntakeQuestions definition={draft} answers={{}} readOnly />}
          {publish.isError && <ErrorState error={publish.error} />}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t("intake.archive")}
        description={t("intake.archiveHelp")}
        confirmLabel={t("intake.archive")}
        cancelLabel={t("admin.cancel")}
        pending={archive.isPending}
        onConfirm={() => archive.mutate()}
      >
        {archive.isError && <ErrorState error={archive.error} />}
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(discard)}
        onOpenChange={(open) => {
          if (!open) setDiscard(null);
        }}
        title={t("intake.discard")}
        description={t("admin.unsaved.body")}
        confirmLabel={t("intake.discard")}
        cancelLabel={t("admin.cancel")}
        destructive
        onConfirm={() => {
          discard?.();
          setDiscard(null);
        }}
      />
    </section>
  );
}
