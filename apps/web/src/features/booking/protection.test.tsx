import { expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { BookingPolicyConsent } from "./protection";

const policy = {
  enabled: true,
  depositKind: "percent" as const,
  depositValue: 2500,
  holdMinutes: 15,
  cancellationWindowMinutes: 1440,
  lateCancellationBasisPoints: 1000,
  noShowBasisPoints: 5000,
  trustedExempt: true,
  version: 2,
};
test("policy acceptance is explicit, priced and bound to the displayed revision", () => {
  const versions: (number | null)[] = [];
  renderApp(
    <BookingPolicyConsent
      policy={policy}
      totalCents={10000}
      acceptedVersion={null}
      onAccept={(v) => versions.push(v)}
    />,
  );
  const input = screen.getByRole("checkbox", {
    name: "I accept this deposit and cancellation policy.",
  });
  expect(input).not.toBeChecked();
  expect(screen.getByText(/Pay a deposit of €25 within 15 minutes/)).toBeInTheDocument();
  fireEvent.click(input);
  expect(versions).toEqual([2]);
});
test("old acceptance cannot silently consent to changed terms", () => {
  renderApp(
    <BookingPolicyConsent
      policy={{ ...policy, version: 3 }}
      totalCents={10000}
      acceptedVersion={2}
      onAccept={() => {}}
    />,
  );
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("alert")).toHaveTextContent("Review and accept the current policy");
});
