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
  "access.current": "Current profile: {profile}",
  "access.linkedAccount": "Linked account: {email}",
  "access.link": "Link login to this calendar",
  "access.invite": "Queue email invitation",
  "access.manual": "Set an initial password instead",
  "access.emailUnavailable":
    "Ask your administrator to configure email delivery, or set an initial password.",
  "access.changed":
    "Access or the linked account changed. Review the current profile before saving your draft.",
  "access.review": "Review current access",
  "access.reload": "Reload access",
  "access.error": "Could not save. Reload the current profile before trying again.",
  "access.accountRole": "Access profiles apply to staff accounts.",
  "access.currentRole": "Account role: {role}",
  "access.newRole": "New account role",
  "access.chooseRole": "Choose a role",
  "access.role.owner": "Owner",
  "access.role.staff": "Staff",
  "access.role.client": "Client",
  "access.reviewRole": "Review role change",
  "access.changeRole": "Change account role",
  "access.confirmRole": "Confirm role change",
  "access.roleReview": "Set the role of {email} to {role}?",
  "access.roleImpact.owner":
    "This account will have full control of the centre, including account permissions.",
  "access.roleImpact.staff":
    "This account will use its staff access profile and its calendar will be activated.",
  "access.roleImpact.client":
    "This account will lose staff access and its calendar will be deactivated. Past appointments will be kept.",
  "access.roleUpcoming":
    "This calendar still has upcoming appointments. Reassign them before changing the role to client.",
  "access.roleFailed":
    "Could not confirm the role change. Review the current account before trying again.",
  "access.roleSaved": "Account role changed",
  "access.accounts.title": "Find an account without a calendar",
  "access.accounts.email": "Exact account email",
  "access.accounts.search": "Find account",
  "access.accounts.invalidEmail": "Enter a complete email address.",
  "access.accounts.notFound":
    "No unlinked account matches that email. Use Staff access for accounts with a calendar.",
  "access.accounts.verifyEmail":
    "The account must verify its email before it can receive staff or owner access.",
  "access.accounts.lookupFailed":
    "Could not look up the account. Check the connection and try again.",
  "access.accounts.saveFailed":
    "Could not confirm the change. Look up the account again before retrying.",
  "access.accounts.impact.staff":
    "Citame will create a calendar for this existing account. Review its working hours and services in Staff access.",
  "access.accounts.impact.client":
    "This account will have client access. Its previous appointments will be kept.",
  "access.accounts.openCalendar": "Open staff calendar settings",
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
  "access.current": "Perfil actual: {profile}",
  "access.linkedAccount": "Cuenta vinculada: {email}",
  "access.link": "Vincular cuenta a esta agenda",
  "access.invite": "Poner invitación en cola",
  "access.manual": "Establecer una contraseña inicial",
  "access.emailUnavailable":
    "Pide a quien administra la instalación que configure el correo o establece una contraseña inicial.",
  "access.changed":
    "Cambió el acceso o la cuenta vinculada. Revisa el perfil actual antes de guardar tu borrador.",
  "access.review": "Revisar acceso actual",
  "access.reload": "Recargar acceso",
  "access.error": "No se pudo guardar. Recarga el perfil actual antes de intentarlo de nuevo.",
  "access.accountRole": "Los perfiles de acceso se aplican a las cuentas del equipo.",
  "access.currentRole": "Rol de la cuenta: {role}",
  "access.newRole": "Nuevo rol de la cuenta",
  "access.chooseRole": "Elige un rol",
  "access.role.owner": "Propietaria",
  "access.role.staff": "Profesional",
  "access.role.client": "Cliente",
  "access.reviewRole": "Revisar cambio de rol",
  "access.changeRole": "Cambiar rol de la cuenta",
  "access.confirmRole": "Confirmar cambio de rol",
  "access.roleReview": "¿Cambiar el rol de {email} a {role}?",
  "access.roleImpact.owner":
    "Esta cuenta tendrá control total del centro, incluidos los permisos de otras cuentas.",
  "access.roleImpact.staff": "Esta cuenta usará su perfil de acceso y se activará su agenda.",
  "access.roleImpact.client":
    "Esta cuenta perderá el acceso del equipo y se desactivará su agenda. Se conservarán las citas anteriores.",
  "access.roleUpcoming":
    "Esta agenda tiene citas próximas. Reasígnalas antes de cambiar el rol a cliente.",
  "access.roleFailed":
    "No se pudo confirmar el cambio de rol. Revisa la cuenta antes de volver a intentarlo.",
  "access.roleSaved": "Rol de la cuenta actualizado",
  "access.accounts.title": "Buscar cuenta sin agenda",
  "access.accounts.email": "Correo exacto de la cuenta",
  "access.accounts.search": "Buscar cuenta",
  "access.accounts.invalidEmail": "Escribe un correo electrónico completo.",
  "access.accounts.notFound":
    "No hay una cuenta sin agenda con ese correo. Usa Acceso del equipo para las cuentas con agenda.",
  "access.accounts.verifyEmail":
    "La cuenta debe verificar su correo para recibir acceso de profesional o propietaria.",
  "access.accounts.lookupFailed":
    "No se pudo consultar la cuenta. Comprueba la conexión y vuelve a intentarlo.",
  "access.accounts.saveFailed":
    "No se pudo confirmar el cambio. Vuelve a buscar la cuenta antes de reintentar.",
  "access.accounts.impact.staff":
    "Citame creará una agenda para esta cuenta. Revisa sus horarios y servicios en Acceso del equipo.",
  "access.accounts.impact.client":
    "Esta cuenta tendrá acceso de cliente. Se conservarán sus citas anteriores.",
  "access.accounts.openCalendar": "Abrir configuración de la agenda",
  "access.noAccount":
    "Esta agenda no tiene una cuenta vinculada. El perfil queda preparado para una cuenta del equipo.",
};
