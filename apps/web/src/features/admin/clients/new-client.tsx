import { type AdminClient, createClientRequestSchema } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { PlusIcon } from "~/components/ui/icons";
import { TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { UnsavedGuard } from "../unsaved-guard";
import { ContactDetailFields, contactDetailsInput, contactDraft } from "./contact-details";

export function NewClient({ onCreated }: { onCreated: (client: AdminClient) => void }) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<AdminClient | null>(null);
  useEffect(() => {
    if (created && !open) {
      setCreated(null);
      onCreated(created);
    }
  }, [created, open, onCreated]);
  const [confirm, setConfirm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    notes: "",
    tags: "",
    lastName: "",
  });
  const [details, setDetails] = useState(() => contactDraft());
  const [id, setId] = useState(() => crypto.randomUUID());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty =
    Object.values(form).some(Boolean) || JSON.stringify(details) !== JSON.stringify(contactDraft());
  const close = () => {
    setOpen(false);
    setForm({ name: "", phone: "", email: "", notes: "", tags: "", lastName: "" });
    setErrors({});
    setDetails(contactDraft());
    setId(crypto.randomUUID());
    save.reset();
  };
  const request = () => ({
    id,
    name: [form.name.trim(), form.lastName.trim()].filter(Boolean).join(" "),
    contactDetails: contactDetailsInput({
      ...details,
      firstName: form.name,
      lastName: form.lastName,
    }),
    phone: form.phone.trim() || null,
    email: form.email.trim() || null,
    notes: form.notes.trim() || null,
    tags: [
      ...new Set(
        form.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ],
  });
  const save = useMutation({
    mutationFn: () => api().admin.clients.create(createClientRequestSchema.parse(request())),
    onSuccess: async (client) => {
      await queries.invalidateQueries({ queryKey: ["admin", "clients"] });
      close();
      setCreated(client);
    },
  });
  const submit = () => {
    const parsed = createClientRequestSchema.safeParse(request());
    const found: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        found[String(issue.path[0] === "contactDetails" ? issue.path[1] : issue.path[0])] =
          t("pos.invalidField");
    setErrors(found);
    if (parsed.success) save.mutate();
  };
  const set = (key: keyof typeof form, value: string) => {
    setForm({ ...form, [key]: value });
    setErrors({ ...errors, [key]: "" });
    save.reset();
  };
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <PlusIcon />
        {t("pos.newCustomer")}
      </Button>
      {open && <UnsavedGuard dirty={dirty} />}
      <Sheet
        title={t("pos.newCustomer")}
        open={open}
        onOpenChange={(next) => {
          if (save.isPending) return;
          if (!next && dirty) setConfirm(true);
          else setOpen(next);
        }}
        footer={
          <div className="flex justify-end gap-3">
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => (dirty ? setConfirm(true) : close())}
            >
              {t("admin.cancel")}
            </Button>
            <Button loading={save.isPending} disabled={!online} onClick={submit}>
              {t("admin.create")}
            </Button>
          </div>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-4">
            <TextField
              label={t("pos.firstName")}
              value={form.name}
              maxLength={100}
              onChange={(e) => set("name", e.target.value)}
              error={errors.name || errors.firstName}
              autoComplete="name"
              autoFocus
            />
            <TextField
              label={t("pos.lastName")}
              value={form.lastName}
              maxLength={100}
              onChange={(e) => set("lastName", e.target.value)}
              error={errors.lastName}
              autoComplete="family-name"
            />
            <TextField
              label={t("clients.detail.phone")}
              value={form.phone}
              type="tel"
              onChange={(e) => set("phone", e.target.value)}
              error={errors.phone}
              autoComplete="tel"
            />
            <TextField
              label={t("pos.email")}
              value={form.email}
              type="email"
              onChange={(e) => set("email", e.target.value)}
              error={errors.email}
              autoComplete="email"
            />
            <TextField
              label={t("pos.clientTags")}
              value={form.tags}
              onChange={(e) => set("tags", e.target.value)}
              error={errors.tags}
              hint={t("pos.tagsHelp")}
            />
            <TextAreaField
              label={t("clients.detail.notes")}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              error={errors.notes}
            />
            <details className="rounded-xl border border-line p-4">
              <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
                {t("pos.additionalInfo")}
              </summary>
              <div className="mt-4 space-y-4">
                <ContactDetailFields
                  includeNames={false}
                  value={details}
                  errors={errors}
                  onChange={(key, value) => {
                    setDetails({ ...details, [key]: value });
                    save.reset();
                    setErrors({ ...errors, [key]: "" });
                  }}
                />
              </div>
            </details>
            {save.isError && <ErrorState error={save.error} />}
          </fieldset>
        </form>
      </Sheet>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        destructive
        title={t("admin.unsaved.title")}
        description={t("admin.unsaved.body")}
        confirmLabel={t("admin.unsaved.leave")}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={() => {
          setConfirm(false);
          close();
        }}
      />
    </>
  );
}
