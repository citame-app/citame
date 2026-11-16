import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SectionIndex } from "./section-index";

afterEach(cleanup);
describe("section index", () => {
  test("links to mounted settings sections without replacing their forms", () => {
    render(
      <>
        <SectionIndex
          label="Settings sections"
          items={[
            { id: "salon", label: "Salon" },
            { id: "policy", label: "Booking policy" },
          ]}
        />
        <section id="salon">
          <input aria-label="Salon name" defaultValue="Sisters" />
        </section>
        <section id="policy">Policy</section>
      </>,
    );
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Booking policy" }).getAttribute("href")).toBe(
      "#policy",
    );
    expect((screen.getByRole("textbox", { name: "Salon name" }) as HTMLInputElement).value).toBe(
      "Sisters",
    );
  });
});
