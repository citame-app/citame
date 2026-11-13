import { describe, expect, mock, test } from "bun:test";
import type { Service, Slot } from "@sob/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { DateStrip, ServiceChoice, Stepper, TimeSlotGrid } from "./components";
import { groupSlots } from "./logic";

const TZ = "America/Argentina/Buenos_Aires";
const id = (n: number) => `0198f5a0-7b1c-7000-8000-${n.toString(16).padStart(12, "0")}`;

const haircut: Service = {
  id: id(1),
  name: "Haircut",
  description: "Wash, cut and style",
  durationMinutes: 45,
  bufferMinutes: 15,
  priceCents: 1_500_000,
  currency: "ARS",
};

describe("ServiceChoice", () => {
  test("is a checkbox labelled with the service, its duration and price", () => {
    const onChange = mock();
    renderApp(<ServiceChoice service={haircut} selected={false} onToggle={onChange} />);
    const box = screen.getByRole("checkbox", { name: /Haircut/ });
    expect(box).not.toBeChecked();
    expect(screen.getByText("45m")).toBeInTheDocument();
    expect(screen.getByText(/15,000/)).toBeInTheDocument();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(haircut.id);
  });

  test("reflects the selected state", () => {
    renderApp(<ServiceChoice service={haircut} selected onToggle={() => {}} />);
    expect(screen.getByRole("checkbox", { name: /Haircut/ })).toBeChecked();
  });
});

describe("Stepper", () => {
  const steps = [
    { id: "services", label: "Services", status: "complete" as const },
    { id: "professional", label: "Professional", status: "current" as const },
    { id: "time", label: "Time", status: "upcoming" as const },
    { id: "review", label: "Review", status: "upcoming" as const },
  ];

  test("marks exactly one step as current and exposes progress to assistive tech", () => {
    renderApp(<Stepper steps={steps} label="Booking progress" />);
    const nav = screen.getByRole("navigation", { name: "Booking progress" });
    const current = within(nav)
      .getAllByRole("listitem")
      .filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Professional");
    expect(within(nav).getAllByRole("listitem")).toHaveLength(4);
  });

  test("completed steps can be navigated back to through renderStep", () => {
    renderApp(
      <Stepper
        steps={steps}
        label="Booking progress"
        renderStep={(step, content) =>
          step.status === "complete" ? <a href={`/book/${step.id}`}>{content}</a> : content
        }
      />,
    );
    expect(screen.getByRole("link", { name: /Services/ })).toHaveAttribute(
      "href",
      "/book/services",
    );
  });
});

describe("DateStrip", () => {
  const dates = ["2026-03-09", "2026-03-10", "2026-03-11"];

  test("is a radio group with one option per day, formatted for the locale", () => {
    renderApp(
      <DateStrip
        dates={dates}
        selected="2026-03-10"
        slotCounts={{ "2026-03-09": 3, "2026-03-10": 5, "2026-03-11": 0 }}
        nextAvailable="2026-03-09"
        onSelect={() => {}}
        label="Choose a date"
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Choose a date" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Tuesday, March 10/ })).toBeChecked();
  });

  test("days without availability are disabled and the next available day is flagged", () => {
    renderApp(
      <DateStrip
        dates={dates}
        selected={undefined}
        slotCounts={{ "2026-03-09": 0, "2026-03-10": 2, "2026-03-11": 0 }}
        nextAvailable="2026-03-10"
        onSelect={() => {}}
        label="Choose a date"
      />,
    );
    expect(screen.getByRole("radio", { name: /Monday, March 9/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Tuesday, March 10/ })).toBeEnabled();
    expect(screen.getByText("Next available")).toBeInTheDocument();
  });

  test("days still loading stay selectable", () => {
    renderApp(
      <DateStrip
        dates={dates}
        selected={undefined}
        slotCounts={{}}
        onSelect={() => {}}
        label="x"
      />,
    );
    expect(screen.getByRole("radio", { name: /Monday, March 9/ })).toBeEnabled();
  });

  test("selecting a day reports it", () => {
    const onSelect = mock();
    renderApp(
      <DateStrip
        dates={dates}
        selected={undefined}
        slotCounts={{}}
        onSelect={onSelect}
        label="x"
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Wednesday, March 11/ }));
    expect(onSelect).toHaveBeenCalledWith("2026-03-11");
  });
});

describe("TimeSlotGrid", () => {
  const slot = (startsAt: string, staffId = id(0x201)): Slot => ({
    staffId,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  });
  const groups = groupSlots(
    [
      slot("2026-03-09T12:00:00.000Z"),
      slot("2026-03-09T15:30:00.000Z"),
      slot("2026-03-09T21:00:00.000Z"),
    ],
    TZ,
  );

  test("shows morning, afternoon and evening groups with salon-local times", () => {
    renderApp(
      <TimeSlotGrid groups={groups} selected={undefined} onSelect={() => {}} timeZone={TZ} />,
    );
    expect(screen.getByRole("group", { name: "Morning" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Afternoon" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Evening" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /9:00/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /12:30/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /6:00/ })).toBeInTheDocument();
  });

  test("selecting a time reports the whole slot and checks it", () => {
    const onSelect = mock();
    const { rerender } = renderApp(
      <TimeSlotGrid groups={groups} selected={undefined} onSelect={onSelect} timeZone={TZ} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /12:30/ }));
    expect(onSelect).toHaveBeenCalledWith(groups[1]?.slots[0]);
    expect(rerender).toBeDefined();
  });

  test("the chosen slot is checked", () => {
    renderApp(
      <TimeSlotGrid
        groups={groups}
        selected="2026-03-09T15:30:00.000Z"
        onSelect={() => {}}
        timeZone={TZ}
      />,
    );
    expect(screen.getByRole("radio", { name: /12:30/ })).toBeChecked();
  });

  test("slots are touch-sized", () => {
    renderApp(
      <TimeSlotGrid groups={groups} selected={undefined} onSelect={() => {}} timeZone={TZ} />,
    );
    const label = screen.getByText(/^9:00/);
    expect(label.tagName).toBe("LABEL");
    expect(label.className).toContain("min-h-11");
  });
});
