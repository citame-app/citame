export const resourcesEn = {
  "resources.title": "Rooms & equipment",
  "resources.help":
    "Configure shared rooms, stations and equipment. The salon assigns available units automatically across all professionals.",
  "resources.effect":
    "Requirements apply to future visits and active waitlist offers only when all of them fit. Visits in progress and history keep their allocation. Capacity cannot be removed while in use.",
  "resources.new": "New resource",
  "resources.edit": "Edit {name}",
  "resources.name": "Resource name",
  "resources.kind": "Resource type",
  "resources.room": "Room",
  "resources.equipment": "Equipment",
  "resources.station": "Station",
  "resources.other": "Other",
  "resources.capacity": "Available units",
  "resources.capacityHelp":
    "Use one pool for interchangeable units; use separate pools for individually named rooms or equipment.",
  "resources.active": "Available for booking",
  "resources.inactive": "Inactive",
  "resources.save": "Save resource",
  "resources.saved": "Resource saved",
  "resources.invalid": "Enter a name, a resource type and a whole number from 1 to 20.",
  "resources.empty": "No shared resources yet",
  "resources.emptyHelp":
    "Create a room or equipment pool, then assign it to the services that need it.",
  "resources.loading": "Loading resources",
  "resources.service": "Service resources",
  "resources.choose": "Choose a service",
  "resources.quantity": "Units of {name}",
  "resources.selectionMode": "Resource assignment",
  "resources.useAll": "Use all required resources",
  "resources.useOne": "Use one available resource",
  "resources.eligible": "Eligible resources",
  "resources.alternativesHelp": "Citame chooses one available resource from the selected options.",
  "resources.zero":
    "0 means this service does not need this resource. Units are reserved for the entire service, including cleanup time.",
  "resources.saveRequirements": "Save requirements",
  "resources.requirementsSaved": "Requirements saved",
  "resources.requirementsInvalid":
    "Use whole quantities within each active resource's capacity, with at most 8 resources per service.",
  "resources.reload": "Reload current settings",
  "resources.conflict":
    "Settings changed or existing visits exceed this capacity. Your draft is kept. Review the current settings before saving again.",
  "resources.back": "Back to resources",
  "resources.discard": "Discard resource changes?",
  "resources.discardBody": "Your unsaved changes will be lost.",
  "resources.keep": "Keep editing",
  "resources.leave": "Discard changes",
} as const;
export const resourcesEsAR: Record<keyof typeof resourcesEn, string> = {
  "resources.title": "Cabinas y equipos",
  "resources.help":
    "Configura cabinas, puestos y equipos compartidos. El salón asigna las unidades disponibles automáticamente entre todos los profesionales.",
  "resources.effect":
    "Los requisitos se aplican a las citas futuras y ofertas activas de la lista de espera solo si todas caben. Las visitas en curso y el historial conservan su asignación. No puedes retirar capacidad en uso.",
  "resources.new": "Nuevo recurso",
  "resources.edit": "Editar {name}",
  "resources.name": "Nombre del recurso",
  "resources.kind": "Tipo de recurso",
  "resources.room": "Cabina",
  "resources.equipment": "Equipo",
  "resources.station": "Puesto",
  "resources.other": "Otro",
  "resources.capacity": "Unidades disponibles",
  "resources.capacityHelp":
    "Agrupa las unidades intercambiables. Crea recursos separados para cabinas o equipos que deban identificarse individualmente.",
  "resources.active": "Disponible para reservas",
  "resources.inactive": "Inactivo",
  "resources.save": "Guardar recurso",
  "resources.saved": "Recurso guardado",
  "resources.invalid": "Introduce un nombre, un tipo de recurso y un número entero de 1 a 20.",
  "resources.empty": "Todavía no hay recursos compartidos",
  "resources.emptyHelp":
    "Crea una cabina o un grupo de equipos y asígnalo a los servicios que lo necesiten.",
  "resources.loading": "Cargando recursos",
  "resources.service": "Recursos por servicio",
  "resources.choose": "Elige un servicio",
  "resources.quantity": "Unidades de {name}",
  "resources.selectionMode": "Asignación de recursos",
  "resources.useAll": "Usar todos los recursos requeridos",
  "resources.useOne": "Usar un recurso disponible",
  "resources.eligible": "Recursos admitidos",
  "resources.alternativesHelp":
    "Citame elige un recurso disponible entre las opciones seleccionadas.",
  "resources.zero":
    "0 indica que el servicio no necesita este recurso. Se reserva durante todo el servicio, incluido el tiempo de limpieza.",
  "resources.saveRequirements": "Guardar requisitos",
  "resources.requirementsSaved": "Requisitos guardados",
  "resources.requirementsInvalid":
    "Usa cantidades enteras dentro de la capacidad de cada recurso activo y un máximo de 8 recursos por servicio.",
  "resources.reload": "Recargar configuración actual",
  "resources.conflict":
    "La configuración cambió o las citas existentes superan esta capacidad. Conservamos tu borrador. Revisa la configuración actual antes de volver a guardar.",
  "resources.back": "Volver a recursos",
  "resources.discard": "¿Descartar los cambios de recursos?",
  "resources.discardBody": "Se perderán los cambios que no hayas guardado.",
  "resources.keep": "Seguir editando",
  "resources.leave": "Descartar cambios",
};
