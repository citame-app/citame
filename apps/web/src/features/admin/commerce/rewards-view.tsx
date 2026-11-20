import type { StaffAccessPreset, UserRole } from "@sob/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { GiftCardsView } from "./gift-cards-view";
import { LoyaltyView } from "./loyalty-view";
import { PassesView } from "./passes-view";
export function RewardsView(props: {
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  clientId?: string | null;
  initialTab?: "gift" | "packages" | "memberships" | "loyalty";
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"gift" | "packages" | "memberships" | "loyalty">(
    props.initialTab ?? "gift",
  );
  return (
    <div className="space-y-5">
      <fieldset aria-label={t("rewards.title")} className="flex flex-wrap gap-3">
        <Button
          variant={tab === "gift" ? "primary" : "secondary"}
          aria-pressed={tab === "gift"}
          onClick={() => setTab("gift")}
        >
          {t("gift.title")}
        </Button>
        {(["packages", "memberships"] as const).map((value) => (
          <Button
            key={value}
            variant={tab === value ? "primary" : "secondary"}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {t(`pos.${value}`)}
          </Button>
        ))}
        <Button
          variant={tab === "loyalty" ? "primary" : "secondary"}
          aria-pressed={tab === "loyalty"}
          onClick={() => setTab("loyalty")}
        >
          {t("loyalty.title")}
        </Button>
      </fieldset>
      {tab === "gift" ? (
        <GiftCardsView {...props} />
      ) : tab === "packages" || tab === "memberships" ? (
        <PassesView
          key={tab}
          {...props}
          clientId={props.clientId ?? undefined}
          kind={tab === "packages" ? "package" : "membership"}
        />
      ) : (
        <LoyaltyView {...props} />
      )}
    </div>
  );
}
