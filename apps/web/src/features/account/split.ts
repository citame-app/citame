import type { Appointment } from "@sob/contracts";

export function splitAppointments(appointments: Appointment[], now: Date) {
  const nowMs = now.getTime();
  const upcoming: Appointment[] = [];
  const history: Appointment[] = [];
  for (const appointment of appointments) {
    if (appointment.status === "booked" && Date.parse(appointment.endsAt) > nowMs) {
      upcoming.push(appointment);
    } else {
      history.push(appointment);
    }
  }
  upcoming.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  history.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return { upcoming, history };
}

/** The cancellation the UI shows immediately; the server response replaces it. */
export function applyOptimisticCancel(appointments: Appointment[], id: string): Appointment[] {
  return appointments.map((appointment) =>
    appointment.id === id ? { ...appointment, status: "cancelled" } : appointment,
  );
}
