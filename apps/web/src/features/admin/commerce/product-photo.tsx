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

export function ProductPhoto({ product, compact }: { product: Product; compact?: boolean }) {
  if (!product.photoVersion) return null;
  const size = compact ? 56 : 128;
  return (
    <img
      alt={compact ? "" : product.name}
      src={`/api/admin/inventory/products/${product.id}/photo/${product.photoVersion}`}
      width={size}
      height={size}
      loading={compact ? "lazy" : "eager"}
      decoding="async"
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
  const [file, setFile] = useState<File | null>(null);
  const queryKey = ["inventory", "productPhoto", product.id] as const;
  const current = useQuery({ queryKey, queryFn: () => api().inventory.get(product.id) });
  const save = useMutation({
    mutationFn: async (change: File | null) => {
      if (!current.data) throw new Error("Product not loaded");
      const version = current.data.photoVersion ?? null;
      return api().inventory.savePhoto(product.id, {
        version,
        imageBase64: change ? await preparePrivatePhoto(change) : null,
      });
    },
    onSuccess: async ({ version }) => {
      form.current?.reset();
      setFile(null);
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
  const disabled = !online || !current.data || save.isPending;
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-heading">{t("inventory.photo.title")}</h3>
      {current.isError && (
        <ErrorState error={current.error} onRetry={() => void current.refetch()} />
      )}
      <ProductPhoto product={current.data ?? product} />
      <form
        ref={form}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (file && !disabled) save.mutate(file);
        }}
      >
        <TextField
          className="min-w-0 max-w-sm"
          label={t("inventory.photo.file")}
          hint={t("inventory.photo.help")}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled}
          onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
        />
        <Button type="submit" disabled={!file || disabled}>
          {t(save.isPending ? "admin.loading" : "inventory.photo.save")}
        </Button>
        {current.data?.photoVersion && (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => save.mutate(null)}
          >
            {t("inventory.photo.remove")}
          </Button>
        )}
      </form>
    </section>
  );
}
