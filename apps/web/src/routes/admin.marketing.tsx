import { permissionsFor } from "@sob/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeading } from "~/components/pages";
import { BookingLinks } from "~/features/acquisition/booking-links";
import { SocialCreative } from "~/features/acquisition/social-creative";
import { ClientTransfer } from "~/features/admin/clients/client-transfer";
import { LoyaltyView } from "~/features/admin/commerce/loyalty-view";
import { PromotionsView } from "~/features/admin/commerce/promotions-view";
import { adminHead } from "~/features/admin/route-head";
import { CampaignsView } from "~/features/marketing/campaigns";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/marketing")({
  head: adminHead("pos.marketing"),
  component: MarketingPage,
});
function MarketingPage() {
  const { t } = useI18n();
  const { salon, session } = Route.useRouteContext();
  const [section, setSection] = useState("overview");
  const [visited, setVisited] = useState(() => new Set<string>(["overview"]));
  if (!session) return null;
  const permissions = permissionsFor(session.user.role, session.accessPreset);
  const items = [
    { value: "overview", label: t("pos.overview") },
    { value: "campaigns", label: t("marketing.campaigns") },
    { value: "social", label: t("social.title") },
    { value: "links", label: t("acquisition.title") },
    { value: "promotions", label: t("promotions.title") },
    { value: "loyalty", label: t("loyalty.title") },
    ...(permissions.deleteClients ? [{ value: "clients", label: t("pos.importClients") }] : []),
  ];
  const choose = (value: string) => {
    setSection(value);
    setVisited((current) => new Set([...current, value]));
  };
  return (
    <div className="view-marketing">
      <PageHeading title={t("pos.marketing")} lead={t("pos.marketingLead")} />
      <nav className="commerce-section-nav" aria-label={t("pos.marketing")}>
        {items.map((item) => (
          <button
            type="button"
            key={item.value}
            aria-pressed={section === item.value}
            onClick={() => choose(item.value)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {section === "overview" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items
            .filter((item) => item.value !== "overview")
            .map((item) => (
              <button
                type="button"
                key={item.value}
                className="marketing-tool"
                onClick={() => choose(item.value)}
              >
                <strong>{item.label}</strong>
                <span>
                  {t(
                    item.value === "campaigns"
                      ? "marketing.campaignHelp"
                      : item.value === "social"
                        ? "pos.socialHelp"
                        : item.value === "links"
                          ? "pos.linksHelp"
                          : item.value === "promotions"
                            ? "pos.promotionsHelp"
                            : item.value === "loyalty"
                              ? "pos.loyaltyHelp"
                              : "pos.importHelp",
                  )}
                </span>
                <span className="marketing-tool-action">{t("admin.open")}</span>
              </button>
            ))}
        </div>
      )}
      {visited.has("campaigns") && (
        <div hidden={section !== "campaigns"}>
          <CampaignsView />
        </div>
      )}
      {visited.has("social") && (
        <div hidden={section !== "social"}>
          <SocialCreative salonName={salon.name} />
        </div>
      )}
      {visited.has("links") && (
        <div hidden={section !== "links"}>
          <BookingLinks salonName={salon.name} />
        </div>
      )}
      {visited.has("promotions") && (
        <div hidden={section !== "promotions"}>
          <PromotionsView />
        </div>
      )}
      {visited.has("loyalty") && (
        <div hidden={section !== "loyalty"}>
          <LoyaltyView mode="admin" role={session.user.role} accessPreset={session.accessPreset} />
        </div>
      )}
      {visited.has("clients") && permissions.deleteClients && (
        <div hidden={section !== "clients"}>
          <h2 className="mb-4 text-heading">{t("pos.importClients")}</h2>
          <ClientTransfer />
        </div>
      )}
    </div>
  );
}
