import { type ClientPhoto, clientPhotoUpdateSchema, clientPhotoUploadSchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";
import { preparePrivatePhoto } from "./prepare-photo";

const imageUrl = (clientId: string, photoId: string) =>
  `/api/admin/clients/${clientId}/photos/${photoId}/image`;
export function ClientPhotos({
  clientId,
  onDirtyChange,
  prepareFile = preparePrivatePhoto,
}: {
  clientId: string;
  onDirtyChange?: (dirty: boolean) => void;
  prepareFile?: (file: File) => Promise<string>;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<ClientPhoto | "upload" | null>(null);
  const query = useQuery({
    queryKey: ["client-photos", clientId],
    queryFn: () => api().admin.clients.photos(clientId),
    refetchOnMount: "always",
    refetchInterval: 30000,
  });
  const data = query.data;
  if (!data)
    return query.isPending ? (
      <Skeleton className="h-32" />
    ) : (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  const current =
    mode && mode !== "upload" ? data.photos.find((photo) => photo.id === mode.id) : null;
  return (
    <section className="space-y-4" aria-label={t("clientPhotos.title")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading">{t("clientPhotos.title")}</h3>
        {data.canEdit && (
          <Button
            variant="secondary"
            disabled={data.photos.length >= data.limit}
            onClick={() => setMode("upload")}
          >
            {t("clientPhotos.add")}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted">
        {t("clientPhotos.private", { count: data.photos.length, limit: data.limit })}
      </p>
      {query.isError && !mode && (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      )}
      {data.photos.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {data.photos.map((photo) => (
            <li key={photo.id} className="min-w-0">
              <button
                type="button"
                className="w-full overflow-hidden rounded-lg border border-line bg-surface text-left hover:border-line-strong"
                aria-label={t("clientPhotos.open", { caption: photo.caption })}
                onClick={() => setMode(photo)}
              >
                <img
                  src={imageUrl(clientId, photo.id)}
                  alt={photo.caption}
                  width={photo.width}
                  height={photo.height}
                  loading="lazy"
                  className="h-32 w-full object-cover"
                />
                <span className="block break-words p-3 text-sm">{photo.caption}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("clientPhotos.empty")}</p>
      )}
      {mode && (
        <PhotoForm
          key={mode === "upload" ? "upload" : mode.id}
          clientId={clientId}
          photo={mode === "upload" ? null : (current ?? mode)}
          missing={mode !== "upload" && !current}
          canEdit={data.canEdit}
          onClosed={() => setMode(null)}
          onDirtyChange={onDirtyChange}
          prepareFile={prepareFile}
        />
      )}
    </section>
  );
}

function PhotoForm({
  clientId,
  photo,
  missing,
  canEdit,
  onClosed,
  onDirtyChange,
  prepareFile,
}: {
  clientId: string;
  photo: ClientPhoto | null;
  missing: boolean;
  canEdit: boolean;
  onClosed: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  prepareFile: (file: File) => Promise<string>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queries = useQueryClient();
  const online = useOnline();
  const fileId = useId();
  const [baseline, setBaseline] = useState(photo);
  const [caption, setCaption] = useState(photo?.caption ?? "");
  const [capturedOn, setCapturedOn] = useState(photo?.capturedOn ?? "");
  const [base64, setBase64] = useState("");
  const [permission, setPermission] = useState(false);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const dirty = photo
    ? caption !== baseline?.caption || capturedOn !== (baseline?.capturedOn ?? "")
    : Boolean(caption || capturedOn || base64 || permission);
  function refresh() {
    void queries.invalidateQueries({ queryKey: ["client-photos", clientId] });
  }
  const save = useMutation({
    mutationFn: () => {
      if (baseline)
        return api().admin.clients.updatePhoto(
          clientId,
          baseline.id,
          clientPhotoUpdateSchema.parse({
            version: baseline.version,
            caption,
            capturedOn: capturedOn || null,
          }),
        );
      const signature = JSON.stringify([caption.trim(), capturedOn, base64]);
      if (attempt.current?.signature !== signature)
        attempt.current = { signature, key: crypto.randomUUID() };
      return api().admin.clients.uploadPhoto(
        clientId,
        clientPhotoUploadSchema.parse({
          idempotencyKey: attempt.current.key,
          caption,
          capturedOn: capturedOn || undefined,
          imageBase64: base64,
          permissionConfirmed: permission,
        }),
      );
    },
    onSuccess: () => {
      toast.success(t("clientPhotos.saved"));
      refresh();
      onClosed();
    },
    onError: refresh,
  });
  const remove = useMutation({
    mutationFn: () => {
      if (!baseline) throw new Error("No photo selected");
      return api().admin.clients.removePhoto(clientId, baseline.id, baseline.version);
    },
    onSuccess: () => {
      toast.success(t("clientPhotos.removed"));
      refresh();
      onClosed();
    },
    onError: () => {
      setConfirmRemove(false);
      refresh();
    },
  });
  const reload = useMutation({
    mutationFn: () => api().admin.clients.photos(clientId),
    onSuccess: (data) => {
      queries.setQueryData(["client-photos", clientId], data);
      const current = data.photos.find((row) => row.id === baseline?.id);
      if (!current) {
        onClosed();
        return;
      }
      setBaseline(current);
      setCaption(current.caption);
      setCapturedOn(current.capturedOn ?? "");
      save.reset();
      remove.reset();
    },
  });
  const error = save.error ?? remove.error ?? reload.error;
  const stale =
    missing ||
    Boolean(baseline && photo?.version !== baseline.version) ||
    (error instanceof ApiError && ["version_conflict", "not_found"].includes(error.code));
  const busy = reading || save.isPending || remove.isPending || reload.isPending;
  useEffect(() => {
    if ((!dirty && !busy) || !onDirtyChange) return;
    onDirtyChange(true);
    return () => onDirtyChange(false);
  }, [dirty, busy, onDirtyChange]);
  const valid = baseline
    ? clientPhotoUpdateSchema.safeParse({
        version: baseline.version,
        caption,
        capturedOn: capturedOn || null,
      }).success && dirty
    : Boolean(
        base64 &&
          permission &&
          clientPhotoUploadSchema.safeParse({
            caption,
            capturedOn: capturedOn || undefined,
            imageBase64: base64,
            permissionConfirmed: permission,
            idempotencyKey: "00000000-0000-4000-8000-000000000000",
          }).success,
      );
  async function chooseFile(file: File) {
    setReading(true);
    setPermission(false);
    setFileError(false);
    setBase64("");
    try {
      setBase64(await prepareFile(file));
    } catch {
      setFileError(true);
    } finally {
      setReading(false);
    }
  }
  function close() {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClosed();
  }
  return (
    <>
      {!onDirtyChange && <UnsavedGuard dirty={dirty || busy} />}
      <Sheet
        open
        onOpenChange={(value) => {
          if (!value) close();
        }}
        title={photo ? t("clientPhotos.details") : t("clientPhotos.add")}
        description={t("clientPhotos.description")}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={busy} onClick={close}>
              {t("admin.close")}
            </Button>
            {baseline && stale && (
              <Button
                variant="secondary"
                disabled={!online || busy}
                onClick={() => reload.mutate()}
              >
                {t("clientPhotos.reload")}
              </Button>
            )}
            {baseline && canEdit && (
              <Button
                variant="danger"
                disabled={!online || busy || stale}
                onClick={() => setConfirmRemove(true)}
              >
                {t("clientPhotos.remove")}
              </Button>
            )}
            {canEdit && (
              <Button
                disabled={!online || busy || stale || !valid}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                {t("clientPhotos.save")}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-5">
          {photo && (
            <img
              src={imageUrl(clientId, photo.id)}
              alt={photo.caption}
              width={photo.width}
              height={photo.height}
              className="max-h-96 w-full rounded-lg bg-canvas object-contain"
            />
          )}
          {base64 && (
            <img
              src={`data:image/jpeg;base64,${base64}`}
              alt={t("clientPhotos.preview")}
              width={1024}
              height={1024}
              className="max-h-64 w-full rounded-lg bg-canvas object-contain"
            />
          )}
          <fieldset disabled={!canEdit || busy} className="min-w-0 space-y-4">
            {!photo && (
              <div>
                <label htmlFor={fileId} className="mb-1.5 block text-sm font-medium">
                  {t("clientPhotos.file")}
                </label>
                <input
                  id={fileId}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="w-full min-w-0 rounded-lg border border-line p-2 text-sm"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void chooseFile(file);
                  }}
                />
                <p className="mt-2 text-sm text-muted">{t("clientPhotos.formats")}</p>
              </div>
            )}
            <TextField
              label={t("clientPhotos.caption")}
              value={caption}
              maxLength={300}
              onChange={(event) => setCaption(event.target.value)}
            />
            <TextField
              label={t("clientPhotos.date")}
              type="date"
              value={capturedOn}
              onChange={(event) => setCapturedOn(event.target.value)}
            />
            {!photo && (
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5 shrink-0 accent-accent"
                  checked={permission}
                  onChange={(event) => setPermission(event.target.checked)}
                />
                <span>{t("clientPhotos.permission")}</span>
              </label>
            )}
          </fieldset>
          {fileError && (
            <p role="alert" className="text-danger-fg">
              {t("clientPhotos.fileError")}
            </p>
          )}
          {stale && (
            <p role="alert" className="text-danger-fg">
              {t("clientPhotos.changed")}
            </p>
          )}
          {error && !stale && (
            <p role="alert" className="text-danger-fg">
              {error instanceof ApiError && error.code === "storage_limit"
                ? t("clientPhotos.capacity")
                : error instanceof ApiError && error.code === "validation_error"
                  ? t("clientPhotos.fileError")
                  : t(describeProblem(error).messageKey)}
            </p>
          )}
        </div>
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        destructive
        title={t("admin.unsaved.title")}
        description={t("admin.unsaved.body")}
        confirmLabel={t("admin.unsaved.leave")}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={onClosed}
      />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        destructive
        pending={remove.isPending}
        title={t("clientPhotos.removeTitle")}
        description={t("clientPhotos.removeBody")}
        confirmLabel={t("clientPhotos.removeConfirm")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
