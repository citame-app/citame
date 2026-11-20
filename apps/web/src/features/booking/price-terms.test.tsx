import { expect, test } from "bun:test";
import type { Service } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { PriceTermsConsent, usePriceTerms } from "./price-terms";

function Harness() {
  const [service, setService] = useState<Service>({
    id: "cut",
    name: "Cut",
    description: null,
    durationMinutes: 30,
    bufferMinutes: 0,
    currency: "EUR",
    priceType: "variable",
    priceCents: 0,
  });
  const terms = usePriceTerms([service]);
  return (
    <>
      <PriceTermsConsent state={terms} />
      <output aria-label="Ready">{String(terms.accepted)}</output>
      <button
        type="button"
        onClick={() => setService({ ...service, priceType: "from", priceCents: 3000 })}
      >
        Change minimum
      </button>
    </>
  );
}
test("pending-price acceptance belongs to the reviewed price terms and resets when the minimum changes", () => {
  renderApp(<Harness />);
  expect(screen.getByLabelText("Ready")).toHaveTextContent("false");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByLabelText("Ready")).toHaveTextContent("true");
  fireEvent.click(screen.getByRole("button", { name: "Change minimum" }));
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByLabelText("Ready")).toHaveTextContent("false");
});
