import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { WhatsAppSettings } from "~/features/admin/settings/whatsapp-settings";

export const Route = createFileRoute("/admin/whatsapp")({
  head: () => ({ meta: [{ title: "WhatsApp Business · Citame" }] }),
  component: WhatsAppPage,
});

function WhatsAppPage() {
  return (
    <>
      <PageHeading title="WhatsApp Business" />
      <div className="max-w-3xl">
        <WhatsAppSettings />
      </div>
    </>
  );
}
