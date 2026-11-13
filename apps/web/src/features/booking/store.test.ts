import { beforeEach, describe, expect, test } from "bun:test";
import type { Appointment } from "@sob/contracts";
import { bookingActions, bookingStore } from "./store";

const appointment = { id: "a1" } as Appointment;

beforeEach(() => {
  bookingActions.reset();
  sessionStorage.clear();
});

describe("booking store", () => {
  test("keeps the notes draft and mirrors it to sessionStorage so a sign-in detour keeps it", () => {
    bookingActions.setNotes("Please use fragrance-free products");
    expect(bookingStore.state.notes).toBe("Please use fragrance-free products");
    expect(sessionStorage.getItem("sob.booking.notes")).toBe("Please use fragrance-free products");
  });

  test("restores a stored notes draft", () => {
    sessionStorage.setItem("sob.booking.notes", "From a previous page load");
    bookingActions.restore();
    expect(bookingStore.state.notes).toBe("From a previous page load");
  });

  test("remembers the slot that was just lost so the picker can say so", () => {
    bookingActions.markSlotTaken("2026-03-09T12:00:00.000Z");
    expect(bookingStore.state.takenSlot).toBe("2026-03-09T12:00:00.000Z");
    bookingActions.clearSlotTaken();
    expect(bookingStore.state.takenSlot).toBeNull();
  });

  test("a confirmed booking clears the draft", () => {
    bookingActions.setNotes("hello");
    bookingActions.markSlotTaken("2026-03-09T12:00:00.000Z");
    bookingActions.recordBooked(appointment);
    expect(bookingStore.state.lastBooked).toEqual(appointment);
    expect(bookingStore.state.notes).toBe("");
    expect(bookingStore.state.takenSlot).toBeNull();
    expect(sessionStorage.getItem("sob.booking.notes")).toBeNull();
  });
});
