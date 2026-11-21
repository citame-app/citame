import type { Product } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { preparePrivatePhoto } from "../clients/prepare-photo";

export function ProductPhoto({
  product,
  compact,
  onLoaded,
}: {
  product: Product;
  compact?: boolean;
  onLoaded?: (version: string) => void;
}) {
  if (!product.photoVersion) return null;
  const size = compact ? 56 : 128;
  return (
    <img
      key={product.photoVersion}
      alt={compact ? "" : product.name}
      src={`/api/admin/inventory/products/${product.id}/photo/${product.photoVersion}`}
      width={size}
      height={size}
      loading={compact ? "lazy" : "eager"}
      decoding="async"
      onLoad={() => {
        if (product.photoVersion) onLoaded?.(product.photoVersion);
      }}
      className={`shrink-0 rounded-md bg-surface object-contain ${compact ? "size-14" : "size-32"}`}
    />
  );
}

export function ProductPhotoEditor({ product }: { product: Product }) {
  const { t } = useI18n();
  const toast = useToast();
  const online = useOnline();
  const cache = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<{ file: File; version: string | null } | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  const queryKey = ["inventory", "productPhoto", product.id] as const;
  const current = useQuery({ queryKey, queryFn: () => api().inventory.get(product.id) });
  const save = useMutation({
    mutationFn: async ({ file, version }: { file: File | null; version: string | null }) => {
      return api().inventory.savePhoto(product.id, {
        version,
        imageBase64: file ? await preparePrivatePhoto(file) : null,
      });
    },
    onSuccess: async ({ version }) => {
      form.current?.reset();
      setDraft(null);
      cache.setQueryData<Product>(queryKey, (value) =>
        value ? { ...value, photoVersion: version ?? undefined } : undefined,
      );
      await cache.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(t("inventory.photo.saved"));
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "version_conflict") {
        await cache.invalidateQueries({ queryKey });
        toast.error(t("inventory.photo.conflict"));
      } else toast.error(t("inventory.photo.error"));
    },
  });
  const version = current.data?.photoVersion ?? null;
  const stale = !!draft && !!current.data && draft.version !== version;
  const showsCurrent = version === null || loadedVersion === version;
  const disabled = !online || !current.data || save.isPending;
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-heading">{t("inventory.photo.title")}</h3>
      {current.isError && (
        <ErrorState error={current.error} onRetry={() => void current.refetch()} />
      )}
      <ProductPhoto product={current.data ?? product} onLoaded={setLoadedVersion} />
      <form
        ref={form}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft && !stale && showsCurrent && !disabled) save.mutate(draft);
        }}
      >
        <TextField
          className="min-w-0 max-w-sm"
          label={t("inventory.photo.file")}
          hint={t("inventory.photo.help")}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled || !showsCurrent}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            setDraft(file ? { file, version } : null);
          }}
        />
        <Button type="submit" disabled={!draft || stale || !showsCurrent || disabled}>
          {t(save.isPending ? "admin.loading" : "inventory.photo.save")}
        </Button>
        {current.data?.photoVersion && (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || !showsCurrent}
            onClick={() => save.mutate({ file: null, version })}
          >
            {t("inventory.photo.remove")}
          </Button>
        )}
      </form>
      {stale && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted">
            {t("inventory.photo.conflict")}
          </p>
          {showsCurrent && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                if (draft) setDraft({ ...draft, version });
              }}
            >
              {t("inventory.photo.reviewed")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
