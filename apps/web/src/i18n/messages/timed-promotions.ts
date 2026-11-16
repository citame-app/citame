export const timedPromotionsEn = {
  "timedPromotions.mismatch":
    "This time does not meet the offer's saved weekday, start window or booking lead. Choose a qualifying time or contact the salon. Your original appointment and discount are preserved.",
  "timedPromotions.enable": "Limit to appointment start times",
  "timedPromotions.help":
    "Service appointments only. Choose the salon-local days and start window. The end is excluded. An optional last-minute limit measures the time from original booking to the visit, not the payment date. Rescheduling must keep the saved conditions.",
  "timedPromotions.days": "Eligible weekdays",
  "timedPromotions.from": "Appointment starts from",
  "timedPromotions.before": "Appointment starts before",
  "timedPromotions.endOfDay": "Include starts through the end of the day (24:00)",
  "timedPromotions.hours": "Booked at most this many hours before the visit",
  "timedPromotions.hoursHelp": "Optional, 1–168 whole hours. Blank permits advance bookings.",
  "timedPromotions.conditions":
    "Appointment starts on {days}, from {from} and before {before} ({zone}).",
  "timedPromotions.lead": "Originally booked no more than {hours} hours before the visit.",
  "timedPromotions.move":
    "These conditions also apply when rescheduling. They are saved when the discount is applied.",
} as const;
export const timedPromotionsEs: Record<keyof typeof timedPromotionsEn, string> = {
  "timedPromotions.mismatch":
    "Este horario no cumple los días, la franja de inicio o la antelación guardados de la oferta. Elige un horario válido o contacta con el salón. Tu cita original y el descuento se conservan.",
  "timedPromotions.enable": "Limitar por horario de inicio de la cita",
  "timedPromotions.help":
    "Solo citas de servicios. Elige días y franja de inicio en la zona horaria del salón. Se excluye la hora final. El límite opcional de última hora se mide desde la reserva original hasta la cita, no desde el pago. Los cambios de cita deben respetar las condiciones guardadas.",
  "timedPromotions.days": "Días de la semana admitidos",
  "timedPromotions.from": "Inicio de la cita desde",
  "timedPromotions.before": "Inicio de la cita antes de",
  "timedPromotions.endOfDay": "Incluir inicios hasta el final del día (24:00)",
  "timedPromotions.hours": "Reservada como máximo estas horas antes de la cita",
  "timedPromotions.hoursHelp":
    "Opcional, de 1 a 168 horas enteras. En blanco permite reservar con más antelación.",
  "timedPromotions.conditions":
    "La cita comienza los días {days}, desde las {from} y antes de las {before} ({zone}).",
  "timedPromotions.lead": "Reserva original realizada como máximo {hours} horas antes de la cita.",
  "timedPromotions.move":
    "Estas condiciones también se aplican al cambiar la cita. Se guardan al aplicar el descuento.",
};
