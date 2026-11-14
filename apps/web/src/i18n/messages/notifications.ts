export const notificationsEn = {
  "account.nav.notifications": "Notifications",
  "notify.title": "Notifications",
  "notify.lead": "Choose how the salon contacts you about your appointments.",
  "notify.language": "Language of messages",
  "notify.language.default": "Salon default",
  "notify.language.en": "English",
  "notify.language.esAR": "Español (Argentina)",
  "notify.email.legend": "Email",
  "notify.email.missing": "Your account has no email address.",
  "notify.sms.legend": "Text messages (SMS)",
  "notify.sms.lead":
    "Off unless you turn it on. By switching it on you agree to receive text messages about your appointments. Reply STOP to any message to opt out.",
  "notify.sms.missing": "Add a phone number in your profile to receive text messages.",
  "notify.transactional": "Booking confirmations, changes and cancellations",
  "notify.reminder": "Reminders before your appointment",
  "notify.save": "Save preferences",
  "notify.saved": "Preferences saved",
  "notify.failed": "We could not save your preferences",
  "notify.loadFailed": "We could not load your preferences",
  "optout.title": "Stop appointment reminders",
  "optout.meta.description": "Turn off reminder messages from the salon.",
  "optout.lead.email":
    "You will no longer receive reminder emails before your appointments. Booking confirmations and changes are not affected.",
  "optout.confirm": "Stop reminders",
  "optout.done.title": "Reminders turned off",
  "optout.done.lead":
    "You will not get reminder emails any more. You can turn them back on in your account.",
  "optout.already": "Reminders are already turned off.",
  "optout.manage": "Manage notification preferences",
  "optout.invalid.title": "This link is not valid",
  "optout.invalid.lead":
    "The unsubscribe link is incomplete or has been altered. Sign in and use your notification preferences instead.",
  "optout.failed": "We could not update your preferences. Please try again.",
  "settings.section.reminders": "Reminders",
  "settings.reminders.lead":
    "When reminders go out before an appointment. Applies to appointments booked or moved from now on. Leave a field empty to turn that reminder off.",
  "settings.reminderFirst": "First reminder (minutes before)",
  "settings.reminderFirst.hint":
    "Default 1440 (24 hours). A whole number of days keeps the same clock time.",
  "settings.reminderSecond": "Second reminder (minutes before)",
  "settings.reminderSecond.hint": "Default 120 (2 hours).",
  "settings.error.reminder": "Enter minutes between 5 and 20160, or leave empty",
} as const;

export const notificationsEsAR: Record<keyof typeof notificationsEn, string> = {
  "account.nav.notifications": "Notificaciones",
  "notify.title": "Notificaciones",
  "notify.lead": "Elegí cómo te contacta el salón por tus turnos.",
  "notify.language": "Idioma de los mensajes",
  "notify.language.default": "El del salón",
  "notify.language.en": "English",
  "notify.language.esAR": "Español (Argentina)",
  "notify.email.legend": "Correo electrónico",
  "notify.email.missing": "Tu cuenta no tiene una dirección de correo.",
  "notify.sms.legend": "Mensajes de texto (SMS)",
  "notify.sms.lead":
    "Está desactivado hasta que lo actives. Al activarlo aceptás recibir mensajes de texto sobre tus turnos. Respondé STOP a cualquier mensaje para dejar de recibirlos.",
  "notify.sms.missing": "Agregá un teléfono en tu perfil para recibir mensajes de texto.",
  "notify.transactional": "Confirmaciones, cambios y cancelaciones de turnos",
  "notify.reminder": "Recordatorios antes de tu turno",
  "notify.save": "Guardar preferencias",
  "notify.saved": "Preferencias guardadas",
  "notify.failed": "No pudimos guardar tus preferencias",
  "notify.loadFailed": "No pudimos cargar tus preferencias",
  "optout.title": "Dejar de recibir recordatorios",
  "optout.meta.description": "Desactivá los recordatorios de turnos del salón.",
  "optout.lead.email":
    "Vas a dejar de recibir recordatorios por correo antes de tus turnos. Las confirmaciones y los cambios de turno no se ven afectados.",
  "optout.confirm": "Dejar de recibir recordatorios",
  "optout.done.title": "Recordatorios desactivados",
  "optout.done.lead":
    "No vas a recibir más recordatorios por correo. Podés volver a activarlos desde tu cuenta.",
  "optout.already": "Los recordatorios ya están desactivados.",
  "optout.manage": "Administrar preferencias de notificación",
  "optout.invalid.title": "Este enlace no es válido",
  "optout.invalid.lead":
    "El enlace para darte de baja está incompleto o fue modificado. Iniciá sesión y usá tus preferencias de notificación.",
  "optout.failed": "No pudimos actualizar tus preferencias. Probá de nuevo.",
  "settings.section.reminders": "Recordatorios",
  "settings.reminders.lead":
    "Cuándo se envían los recordatorios antes de un turno. Rige para los turnos que se reserven o muevan desde ahora. Dejá un campo vacío para desactivar ese recordatorio.",
  "settings.reminderFirst": "Primer recordatorio (minutos antes)",
  "settings.reminderFirst.hint":
    "Por defecto 1440 (24 horas). Una cantidad entera de días conserva la misma hora del reloj.",
  "settings.reminderSecond": "Segundo recordatorio (minutos antes)",
  "settings.reminderSecond.hint": "Por defecto 120 (2 horas).",
  "settings.error.reminder": "Ingresá entre 5 y 20160 minutos, o dejalo vacío",
};
