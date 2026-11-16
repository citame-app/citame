import type { PortfolioAdminPhoto, PortfolioPublicPhoto } from "@sob/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, buttonClasses } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { SelectField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { servicesQuery } from "~/lib/queries";
import { PortfolioEditor } from "./portfolio-editor";

export function PortfolioImage({
  photo,
  admin = false,
  large = false,
}: {
  photo: PortfolioPublicPhoto | PortfolioAdminPhoto;
  admin?: boolean;
  large?: boolean;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  return failed ? (
    <p role="status" className="rounded-lg bg-sunken p-4 text-sm text-muted">
      {t("portfolio.imageError")}
    </p>
  ) : (
    <img
      src={`/api/${admin ? "admin/" : ""}portfolio/${photo.id}/image?v=${"version" in photo ? photo.version : photo.publishedAt}`}
      alt={photo.alt}
      width={photo.width}
      height={photo.height}
      loading={large ? "eager" : "lazy"}
      onError={() => setFailed(true)}
      className={
        large
          ? "max-h-[65dvh] w-full rounded-lg bg-sunken object-contain"
          : "aspect-[4/3] w-full rounded-lg bg-sunken object-cover"
      }
    />
  );
}
export function PublicPortfolio() {
  const { t } = useI18n();
  const [before, setBefore] = useState<string>();
  const [serviceId, setServiceId] = useState("");
  const [selected, setSelected] = useState<PortfolioPublicPhoto>();
  const catalog = useQuery(servicesQuery);
  const query = useQuery({
    queryKey: ["portfolio", "public", serviceId, before],
    queryFn: () => api().portfolio.public({ before, serviceId: serviceId || undefined }),
    staleTime: 0,
  });
  return (
    <section aria-label={t("portfolio.title")} className="space-y-6">
      <p className="max-w-prose text-muted">{t("portfolio.publicLead")}</p>
      <div className="max-w-sm">
        <SelectField
          label={t("portfolio.service")}
          value={serviceId}
          options={[
            { value: "", label: t("reviews.allServices") },
            ...(catalog.data ?? []).map((service) => ({ value: service.id, label: service.name })),
          ]}
          onChange={(value) => {
            setServiceId(value);
            setBefore(undefined);
          }}
        />
      </div>
      {query.isPending && <Skeleton className="h-48" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data?.photos.length === 0 && <EmptyState title={t("portfolio.empty")} />}
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {query.data?.photos.map((photo) => (
          <li key={photo.id} className="min-w-0 rounded-xl border border-line bg-surface p-3">
            <button
              type="button"
              aria-label={t("portfolio.open", { caption: photo.caption })}
              onClick={() => setSelected(photo)}
              className="block w-full rounded-lg"
            >
              <PortfolioImage key={`${photo.id}-${photo.publishedAt}`} photo={photo} />
            </button>
            <p className="mt-3 font-medium break-words">{photo.caption}</p>
            {photo.serviceName && (
              <p className="mt-1 text-sm text-muted break-words">{photo.serviceName}</p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="ghost"
          onClick={() => {
            setBefore(undefined);
            void query.refetch();
          }}
        >
          {t("portfolio.reload")}
        </Button>
        {query.data?.nextBefore && (
          <Button
            variant="secondary"
            onClick={() => setBefore(query.data?.nextBefore ?? undefined)}
          >
            {t("portfolio.more")}
          </Button>
        )}
      </div>
      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title={selected?.caption ?? t("portfolio.title")}
        footer={
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setSelected(undefined)}>
              {t("reviews.close")}
            </Button>
            {selected?.serviceId &&
              catalog.data?.some((service) => service.id === selected.serviceId) && (
                <Link
                  to="/book"
                  search={{ services: selected.serviceId }}
                  className={buttonClasses()}
                >
                  {t("portfolio.book")}
                </Link>
              )}
          </div>
        }
      >
        {selected && (
          <PortfolioImage key={`${selected.id}-${selected.publishedAt}`} photo={selected} large />
        )}
      </Sheet>
    </section>
  );
}
export function PortfolioAdmin() {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["portfolio", "admin"],
    queryFn: () => api().portfolio.admin(),
    gcTime: 0,
  });
  const [selected, setSelected] = useState<PortfolioAdminPhoto | "upload">();
  const [dirty, setDirty] = useState(false);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [discard, setDiscard] = useState(false);
  const client = useQueryClient();
  const toast = useToast();
  const close = () => {
    setSelected(undefined);
    setDiscard(false);
    setDirty(false);
    void client.invalidateQueries({ queryKey: ["portfolio"] });
  };
  return (
    <div className="space-y-5">
      <UnsavedGuard dirty={dirty} />
      <p className="text-muted">{t("portfolio.lead")}</p>
      <Button
        disabled={!query.data || query.data.photos.length >= query.data.limit}
        onClick={() => setSelected("upload")}
      >
        {t("portfolio.add")}
      </Button>
      {query.data && (
        <p className="text-sm text-muted">
          {t("portfolio.capacity", { count: query.data.photos.length, limit: query.data.limit })}
        </p>
      )}
      {query.isPending && <Skeleton className="h-40" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data?.photos.length === 0 && <EmptyState title={t("portfolio.draftsEmpty")} />}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {query.data?.photos.map((photo) => (
          <li
            key={photo.id}
            className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-3"
          >
            <PortfolioImage key={`${photo.id}-${photo.version}`} photo={photo} admin />
            <p className="font-medium break-words">{photo.caption}</p>
            <p className="text-sm text-muted">{t(`portfolio.${photo.status}`)}</p>
            <Button variant="secondary" onClick={() => setSelected(photo)}>
              {t("portfolio.edit")}
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="ghost" onClick={() => void query.refetch()}>
        {t("portfolio.reload")}
      </Button>
      <Sheet
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) dirty ? setDiscard(true) : close();
        }}
        title={t(selected === "upload" ? "portfolio.add" : "portfolio.edit")}
        footer={
          <div className="space-y-3">
            <div ref={setActions} />
            <Button variant="secondary" onClick={() => (dirty ? setDiscard(true) : close())}>
              {t("reviews.close")}
            </Button>
          </div>
        }
      >
        {selected && (
          <PortfolioEditor
            key={selected === "upload" ? "upload" : `${selected.id}-${selected.version}`}
            photo={selected === "upload" ? null : selected}
            onDirtyChange={setDirty}
            actionsTarget={actions}
            onSaved={() => {
              close();
              toast.success(t("portfolio.saved"));
            }}
          />
        )}
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title={t("reviews.discard")}
        description={t("reviews.discardBody")}
        confirmLabel={t("reviews.discardConfirm")}
        cancelLabel={t("reviews.stay")}
        destructive
        onConfirm={close}
      />
    </div>
  );
}
