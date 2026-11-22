import type { InventoryClassification } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Sheet } from "~/components/ui/sheet";
import { useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { preparePrivatePhoto } from "../clients/prepare-photo";
import { UnsavedGuard } from "../unsaved-guard";

export function BrandLogo({
  brand,
  compact,
  onLoaded,
  onFailed,
}: {
  brand: InventoryClassification;
  compact?: boolean;
  onLoaded?: (version: string) => void;
  onFailed?: (version: string) => void;
}) {
  const logo = brand.logo?.present ? brand.logo : undefined;
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (!compact || !failed) return;
    const reconnect = () => setFailed(undefined);
    window.addEventListener("online", reconnect, { once: true });
    return () => window.removeEventListener("online", reconnect);
  }, [compact, failed]);
  const size = compact ? 32 : 96;
  return (
    <span
      className={`grid shrink-0 place-items-center overflow-hidden rounded-md bg-canvas text-sm text-muted ${compact ? "size-8" : "size-24"}`}
    >
      {logo && logo.version !== failed ? (
        <img
          key={logo.version}
          src={`/api/admin/inventory/classifications/${brand.id}/logo/${logo.version}`}
          alt=""
          width={size}
          height={size}
          className="size-full object-contain"
          loading={compact ? "lazy" : "eager"}
          decoding="async"
          onLoad={() => onLoaded?.(logo.version)}
          onError={() => {
            setFailed(logo.version);
            onFailed?.(logo.version);
          }}
        />
      ) : (
        <span aria-hidden="true">{brand.name.trim().slice(0, 1).toLocaleUpperCase()}</span>
      )}
    </span>
  );
}

type Review = { version: string | null; generation: string };
type Draft = Review & { file: File | null };

export function BrandLogoEditor({
  brand,
  generation,
  ready,
  refreshError,
  onClose,
}: {
  brand: InventoryClassification;
  generation: string;
  ready: boolean;
  refreshError: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const toast = useToast();
  const cache = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<Draft>();
  const [loaded, setLoaded] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState(false);
  const version = brand.logo?.version ?? null;
  const review = { version, generation };
  const stale = !!draft && (draft.version !== version || draft.generation !== generation);
  const showsCurrent = !brand.logo?.present || loaded === version;
  const save = useMutation({
    mutationFn: async ({ file, ...revision }: Draft) =>
      api().inventory.saveBrandLogo(brand.id, {
        ...revision,
        imageBase64: file ? await preparePrivatePhoto(file) : null,
      }),
    onSuccess: async () => {
      form.current?.reset();
      setDraft(undefined);
      setConflict(false);
      await cache.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(t("inventory.brandLogo.saved"));
    },
    onError: async (error, proposal) => {
      if (
        error instanceof ApiError &&
        (error.code === "version_conflict" || error.code === "sync_generation_changed")
      ) {
        setConflict(true);
        if (proposal.file) setDraft(proposal);
        await cache.invalidateQueries({ queryKey: ["inventory", "classifications"] });
        toast.error(t("inventory.photo.conflict"));
      } else toast.error(t("inventory.photo.error"));
    },
  });
  const disabled = !online || !ready || !showsCurrent || save.isPending;
  return (
    <Sheet
      open
      title={`${t("inventory.brandLogo.title")} · ${brand.name}`}
      onOpenChange={(open) => {
        if (open || save.isPending) return;
        if (draft) setDiscard(true);
        else onClose();
      }}
    >
      <UnsavedGuard dirty={!!draft && !save.isPending} />
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        onConfirm={onClose}
        title={t("inventory.brandLogo.discardTitle")}
        description={t("inventory.brandLogo.discard")}
        confirmLabel={t("inventory.brandLogo.discardTitle")}
        cancelLabel={t("inventory.classification.cancel")}
        destructive
      />
      <div className="space-y-4">
        {refreshError}
        <BrandLogo key={attempt} brand={brand} onLoaded={setLoaded} onFailed={setFailed} />
        {brand.logo?.present && failed === version && loaded !== version && (
          <div className="space-y-2">
            <p role="status" className="text-sm text-muted">
              {t("inventory.brandLogo.loadError")}
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={!online}
              onClick={() => {
                setFailed(undefined);
                setAttempt((previous) => previous + 1);
              }}
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        <form
          ref={form}
          method="post"
          aria-label={t("inventory.brandLogo.title")}
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft && !disabled && !stale && !conflict) save.mutate(draft);
          }}
        >
          <TextField
            className="min-w-0 max-w-sm"
            label={t("inventory.brandLogo.file")}
            hint={t("inventory.photo.help")}
            name="image"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              setDraft(file ? { ...review, file } : undefined);
              setConflict(false);
            }}
          />
          <Button type="submit" disabled={!draft || disabled || stale || conflict}>
            {t(save.isPending ? "admin.loading" : "inventory.brandLogo.save")}
          </Button>
          {brand.logo?.present && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => save.mutate({ ...review, file: null })}
            >
              {t("inventory.brandLogo.remove")}
            </Button>
          )}
        </form>
        {(stale || conflict) && (
          <div className="space-y-2">
            <p role="status" className="text-sm text-muted">
              {t("inventory.photo.conflict")}
            </p>
            {draft && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  setDraft({ ...draft, ...review });
                  setConflict(false);
                }}
              >
                {t("inventory.photo.reviewed")}
              </Button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
