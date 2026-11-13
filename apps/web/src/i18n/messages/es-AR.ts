import type { MessageKey } from "./en";

/** Neutral, professional Spanish for Argentina. */
export const esAR: Record<MessageKey, string> = {
  "common.greeting": "Hola, {name}",
  "booking.summary.services_one": "{count} servicio",
  "booking.summary.services_other": "{count} servicios",
  "common.dismiss": "Cerrar",
  "common.retry": "Reintentar",
  "field.password.show": "Mostrar contraseña",
  "field.password.hide": "Ocultar contraseña",
  "error.generic.title": "Algo salió mal",
  "error.generic.body": "No pudimos completar la acción. Intentá nuevamente en unos instantes.",
  "error.offline.title": "Parece que no tenés conexión",
  "error.offline.body": "Revisá tu conexión e intentá nuevamente.",
  "error.offline.banner": "Estás sin conexión. Algunas acciones no están disponibles.",
  "error.rateLimited.title": "Demasiados intentos",
  "error.rateLimited.body_one": "Esperá {count} segundo e intentá nuevamente.",
  "error.rateLimited.body_other": "Esperá {count} segundos e intentá nuevamente.",
};
