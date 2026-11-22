import { type GiftEligibleService, maximumGiftServices } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

export function GiftServicePicker({
  selected,
  reviewedCatalogue,
  maximum = maximumGiftServices,
  emptySelectionHint,
  disabled,
  onChange,
}: {
  selected: GiftEligibleService[];
  reviewedCatalogue?: GiftEligibleService[];
  maximum?: number;
  emptySelectionHint?: string;
  disabled: boolean;
  onChange: (services: GiftEligibleService[]) => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const limitHelp = useId();
  const catalog = useQuery({
    queryKey: ["gift-cards", "eligible-services"],
    queryFn: ({ signal }) => api().giftCards.eligibleServices(signal),
    enabled: open && reviewedCatalogue === undefined,
    staleTime: 30_000,
  });
  const selectedIds = new Set(selected.map(({ id }) => id));
  const available = reviewedCatalogue ?? catalog.data?.services ?? [];
  const ready = reviewedCatalogue !== undefined || catalog.isSuccess;
  const availableIds = new Set(available.map(({ id }) => id));
  const searchText = search.trim().toLocaleLowerCase(locale);
  const matches = available.filter(
    ({ id, name }) => !selectedIds.has(id) && name.toLocaleLowerCase(locale).includes(searchText),
  );
  const choices = [...selected, ...matches];
  return (
    <fieldset disabled={disabled} aria-describedby={limitHelp} className="min-w-0 sm:col-span-2">
      <legend className="font-medium">{t("gift.eligibleServices")}</legend>
      <div className="mt-2 space-y-2">
        <p id={limitHelp} className="text-sm text-muted">
          {selected.length
            ? t("gift.selectedServices", { count: selected.length })
            : (emptySelectionHint ?? t("gift.allServices"))}
        </p>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t(open ? "gift.hideServices" : "gift.chooseServices")}
        </Button>
        {open && (
          <div className="space-y-2">
            <TextField
              label={t("gift.searchServices")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {reviewedCatalogue === undefined && catalog.isPending && <Skeleton className="h-28" />}
            {reviewedCatalogue === undefined && catalog.isError && (
              <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
            )}
            {ready && choices.length === 0 && (
              <p className="text-sm text-muted">{t("gift.noServices")}</p>
            )}
            {choices.length > 0 && (
              <ul className="max-h-56 overflow-y-auto rounded-lg border border-line">
                {choices.map((service) => {
                  const checked = selectedIds.has(service.id);
                  return (
                    <li key={service.id}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          className="h-4 w-4 accent-current"
                          disabled={!checked && selected.length >= maximum}
                          onChange={() =>
                            onChange(
                              checked
                                ? selected.filter(({ id }) => id !== service.id)
                                : [...selected, service],
                            )
                          }
                        />
                        {service.name}
                        {ready && !availableIds.has(service.id) && (
                          <span className="text-sm text-muted">{t("gift.inactiveService")}</span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </fieldset>
  );
}
