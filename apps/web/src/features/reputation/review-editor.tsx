import { type ReviewCreate, type ReviewPrivate, reviewEditSchema } from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { ErrorState } from "~/components/ui/states";
import type { TranslationKey } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";

export function ReviewFailure({
  error,
  changedKey = "reviews.changed",
}: {
  error: unknown;
  changedKey?: TranslationKey;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <ErrorState error={error} />
      {error instanceof ApiError &&
        (error.code === "version_conflict" || error.code === "invalid_state") && (
          <p role="status" className="text-sm text-muted">
            {t(changedKey)}
          </p>
        )}
    </div>
  );
}
export function ReviewEditor({
  appointmentId,
  review,
  onSaved,
  onDirtyChange,
}: {
  appointmentId: string;
  review: ReviewPrivate | null;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(review?.publicName ?? "");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [rating, setRating] = useState(String(review?.rating ?? 5));
  const [body, setBody] = useState(review?.body ?? "");
  const [share, setShare] = useState(review?.shareServices ?? false);
  const [confirmed, setConfirmed] = useState(false);
  const [social, setSocial] = useState(false);
  const socialHint = useId();
  const [uncertain, setUncertain] = useState(false);
  const key = useRef(crypto.randomUUID());
  const packet = useRef<ReviewCreate | null>(null);
  const input = {
    version: review?.version ?? 1,
    publicName: name,
    rating: Number(rating),
    body,
    shareServices: share,
    allowSocialUse: social,
    publicationConfirmed: confirmed,
  };
  const parsed = reviewEditSchema.safeParse(input);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!parsed.success) return;
      const { version, ...content } = parsed.data;
      packet.current ??= { ...content, appointmentId, idempotencyKey: key.current };
      if (review) {
        const {
          appointmentId: _appointmentId,
          idempotencyKey: _key,
          ...savedContent
        } = packet.current;
        await api().reviews.edit(review.id, { ...savedContent, version });
      } else await api().reviews.create(packet.current);
    },
    onError: (error) => {
      if (!mounted.current) return;
      if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500))
        setUncertain(true);
      else packet.current = null;
    },
    onSuccess: () => {
      if (!mounted.current) return;
      onDirtyChange(false);
      onSaved();
    },
  });
  const changed = () => {
    onDirtyChange(true);
    mutation.reset();
  };
  const disabled = mutation.isPending || uncertain;
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed.success) mutation.mutate();
      }}
    >
      <p className="text-sm text-muted">{t("reviews.privacy")}</p>
      <TextField
        label={t("reviews.publicName")}
        hint={t("reviews.publicNameHint")}
        maxLength={80}
        required
        value={name}
        disabled={disabled}
        onChange={(event) => {
          setName(event.target.value);
          changed();
        }}
      />
      <SelectField
        label={t("reviews.rating")}
        value={rating}
        options={[5, 4, 3, 2, 1].map((value) => ({ value: String(value), label: `${value} / 5` }))}
        disabled={disabled}
        onChange={(value) => {
          setRating(value);
          changed();
        }}
      />
      <TextAreaField
        label={t("reviews.body")}
        value={body}
        rows={5}
        maxLength={2000}
        required
        disabled={disabled}
        onChange={(event) => {
          setBody(event.target.value);
          changed();
        }}
      />
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={share}
          disabled={disabled}
          onChange={(event) => {
            setShare(event.target.checked);
            changed();
          }}
        />
        <span>{t("reviews.share")}</span>
      </label>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(event) => {
            setConfirmed(event.target.checked);
            changed();
          }}
        />
        <span>{t("reviews.confirm")}</span>
      </label>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={social}
          disabled={disabled}
          aria-describedby={socialHint}
          onChange={(event) => {
            setSocial(event.target.checked);
            changed();
          }}
        />
        <span>{t("reviews.social")}</span>
      </label>
      <p id={socialHint} className="text-sm text-muted">
        {t("reviews.socialHelp")}
      </p>
      {mutation.isError && <ReviewFailure error={mutation.error} />}
      {uncertain && (
        <p role="status" className="text-sm text-muted">
          {t("reviews.uncertain")}
        </p>
      )}
      <Button type="submit" disabled={!parsed.success || mutation.isPending}>
        {t("reviews.send")}
      </Button>
    </form>
  );
}
