import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../test/render";
import { Header } from "./layout";

const props = {
  salonName: "Sisters of Beauty",
  session: null,
  theme: "light" as const,
  locale: "en" as const,
  onLocaleChange: () => {},
  onThemeChange: () => {},
};
describe("public discovery navigation", () => {
  test("keeps portfolio and reviews reachable on the public pages", () => {
    renderApp(<Header {...props} showDiscovery />);
    const discovery = screen.getByRole("navigation", { name: "See services" });
    expect(within(discovery).getByRole("link", { name: "Portfolio" })).toHaveAttribute(
      "href",
      "/portfolio",
    );
    expect(within(discovery).getByRole("link", { name: "Reviews" })).toHaveAttribute(
      "href",
      "/reviews",
    );
  });
  test("leaves the booking and workspace header focused on the current task", () => {
    renderApp(<Header {...props} showDiscovery={false} />);
    expect(screen.queryByRole("navigation", { name: "See services" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });
});
