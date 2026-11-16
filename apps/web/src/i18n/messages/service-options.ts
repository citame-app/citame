export const serviceOptionsEn = {
  "booking.options.standard": "Standard",
  "booking.options.once": "Each extra can be added once per visit.",
  "booking.options.remove": "Remove {name}",
  "booking.options.extras": "Extras for {name}",
  "booking.options.noTime": "No added time",
  "booking.options.limit": "You can select up to {count} services and extras.",
  "services.options.kind": "Catalog type",
  "services.options.service": "Standalone service",
  "services.options.variant": "Service variant",
  "services.options.addon": "Optional extra",
  "services.options.parent": "Parent service",
  "services.options.label": "Variant label",
  "services.options.allowed": "Eligible services",
  "services.options.help":
    "Variants have their own price, duration and team. They start with a copy of the parent's resource requirements. Extras can only follow an eligible service; allowing a parent also allows its variants.",
  "services.options.zero":
    "A price-only extra may add zero minutes. It cannot reserve rooms or equipment without time.",
  "services.options.invalid":
    "Choose a parent and variant label, or at least one eligible service for an extra.",
  "services.options.reload": "Reload current service",
} as const;
export const serviceOptionsEsAR: Record<keyof typeof serviceOptionsEn, string> = {
  "booking.options.standard": "Estándar",
  "booking.options.once": "Puedes añadir cada complemento una vez por visita.",
  "booking.options.remove": "Quitar {name}",
  "booking.options.extras": "Complementos de {name}",
  "booking.options.noTime": "Sin tiempo adicional",
  "booking.options.limit": "Puedes elegir hasta {count} servicios y complementos.",
  "services.options.kind": "Tipo de catálogo",
  "services.options.service": "Servicio independiente",
  "services.options.variant": "Variante de servicio",
  "services.options.addon": "Complemento opcional",
  "services.options.parent": "Servicio principal",
  "services.options.label": "Nombre de la variante",
  "services.options.allowed": "Servicios compatibles",
  "services.options.help":
    "Las variantes tienen su propio precio, duración y equipo. Empiezan con una copia de los recursos del servicio principal. Los complementos deben seguir a un servicio compatible; si permites un servicio principal, también permites sus variantes.",
  "services.options.zero":
    "Un complemento que solo añade precio puede durar cero minutos. No puede reservar cabinas o equipos sin tiempo.",
  "services.options.invalid":
    "Elige un servicio principal y un nombre para la variante, o al menos un servicio compatible para el complemento.",
  "services.options.reload": "Recargar servicio actual",
};
