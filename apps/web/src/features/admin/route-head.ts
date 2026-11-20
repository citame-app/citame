import { createTranslator, type TranslationKey } from "~/i18n";
import { pageMeta } from "~/lib/seo";

/** `head` for an admin route: translated title, never indexed. */
export function adminHead(titleKey: TranslationKey) {
  return ({
    match,
  }: {
    match: { context: { locale: Parameters<typeof createTranslator>[0]; salon: { name: string } } };
  }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: [
        ...pageMeta({
          title: t(titleKey),
          description: t("admin.lead"),
          siteName: salon.name,
          locale,
          noindex: true,
        }),
        { name: "page-type", content: "software" },
        { name: "site-kind", content: "software" },
      ],
    };
  };
}
