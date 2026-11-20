import {
  type PortfolioAdminPhoto,
  type PortfolioEdit,
  type PortfolioUpload,
  portfolioEditSchema,
  portfolioUploadSchema,
} from "@sob/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { preparePrivatePhoto } from "~/features/admin/clients/prepare-photo";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { servicesQuery } from "~/lib/queries";
import { ReviewFailure } from "./review-editor";

export function PortfolioEditor({
  photo,
  onSaved,
  onDirtyChange,
  prepareFile = preparePrivatePhoto,
  actionsTarget,
  associatedService,
}: {
  associatedService?: { id: string; name: string };
  photo: PortfolioAdminPhoto | null;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  prepareFile?: (file: File) => Promise<string>;
  actionsTarget?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const catalog = useQuery(servicesQuery);
  const [caption, setCaption] = useState(photo?.caption ?? "");
  const [alt, setAlt] = useState(photo?.alt ?? "");
  const [serviceId, setServiceId] = useState(photo?.serviceId ?? associatedService?.id ?? "");
  const [base64, setBase64] = useState("");
  const [permission, setPermission] = useState(false);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [removing, setRemoving] = useState(false);
  const fileId = useId();
  const generation = useRef(0);
  const mounted = useRef(true);
  const key = useRef(crypto.randomUUID());
  const packet = useRef<PortfolioUpload | null>(null);
  useEffect(() => {
    mounted.current = true;
    generation.current++;
    return () => {
      mounted.current = false;
    };
  }, []);
  const metadataDirty = photo
    ? caption !== photo.caption || alt !== photo.alt || serviceId !== (photo.serviceId ?? "")
    : Boolean(caption || alt || (serviceId && serviceId !== associatedService?.id) || base64);
  useEffect(() => {
    onDirtyChange(metadataDirty || permission || reading);
  }, [metadataDirty, permission, reading, onDirtyChange]);
  const edit = portfolioEditSchema.safeParse({
    version: photo?.version ?? 1,
    caption,
    alt,
    serviceId: serviceId || null,
  });
  const upload = portfolioUploadSchema.safeParse({
    idempotencyKey: key.current,
    caption,
    alt,
    serviceId: serviceId || null,
    imageBase64: base64,
  });
  const mutation = useMutation({
    mutationFn: async (request: {
      kind: "save" | "publish" | "unpublish" | "remove";
      upload?: PortfolioUpload;
      edit?: PortfolioEdit;
      photoId?: string;
      version?: number;
    }) => {
      if (request.kind === "save") {
        if (request.photoId && request.edit)
          return api().portfolio.edit(request.photoId, request.edit);
        if (request.upload) return api().portfolio.upload(request.upload);
        throw new Error("Invalid photo draft");
      }
      if (!request.photoId || !request.version) throw new Error("Save the private draft first");
      if (request.kind === "publish")
        return api().portfolio.publish(request.photoId, request.version);
      if (request.kind === "unpublish")
        return api().portfolio.unpublish(request.photoId, request.version);
      return api().portfolio.remove(request.photoId, request.version);
    },
    onSuccess: () => {
      if (!mounted.current) return;
      onDirtyChange(false);
      onSaved();
    },
    onError: (error) => {
      if (!mounted.current) return;
      if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500))
        setUncertain(true);
      else packet.current = null;
    },
  });
  const submit = (kind: "save" | "publish" | "unpublish" | "remove") => {
    if (kind === "save" && !photo && upload.success) packet.current ??= upload.data;
    mutation.mutate({
      kind,
      photoId: photo?.id,
      version: photo?.version,
      ...(photo && edit.success ? { edit: edit.data } : {}),
      ...(!photo && packet.current ? { upload: packet.current } : {}),
    });
  };
  const disabled = reading || mutation.isPending || uncertain;
  const changed = () => {
    mutation.reset();
    setPermission(false);
  };
  const url = photo
    ? `/api/admin/portfolio/${photo.id}/image`
    : base64
      ? `data:image/jpeg;base64,${base64}`
      : undefined;
  const options = [
    { value: "", label: t("portfolio.noService") },
    ...(catalog.data ?? []).map((service) => ({ value: service.id, label: service.name })),
  ];
  if (associatedService && !options.some((option) => option.value === associatedService.id))
    options.push({ value: associatedService.id, label: associatedService.name });
  if (photo?.serviceId && !options.some((option) => option.value === photo.serviceId))
    options.push({ value: photo.serviceId, label: photo.serviceName ?? photo.serviceId });
  const actions = (
    <div className="flex flex-wrap gap-3">
      {(!photo || metadataDirty) && (
        <Button
          disabled={
            mutation.isPending ||
            reading ||
            (photo ? !edit.success || !metadataDirty : !upload.success)
          }
          onClick={() => submit("save")}
        >
          {t("portfolio.save")}
        </Button>
      )}
      {photo?.status === "draft" && !metadataDirty && (
        <Button disabled={mutation.isPending || !permission} onClick={() => submit("publish")}>
          {t("portfolio.publish")}
        </Button>
      )}
      {photo?.status === "published" && (
        <Button
          variant="secondary"
          disabled={mutation.isPending || metadataDirty}
          onClick={() => submit("unpublish")}
        >
          {t("portfolio.unpublish")}
        </Button>
      )}
      {photo && (
        <Button variant="ghost" disabled={disabled} onClick={() => setRemoving(true)}>
          {t("portfolio.remove")}
        </Button>
      )}
    </div>
  );
  return (
    <div className="space-y-5">
      {url && (
        <img
          src={url}
          alt={alt || t("portfolio.title")}
          className="max-h-72 w-full rounded-lg bg-sunken object-contain"
        />
      )}
      {!photo && (
        <div>
          <label htmlFor={fileId} className="mb-1.5 block text-sm font-medium">
            {t("portfolio.file")}
          </label>
          <input
            id={fileId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled}
            aria-describedby={`${fileId}-hint`}
            className="block min-h-11 w-full min-w-0 text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:text-fg"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const ticket = ++generation.current;
              setReading(true);
              setFileError(false);
              changed();
              void prepareFile(file)
                .then((value) => {
                  if (mounted.current && generation.current === ticket) setBase64(value);
                })
                .catch(() => {
                  if (mounted.current && generation.current === ticket) {
                    setFileError(true);
                    setBase64("");
                  }
                })
                .finally(() => {
                  if (mounted.current && generation.current === ticket) setReading(false);
                });
            }}
          />
          <p id={`${fileId}-hint`} className="mt-1 text-sm text-muted">
            {t("portfolio.fileHint")}
          </p>
          {fileError && (
            <p role="alert" className="text-danger-fg">
              {t("portfolio.fileError")}
            </p>
          )}
        </div>
      )}
      <TextField
        label={t("portfolio.caption")}
        value={caption}
        required
        maxLength={300}
        disabled={disabled}
        onChange={(event) => {
          setCaption(event.target.value);
          changed();
        }}
      />
      <TextAreaField
        label={t("portfolio.alt")}
        hint={t("portfolio.altHint")}
        rows={3}
        value={alt}
        required
        maxLength={300}
        disabled={disabled}
        onChange={(event) => {
          setAlt(event.target.value);
          changed();
        }}
      />
      <SelectField
        label={t("portfolio.service")}
        value={serviceId}
        options={options}
        disabled={disabled || catalog.isPending || Boolean(associatedService)}
        onChange={(value) => {
          setServiceId(value);
          changed();
        }}
      />
      <p className="text-sm text-muted">{t("portfolio.edits")}</p>
      {photo && (
        <div className="space-y-4 border-t border-line pt-5">
          <p className="text-sm text-muted">{t("portfolio.rights")}</p>
          {photo.status === "draft" && (
            <label className="flex min-h-11 items-start gap-3">
              <input
                type="checkbox"
                className="mt-1.5"
                checked={permission}
                disabled={disabled || metadataDirty}
                onChange={(event) => {
                  setPermission(event.target.checked);
                  mutation.reset();
                }}
              />
              <span>{t("portfolio.confirm")}</span>
            </label>
          )}
        </div>
      )}
      {mutation.isError && <ReviewFailure error={mutation.error} changedKey="portfolio.changed" />}
      {uncertain && (
        <p role="status" className="text-sm text-muted">
          {t("reviews.uncertain")}
        </p>
      )}
      {actionsTarget
        ? createPortal(actions, actionsTarget)
        : actionsTarget === undefined
          ? actions
          : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("portfolio.remove")}
        description={t("portfolio.removeBody")}
        confirmLabel={t("portfolio.remove")}
        cancelLabel={t("reviews.close")}
        destructive
        pending={mutation.isPending}
        onConfirm={() => submit("remove")}
      >
        {mutation.isError && (
          <ReviewFailure error={mutation.error} changedKey="portfolio.changed" />
        )}
      </ConfirmDialog>
    </div>
  );
}
