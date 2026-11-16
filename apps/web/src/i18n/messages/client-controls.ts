export const clientControlsEn = {
  "crm.controls": "Client tags & booking access",
  "crm.tags": "Client tags",
  "crm.tagsError": "Use up to 20 different labels of 1–40 characters, separated by commas.",
  "crm.tagsHelp":
    "Up to 20 labels, separated by commas. Search these labels in the client directory.",
  "crm.access": "Booking access",
  "crm.normal": "Normal booking access",
  "crm.trusted": "Trusted client",
  "crm.blocked": "Bookings blocked",
  "crm.accessHelp":
    "Blocked profiles cannot create or move appointments through any connected channel. Existing appointments stay in place and can still be cancelled. Trusted status keeps normal availability rules.",
  "crm.reason": "Access change reason",
  "crm.private": "Internal information. This reason is not shown to the client.",
  "crm.save": "Save client controls",
  "crm.saved": "Client controls saved",
  "crm.error":
    "Could not save. Check the labels and reason, or reload if someone else changed this profile.",
  "crm.stale":
    "This profile changed elsewhere. Your draft is preserved; reload the current controls before saving.",
  "crm.reload": "Reload client controls",
} as const;
export const clientControlsEsAR: Record<keyof typeof clientControlsEn, string> = {
  "crm.controls": "Etiquetas y acceso a reservas",
  "crm.tags": "Etiquetas del cliente",
  "crm.tagsError": "Usa hasta 20 etiquetas distintas de 1 a 40 caracteres, separadas por comas.",
  "crm.tagsHelp":
    "Hasta 20 etiquetas separadas por comas. Puedes buscarlas en el directorio de clientes.",
  "crm.access": "Acceso a reservas",
  "crm.normal": "Acceso normal",
  "crm.trusted": "Cliente de confianza",
  "crm.blocked": "Reservas bloqueadas",
  "crm.accessHelp":
    "Los perfiles bloqueados no pueden crear ni mover citas desde ningún canal conectado. Las citas existentes se conservan y se pueden cancelar. El estado de confianza mantiene las reglas de disponibilidad.",
  "crm.reason": "Motivo del cambio de acceso",
  "crm.private": "Información interna. Este motivo no se muestra al cliente.",
  "crm.save": "Guardar controles del cliente",
  "crm.saved": "Controles del cliente guardados",
  "crm.error":
    "No pudimos guardar. Revisa las etiquetas y el motivo, o recarga si otra persona ha cambiado el perfil.",
  "crm.stale":
    "Este perfil ha cambiado en otro lugar. Conservamos tu borrador; recarga los controles actuales antes de guardar.",
  "crm.reload": "Recargar controles del cliente",
};
