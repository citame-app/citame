import type { StaffAccessPreset, UserRole } from "@sob/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { GiftCardsView } from "./gift-cards-view";
import { LoyaltyView } from "./loyalty-view";
import { PassesView } from "./passes-view";
import { StampCardsView } from "./stamp-cards-view";
export function RewardsView(props: {
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  clientId?: string | null;
  stampClientId?: string;
  initialTab?: "gift" | "packages" | "memberships" | "loyalty" | "stamps";
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"gift" | "packages" | "memberships" | "loyalty" | "stamps">(
    props.initialTab ?? "gift",
  );
  const [openedStamps, setOpenedStamps] = useState(tab === "stamps");
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
        <Button
          variant={tab === "stamps" ? "primary" : "secondary"}
          aria-pressed={tab === "stamps"}
          onClick={() => {
            setOpenedStamps(true);
            setTab("stamps");
          }}
        >
          {t("stamps.title")}
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
      ) : tab === "loyalty" ? (
        <LoyaltyView {...props} />
      ) : null}
      {openedStamps && (
        <div hidden={tab !== "stamps"}>
          <StampCardsView
            {...props}
            clientId={props.stampClientId ?? props.clientId}
            visible={tab === "stamps"}
          />
        </div>
      )}
    </div>
  );
}
