import type { Service } from "@sob/contracts";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import {
  catalogAddonOwners,
  eligibleAddon,
  normalizeCatalogSelection,
  serviceFamily,
  toggleCatalogSelection,
} from "./catalog-selection";
import { ServiceChoice } from "./components";
/** One choice per service family, followed by that choice's optional compatible extras. */
export function CatalogChoices({
  catalog,
  selected,
  onChange,
  maxSelected = 24,
  disabled = false,
  allCatalog = catalog,
}: {
  catalog: Service[];
  selected: string[];
  onChange: (ids: string[]) => void;
  maxSelected?: number;
  disabled?: boolean;
  allCatalog?: Service[];
}) {
  const { t } = useI18n();
  const ids = normalizeCatalogSelection(selected, catalog, maxSelected);
  const owners = catalogAddonOwners(ids, catalog);
  const familyIds = [
    ...new Set(catalog.filter((s) => s.catalog?.kind !== "addon").map(serviceFamily)),
  ];
  const groups = familyIds.flatMap((id) => {
    const options = catalog.filter((s) => s.catalog?.kind !== "addon" && serviceFamily(s) === id);
    const first = options[0];
    if (!first) return [];
    return [{ id, name: allCatalog.find((s) => s.id === id)?.name ?? first.name, first, options }];
  });
  const toggle = (id: string, baseId?: string) =>
    onChange(toggleCatalogSelection(ids, id, catalog, baseId, maxSelected));
  return (
    <div className="space-y-4">
      {groups.map((root) => {
        const options = root.options;
        const chosen = options.find((s) => ids.includes(s.id));
        const extras = chosen
          ? catalog.filter(
              (s) =>
                eligibleAddon(s, chosen) && (!owners.has(s.id) || owners.get(s.id) === chosen.id),
            )
          : [];
        return (
          <section key={root.id} className="space-y-3">
            {options.length === 1 ? (
              <ServiceChoice
                service={root.first}
                selected={Boolean(chosen)}
                disabled={disabled || (!chosen && ids.length >= maxSelected)}
                onToggle={toggle}
              />
            ) : (
              <fieldset className="space-y-3 rounded-xl border border-line p-4">
                <legend className="px-1 font-medium">{root.name}</legend>
                {options.map((s) => (
                  <ServiceChoice
                    key={s.id}
                    service={s}
                    selected={chosen?.id === s.id}
                    type="radio"
                    group={`family-${root.id}`}
                    label={
                      s.id === root.id ? `${root.name} · ${t("booking.options.standard")}` : s.name
                    }
                    disabled={disabled || (!chosen && ids.length >= maxSelected)}
                    onToggle={(id) => {
                      if (chosen?.id !== id) toggle(id);
                    }}
                  />
                ))}
                {chosen && (
                  <Button variant="ghost" disabled={disabled} onClick={() => toggle(chosen.id)}>
                    {t("booking.options.remove", { name: root.name })}
                  </Button>
                )}
              </fieldset>
            )}
            {chosen && extras.length > 0 && (
              <fieldset className="space-y-3 rounded-xl border border-line bg-sunken p-4">
                <legend className="px-1 text-sm font-medium">
                  {t("booking.options.extras", { name: chosen.name })}
                </legend>
                <p className="text-sm text-muted">{t("booking.options.once")}</p>
                {extras.map((s) => (
                  <ServiceChoice
                    key={s.id}
                    service={s}
                    selected={ids.includes(s.id)}
                    disabled={disabled || (!ids.includes(s.id) && ids.length >= maxSelected)}
                    onToggle={(id) => toggle(id, chosen.id)}
                  />
                ))}
              </fieldset>
            )}
          </section>
        );
      })}
      {ids.length >= maxSelected && (
        <p role="status" className="text-sm text-muted">
          {t("booking.options.limit", { count: maxSelected })}
        </p>
      )}
    </div>
  );
}
