import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeading } from "~/components/pages";
import { TextField } from "~/components/ui/field";
import { adminHead } from "~/features/admin/route-head";
import { BookingPolicyForm } from "~/features/admin/settings/booking-policy-form";
import { EmailDelivery } from "~/features/admin/settings/email-delivery-form";
import { SettingsView } from "~/features/admin/settings/settings-view";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { IntakeAdmin } from "~/features/intake/form-admin";
import type { MessageKey } from "~/i18n/messages/en";
import { useI18n } from "~/i18n/react";

const sections = {
  business: ["pos.business", "settings.name", "settings.timezone"],
  booking: [
    "pos.booking",
    "settings.section.booking",
    "settings.onlineBookingEnabled",
    "settings.granularity",
    "settings.minNotice",
    "settings.maxDays",
  ],
  reminders: ["settings.section.reminders", "settings.reminderFirst", "settings.reminderSecond"],
  email: [
    "emailDelivery.title",
    "emailDelivery.provider",
    "emailDelivery.sender",
    "emailDelivery.senderName",
    "emailDelivery.host",
    "emailDelivery.port",
    "emailDelivery.encryption",
    "emailDelivery.username",
    "emailDelivery.smtpPassword",
    "emailDelivery.gmailPassword",
    "emailDelivery.gmailHint",
    "emailDelivery.resendKey",
  ],
  protection: [
    "protection.title",
    "protection.enabled",
    "protection.kind",
    "protection.value",
    "protection.hold",
    "protection.window",
    "protection.late",
    "protection.noShow",
    "protection.trusted",
  ],
  documents: ["intake.title"],
} as const satisfies Record<string, readonly [MessageKey, ...MessageKey[]]>;
type SettingsSection = keyof typeof sections;

const directoryLinks = [
  { label: "account.profile.title", to: "/account/profile" },
  { label: "desktop.devices.title", to: "/account/profile", hash: "desktop-devices" },
  { label: "oauth.connections.title", to: "/account/profile", hash: "connected-apps" },
  { label: "WhatsApp Business", to: "/admin/whatsapp" },
  { label: "services.title", to: "/admin/services" },
  { label: "commerce.title", to: "/admin/commerce", search: { view: "cash" } },
  { label: "inventory.title", to: "/admin/commerce", search: { view: "inventory" } },
] as const satisfies readonly {
  label: MessageKey | "WhatsApp Business";
  to: string;
  hash?: string;
  search?: { view: "cash" | "inventory" };
}[];

function searchText(value: string, locale: string) {
  return value.toLocaleLowerCase(locale).normalize("NFD").replace(/\p{M}/gu, "");
}

export const Route = createFileRoute("/admin/settings")({
  validateSearch: (search: Record<string, unknown>): { section?: SettingsSection } => {
    const value = search.section;
    return typeof value === "string" && Object.hasOwn(sections, value)
      ? { section: value as SettingsSection }
      : {};
  },
  head: adminHead("settings.title"),
  component: SettingsPage,
});

function SettingsPage() {
  const { t, locale } = useI18n();
  const { session } = Route.useRouteContext();
  const { section = "business" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [visited, setVisited] = useState(() => new Set([section]));
  // Keep forms already opened mounted so navigating within Ajustes preserves their drafts.
  if (!visited.has(section)) setVisited(new Set([...visited, section]));
  const [intakeDirty, setIntakeDirty] = useState(false);
  const [filter, setFilter] = useState("");
  const terms = searchText(filter.trim(), locale).split(/\s+/);
  const matches = (labels: readonly string[]) => {
    const text = searchText(labels.join(" "), locale);
    return terms.every((term) => text.includes(term));
  };
  const localResults = (Object.keys(sections) as SettingsSection[]).filter((value) =>
    matches(sections[value].map((key) => t(key))),
  );
  const linkedResults = directoryLinks.flatMap(({ label, ...target }) => {
    const title = label === "WhatsApp Business" ? label : t(label);
    return matches([title]) ? [{ title, ...target }] : [];
  });
  return (
    <>
      <UnsavedGuard dirty={intakeDirty} preserveOnSearchChange />
      <PageHeading title={t("settings.title")} lead={t("settings.lead")} />
      <div className="catalog-directory">
        <div className="min-w-0">
          <search aria-label={t("settings.search")} className="mb-4">
            <TextField
              type="search"
              name="settings-filter"
              label={t("settings.search")}
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </search>
          <nav className="catalog-directory-categories" aria-label={t("settings.title")}>
            {localResults.map((value) => (
              <Link
                key={value}
                to="/admin/settings"
                search={{ section: value }}
                activeOptions={{ exact: true }}
                aria-current={section === value ? "page" : undefined}
                className="settings-section-link"
              >
                {t(sections[value][0])}
              </Link>
            ))}
            {linkedResults.map(({ title, ...target }) => (
              <Link key={title} {...target} className="settings-section-link">
                {title}
              </Link>
            ))}
          </nav>
          <p role="status" className="text-sm text-muted">
            {!localResults.length && !linkedResults.length && t("settings.search.empty")}
          </p>
        </div>
        <div className="min-w-0">
          <div
            id="salon-settings"
            hidden={section === "email" || section === "protection" || section === "documents"}
            className="settings-section"
          >
            <SettingsView
              section={
                section === "business" || section === "booking" || section === "reminders"
                  ? section
                  : "business"
              }
              onInvalidSection={(value) => void navigate({ search: { section: value } })}
            />
          </div>
          <div id="email-delivery" hidden={section !== "email"} className="settings-section">
            {visited.has("email") && session && <EmailDelivery email={session.user.email} />}
          </div>
          <div id="booking-policy" hidden={section !== "protection"} className="settings-section">
            {visited.has("protection") && <BookingPolicyForm />}
          </div>
          <div id="intake-settings" hidden={section !== "documents"} className="settings-section">
            {visited.has("documents") && <IntakeAdmin onDirtyChange={setIntakeDirty} />}
          </div>
        </div>
      </div>
    </>
  );
}
