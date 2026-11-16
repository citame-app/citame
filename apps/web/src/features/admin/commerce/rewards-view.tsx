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
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"gift" | "passes" | "loyalty">("gift");
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
        <Button
          variant={tab === "passes" ? "primary" : "secondary"}
          aria-pressed={tab === "passes"}
          onClick={() => setTab("passes")}
        >
          {t("passes.title")}
        </Button>
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
      ) : tab === "passes" ? (
        <PassesView {...props} />
      ) : (
        <LoyaltyView {...props} />
      )}
    </div>
  );
}
