import type { Locale } from "~/i18n";

export interface PageMetaInput {
  title: string;
  description: string;
  siteName: string;
  locale: Locale;
  /** Private pages (account, admin, auth) should not appear in search results. */
  noindex?: boolean;
}

type MetaEntry = Record<string, string>;

export function pageMeta({
  title,
  description,
  siteName,
  locale,
  noindex = false,
}: PageMetaInput): MetaEntry[] {
  const fullTitle = title === siteName ? siteName : `${title} · ${siteName}`;
  const meta: MetaEntry[] = [
    { title: fullTitle },
    { name: "description", content: description },
    { property: "og:title", content: fullTitle },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: siteName },
    { property: "og:locale", content: locale.replace("-", "_") },
    { name: "twitter:card", content: "summary" },
  ];
  if (noindex) meta.push({ name: "robots", content: "noindex, nofollow" });
  return meta;
}
