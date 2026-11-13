import type { Appointment } from "@sob/contracts";
import { createStore } from "@tanstack/react-store";

/**
 * Transient booking UI state that does not belong in the URL. The selection itself (services,
 * professional, date, slot) lives in the URL; this holds the free-text note draft, the slot a
 * visitor just lost to somebody else, and the appointment that was just confirmed.
 */
export interface BookingState {
  notes: string;
  takenSlot: string | null;
  lastBooked: Appointment | null;
}

const NOTES_KEY = "sob.booking.notes";

const initial: BookingState = { notes: "", takenSlot: null, lastBooked: null };

export const bookingStore = createStore<BookingState>(initial);

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export const bookingActions = {
  setNotes(notes: string) {
    bookingStore.setState((state) => ({ ...state, notes }));
    try {
      if (notes) storage()?.setItem(NOTES_KEY, notes);
      else storage()?.removeItem(NOTES_KEY);
    } catch {
      // Storage can be unavailable (private mode); the in-memory draft still works.
    }
  },
  restore() {
    try {
      const notes = storage()?.getItem(NOTES_KEY);
      if (notes) bookingStore.setState((state) => ({ ...state, notes }));
    } catch {
      // ignore
    }
  },
  markSlotTaken(startsAt: string) {
    bookingStore.setState((state) => ({ ...state, takenSlot: startsAt }));
  },
  clearSlotTaken() {
    bookingStore.setState((state) => ({ ...state, takenSlot: null }));
  },
  recordBooked(appointment: Appointment) {
    bookingStore.setState(() => ({ notes: "", takenSlot: null, lastBooked: appointment }));
    try {
      storage()?.removeItem(NOTES_KEY);
    } catch {
      // ignore
    }
  },
  reset() {
    bookingStore.setState(() => initial);
  },
};
