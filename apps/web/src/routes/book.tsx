import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/book")({
  validateSearch: (raw: Record<string, unknown>) => ({
    services: typeof raw.services === "string" ? raw.services : undefined,
  }),
  component: () => <p>stub</p>,
});
