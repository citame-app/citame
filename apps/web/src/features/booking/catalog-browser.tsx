import type { Service, Staff } from "@sob/contracts";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useI18n } from "~/i18n/react";
import { CatalogChoices } from "./catalog-choices";
import { serviceFamily } from "./catalog-selection";

export const catalogText = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
export function CatalogBrowser({
  catalog,
  staff,
  selected,
  onChange,
  allowMultipleProfessionals = false,
}: {
  catalog: Service[];
  staff: Staff[];
  selected: string[];
  onChange: (ids: string[]) => void;
  allowMultipleProfessionals?: boolean;
}) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const categoryId = useId();
  const categoryOf = (s: Service) =>
    (catalog.find((root) => root.id === serviceFamily(s)) ?? s).category ?? "";
  const sorted = [...catalog].sort(
    (a, b) =>
      categoryOf(a).localeCompare(categoryOf(b), locale) ||
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
      a.name.localeCompare(b.name, locale),
  );
  const roots = [...new Set(sorted.filter((s) => s.catalog?.kind !== "addon").map(serviceFamily))];
  const groups = roots.map((id) => {
    const members = sorted.filter((s) => s.catalog?.kind !== "addon" && serviceFamily(s) === id);
    const root = catalog.find((s) => s.id === id) ?? members[0];
    return { id, members, category: root?.category ?? "" };
  });
  const categories = [...new Set(groups.map((g) => g.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, locale),
  );
  const query = catalogText(search);
  const visible = groups.filter(
    (g) =>
      (!category || g.category === category) &&
      (!query ||
        g.members.some((s) =>
          catalogText(`${s.name} ${s.description ?? ""} ${g.category}`).includes(query),
        )),
  );
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          type="search"
          label={t("services.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div>
          <label htmlFor={categoryId} className="mb-1.5 block text-sm font-medium">
            {t("services.category")}
          </label>
          <select
            id={categoryId}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="min-h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-base"
          >
            <option value="">{t("services.allCategories")}</option>
            {categories.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </div>
      </div>
      {!visible.length ? (
        <div role="status" className="space-y-3 rounded-lg border border-line p-5">
          <p>{t("services.noMatches")}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setSearch("");
              setCategory("");
            }}
          >
            {t("services.clearFilters")}
          </Button>
        </div>
      ) : (
        <CatalogChoices
          allowMultipleProfessionals={allowMultipleProfessionals}
          catalog={sorted}
          visibleFamilies={visible.map((g) => g.id)}
          staff={staff}
          selected={selected}
          onChange={onChange}
        />
      )}
    </div>
  );
}
