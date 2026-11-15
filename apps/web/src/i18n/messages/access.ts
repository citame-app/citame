export const accessEn = {
  "access.title": "Staff access",
  "access.profile": "Access profile",
  "access.owner": "Owner — full access and account control",
  "access.manager": "Manager — salon operations and financial reports",
  "access.receptionist": "Reception — all calendars, sales and register",
  "access.professional": "Professional — own calendar and sales",
  "access.restricted": "Restricted — own calendar, read only",
  "access.help":
    "Changes apply to existing sessions on their next request. Only the owner can change access profiles or account roles.",
  "access.save": "Save access profile",
  "access.saved": "Access profile saved",
  "access.reload": "Reload access",
  "access.error": "Could not save. Reload the current profile before trying again.",
  "access.accountRole":
    "These presets apply to staff accounts. Owner and client account roles are managed separately.",
  "access.noAccount":
    "No login is linked to this calendar. The preset is ready for a linked staff account.",
} as const;
export const accessEsAR: Record<keyof typeof accessEn, string> = {
  "access.title": "Acceso del equipo",
  "access.profile": "Perfil de acceso",
  "access.owner": "Propietaria — acceso completo y control de cuentas",
  "access.manager": "Gerencia — operaciones e informes económicos",
  "access.receptionist": "Recepción — agendas, ventas y caja",
  "access.professional": "Profesional — agenda y ventas propias",
  "access.restricted": "Restringido — agenda propia, solo lectura",
  "access.help":
    "Los cambios se aplican a las sesiones existentes en su siguiente petición. Solo la propietaria puede cambiar los perfiles de acceso o los roles de las cuentas.",
  "access.save": "Guardar perfil de acceso",
  "access.saved": "Perfil de acceso guardado",
  "access.reload": "Recargar acceso",
  "access.error": "No se pudo guardar. Recarga el perfil actual antes de intentarlo de nuevo.",
  "access.accountRole":
    "Estos perfiles se aplican a cuentas del equipo. Los roles de propietaria y cliente se gestionan por separado.",
  "access.noAccount":
    "Esta agenda no tiene una cuenta vinculada. El perfil queda preparado para una cuenta del equipo.",
};
