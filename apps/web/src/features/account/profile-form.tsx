import type { MeResponse } from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useToast } from "~/components/ui/toast";
import { type FieldErrors, validateProfile } from "~/features/auth/validate";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

export function ProfileForm({
  initial,
  onSaved,
}: {
  initial: { name: string; email: string; phone: string | null };
  onSaved: (me: MeResponse) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ name: initial.name, phone: initial.phone ?? "" });
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (data: { name: string; phone: string | null }) => api().updateProfile(data),
    onSuccess: (me) => {
      toast.success(t("account.profile.saved"));
      onSaved(me);
    },
    onError: () => toast.error(t("account.profile.failed")),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = validateProfile(values, t);
    if (!result.ok) {
      setErrors(result.errors);
      queueMicrotask(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    setErrors({});
    save.mutate(result.data);
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5">
      <TextField
        label={t("account.profile.name")}
        name="name"
        autoComplete="name"
        value={values.name}
        onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
        error={errors.name}
        required
      />
      <TextField
        label={t("account.profile.email")}
        name="email"
        type="email"
        value={initial.email}
        readOnly
        hint={t("account.profile.emailHint")}
      />
      <TextField
        label={t("account.profile.phone")}
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={values.phone}
        onChange={(e) => setValues((v) => ({ ...v, phone: e.target.value }))}
        error={errors.phone}
        hint={t("account.profile.phoneHint")}
      />
      <Button type="submit" size="lg" loading={save.isPending}>
        {t("account.profile.save")}
      </Button>
    </form>
  );
}
