import {
  appointment,
  appointmentContext,
  appointmentService,
  clientProfile,
  type Database,
  salonSettings,
  service,
  serviceStaff,
  staffProfile,
  timeOff,
  workingHours,
} from "@sob/db";
import { eq } from "drizzle-orm";
import { RECURRING_FIXTURE as fixture } from "./recurring-values";

/** Synthetic calendar only. Called by the guarded local recurring-browser test executable. */
export async function seedCalendarFixture(db: Database) {
  await db.update(salonSettings).set({
    timezone: "Europe/Madrid",
    name: "Citame · Demo",
    minNoticeMinutes: 0,
    slotGranularityMinutes: 5,
  });
  await db.update(service).set({ bufferMinutes: 0, priceCents: 2500 });
  const [haircut] = await db.select().from(service).where(eq(service.name, "Haircut"));
  if (!haircut) throw new Error("Missing calendar fixture service");
  await db
    .update(staffProfile)
    .set({ displayName: "Profesional A" })
    .where(eq(staffProfile.id, "0198f5a0-7b1c-7000-8000-000000000201"));
  await db
    .update(staffProfile)
    .set({ displayName: "Profesional B" })
    .where(eq(staffProfile.id, "0198f5a0-7b1c-7000-8000-000000000202"));
  await db
    .insert(staffProfile)
    .values(["C", "D", "E", "F"].map((letter) => ({ displayName: `Profesional ${letter}` })));
  const staff = await db.select().from(staffProfile);
  await db.update(workingHours).set({ startTime: "09:30", endTime: "20:00" });
  for (const member of staff) {
    await db
      .insert(serviceStaff)
      .values({ serviceId: haircut.id, staffId: member.id })
      .onConflictDoNothing();
    if (!member.displayName.endsWith("A") && !member.displayName.endsWith("B"))
      await db.insert(workingHours).values(
        [1, 2, 3, 4, 5].map((weekday) => ({
          staffId: member.id,
          weekday,
          startTime: "09:30",
          endTime: "20:00",
        })),
      );
  }
  const [client] = await db
    .insert(clientProfile)
    .values({ name: "Cliente de demostración" })
    .returning();
  if (!client) throw new Error("Missing calendar fixture client");
  const catalog = [
    ["Manicura semipermanente", 45],
    ["Pedicura completa", 60],
    ["Cejas con hilo", 10],
    ["Higiene facial", 75],
    ["Presoterapia", 30],
    ["Diseño de cejas", 20],
  ] as const;
  for (let day = 16; day <= 20; day++)
    for (const [staffIndex, member] of staff.entries()) {
      let minute = 570 + staffIndex * 15;
      for (let index = 0; index < 7; index++) {
        const [name, duration] = catalog[(index + staffIndex) % catalog.length] ?? catalog[0];
        const startsAt = new Date(Date.UTC(2026, 10, day, 0, minute - 60));
        const [visit] = await db
          .insert(appointment)
          .values({
            staffId: member.id,
            clientId: client.id,
            startsAt,
            endsAt: new Date(startsAt.getTime() + duration * 60000),
            notes: index === 1 ? "Nota de demostración" : null,
          })
          .returning();
        if (!visit) throw new Error("Missing calendar fixture visit");
        await db.insert(appointmentService).values({
          appointmentId: visit.id,
          position: 0,
          serviceId: haircut.id,
          name,
          durationMinutes: duration,
          bufferMinutes: 0,
          priceCents: duration * 70,
          currency: "EUR",
        });
        if (index === 1 || index === 2)
          await db.insert(appointmentContext).values({
            appointmentId: visit.id,
            servicePosition: 0,
            requestedStaffId: index === 2 ? member.id : null,
            internalNote: index === 1 ? "Nota interna de demostración, solo para el equipo" : null,
            customerComment: index === 2 ? "Comentario de reserva de demostración" : null,
            invoiced: true,
            paid: index === 2,
            source: "booksy",
            sourceRef: `synthetic:${visit.id}:0`,
          });
        minute += duration + (index % 2 ? 15 : 5);
      }
    }
  const imported = [
    ...fixture.importedBillingAppointments,
    ...fixture.importedUnknownPaymentAppointments,
  ];
  for (const [index, id] of imported.entries()) {
    const unknownPayment = index >= fixture.importedBillingAppointments.length;
    const professional = staff[index % fixture.importedBillingAppointments.length];
    if (!professional) throw new Error("Missing professional for imported billing");
    const start = new Date(
      `${fixture.importedBillingDate}T${unknownPayment ? "14" : "12"}:00:00+01:00`,
    );
    await db.insert(appointment).values({
      id,
      staffId: professional.id,
      clientId: client.id,
      startsAt: start,
      endsAt: new Date(start.getTime() + haircut.durationMinutes * 60000),
    });
    await db.insert(appointmentService).values({
      appointmentId: id,
      position: 0,
      serviceId: haircut.id,
      name: haircut.name,
      durationMinutes: haircut.durationMinutes,
      bufferMinutes: 0,
      priceCents: unknownPayment ? haircut.priceCents : 0,
      currency: "EUR",
      sourceUnpriced: !unknownPayment,
    });
    await db.insert(appointmentContext).values({
      appointmentId: id,
      servicePosition: 0,
      invoiced: unknownPayment ? null : true,
      paid: unknownPayment ? null : true,
      source: "booksy",
      sourceRef: `synthetic-billing:${id}`,
    });
  }
  await db.insert(timeOff).values({
    staffId: staff[0]?.id ?? "",
    startsAt: new Date("2026-11-17T14:00:00Z"),
    endsAt: new Date("2026-11-17T14:30:00Z"),
    reason: "Descanso de demostración",
  });
}
