export const passesEn = {
  "passes.renewalPayment": "Renewal payment",
  "passes.payManually": "Pay each renewal manually",
  "passes.payAutomatically": "Renew automatically by card",
  "passes.recurringHelp":
    "Each new period uses this agreed price. Card authentication is required to set up automatic payment. A charge already dispatched may still settle after you stop renewal.",
  "passes.recurringAgreement_one":
    "I authorize automatic card payments of {amount} each month until I stop renewal.",
  "passes.recurringAgreement_other":
    "I authorize automatic card payments of {amount} every {count} months until I stop renewal.",
  "passes.termsChanged": "Plan terms changed. Review the current price and authorize it again.",
  "passes.recurringUnavailable":
    "Automatic renewal is unavailable. Choose manual payment or retry later.",
  "passes.servicesChanged":
    "Eligible services changed. Ask the salon to review this plan before purchasing.",
  "passes.setupCard": "Complete this purchase by card to set up automatic renewal.",
  "passes.autoReady":
    "Automatic card renewal is set up at the agreed price. You can stop future renewals here.",
  "passes.autoAttention":
    "Automatic renewal needs attention. Pay a renewal by card or contact the salon.",
  "passes.autoInvoice":
    "An unpaid renewal invoice is open. Complete or reconcile it before another renewal; no second automatic attempt will be made.",
  "passes.automaticCharge": "Automatic membership card payment",
  "passes.cancelPurchase": "Cancel unpaid purchase",
  "passes.cancelPurchaseHelp":
    "Cancelling an unpaid renewal also stops future automatic renewal. Already paid benefits remain valid.",

  "passes.title": "Packages & memberships",
  "passes.lead":
    "Prepaid visits and membership benefits, with each paid period recorded separately.",
  "passes.manage": "Manage plans",
  "passes.catalog": "Available plans",
  "passes.newPlan": "New plan",
  "passes.editPlan": "Edit plan",
  "passes.name": "Plan name",
  "passes.description": "Description",
  "passes.kind": "Plan type",
  "passes.package": "Visit package",
  "passes.membership": "Membership",
  "passes.price": "Price (EUR)",
  "passes.uses": "Included visits",
  "passes.discount": "Member discount (%)",
  "passes.tax": "Included tax (%)",
  "passes.days": "Validity in days (empty: no expiry)",
  "passes.months": "Billing interval (months)",
  "passes.services": "Eligible services",
  "passes.active": "Available for new purchases",
  "passes.save": "Save plan",
  "passes.buy": "Purchase plan",
  "passes.selectBuyer": "Buyer account",
  "passes.searchBuyer": "Search buyer",
  "passes.create": "Create purchase",
  "passes.empty": "No passes yet",
  "passes.emptyHelp": "Choose a configured plan or ask at the salon.",
  "passes.noPlans": "No plans have been configured yet.",
  "passes.unavailable": "Online payment is unavailable. You can buy or renew at the salon.",
  "passes.search": "Search pass name",
  "passes.view": "View pass",
  "passes.back": "Back to passes",
  "passes.visits": "{available} available · {used} used · {held} held for refund",
  "passes.returned": "Returned visits: {count}",
  "passes.remaining": "Unused prepaid value: {amount}",
  "passes.periods": "Paid periods & renewals",
  "passes.period": "Period {index}",
  "passes.status.pending": "Awaiting payment",
  "passes.status.active": "Active",
  "passes.status.upcoming": "Upcoming",
  "passes.status.expired": "Expired",
  "passes.status.void": "Voided",
  "passes.status.cancelled": "Cancelled",
  "passes.from": "Valid from: {date}",
  "passes.until": "Valid until: {date}",
  "passes.noExpiry": "No expiry date",
  "passes.awaitingValidity": "Validity begins after payment.",
  "passes.renew": "Renew membership",
  "passes.cancel": "Stop renewal",
  "passes.reason": "Cancellation reason",
  "passes.cancelledHelp":
    "Renewal stopped. Paid benefits remain valid through their recorded expiry.",
  "passes.manualHelp":
    "Renewal requires a separate purchase and payment. No automatic charge will be made.",
  "passes.discounts": "Member discount: {discount}% on eligible services",
  "passes.error":
    "Could not save. Check the current terms, buyer, visits and payment state, then retry.",
  "passes.receipt": "Purchase receipt",
  "passes.redeem": "Use prepaid visit",
  "passes.tenderHelp":
    "A visit covers one eligible service line. Apply visits before other payments; tips and products are separate.",
  "passes.line": "Service covered by this visit",
  "passes.choose": "Choose a pass visit",
  "passes.refundUnits": "Unused visits to return",
  "passes.refundHelp":
    "Purchase refunds return whole unused visits at their original allocated value. Redeemed visits must be returned in full.",
  "passes.feeHelp":
    "Returning a membership access fee ends that period’s future discount benefit; split payments are returned separately.",
  "passes.nominalApplied": "Prepaid visits applied (receipt value)",
  "passes.nominalReturned": "Prepaid visits returned (receipt value)",
  "passes.allocatedApplied": "Prepaid visit value recognized",
  "passes.allocatedReturned": "Prepaid visit value reversed",
  "passes.fees": "Membership access fees",
  "passes.planHelp":
    "Prices include tax. Existing purchases keep their original terms when you edit or archive a plan.",
} as const;
export const passesEsAR: Record<keyof typeof passesEn, string> = {
  "passes.renewalPayment": "Pago de la renovación",
  "passes.payManually": "Pagar cada renovación manualmente",
  "passes.payAutomatically": "Renovar automáticamente con tarjeta",
  "passes.recurringHelp":
    "Cada periodo nuevo usa este precio acordado. La configuración requiere autenticar la tarjeta. Un cargo ya enviado al banco puede completarse después de detener la renovación.",
  "passes.recurringAgreement_one":
    "Autorizo cobros automáticos con tarjeta de {amount} cada mes hasta detener la renovación.",
  "passes.recurringAgreement_other":
    "Autorizo cobros automáticos con tarjeta de {amount} cada {count} meses hasta detener la renovación.",
  "passes.termsChanged":
    "Las condiciones han cambiado. Revisa el precio actual y vuelve a autorizarlo.",
  "passes.recurringUnavailable":
    "La renovación automática no está disponible. Elige pago manual o inténtalo más tarde.",
  "passes.servicesChanged":
    "Han cambiado los servicios incluidos. Consulta con el salón antes de comprar este plan.",
  "passes.setupCard": "Completa esta compra con tarjeta para configurar la renovación automática.",
  "passes.autoReady":
    "La renovación automática con tarjeta está configurada al precio acordado. Puedes detener las renovaciones futuras aquí.",
  "passes.autoAttention":
    "La renovación automática necesita atención. Paga una renovación con tarjeta o consulta con el salón.",
  "passes.autoInvoice":
    "Hay una renovación pendiente de pago. Completa o concilia ese recibo antes de otra renovación; no se hará un segundo intento automático.",
  "passes.automaticCharge": "Pago automático de membresía con tarjeta",
  "passes.cancelPurchase": "Cancelar compra sin pagar",
  "passes.cancelPurchaseHelp":
    "Cancelar una renovación sin pagar también detiene las renovaciones automáticas futuras. Las ventajas ya pagadas siguen vigentes.",

  "passes.title": "Bonos y membresías",
  "passes.lead":
    "Visitas prepagadas y ventajas de membresía, con cada periodo pagado por separado.",
  "passes.manage": "Gestionar planes",
  "passes.catalog": "Planes disponibles",
  "passes.newPlan": "Nuevo plan",
  "passes.editPlan": "Editar plan",
  "passes.name": "Nombre del plan",
  "passes.description": "Descripción",
  "passes.kind": "Tipo de plan",
  "passes.package": "Bono de visitas",
  "passes.membership": "Membresía",
  "passes.price": "Precio (EUR)",
  "passes.uses": "Visitas incluidas",
  "passes.discount": "Descuento de miembro (%)",
  "passes.tax": "Impuesto incluido (%)",
  "passes.days": "Validez en días (vacío: sin caducidad)",
  "passes.months": "Intervalo de pago (meses)",
  "passes.services": "Servicios incluidos",
  "passes.active": "Disponible para nuevas compras",
  "passes.save": "Guardar plan",
  "passes.buy": "Comprar plan",
  "passes.selectBuyer": "Cuenta del comprador",
  "passes.searchBuyer": "Buscar comprador",
  "passes.create": "Crear compra",
  "passes.empty": "Todavía no hay bonos",
  "passes.emptyHelp": "Elige un plan configurado o consulta en el salón.",
  "passes.noPlans": "Todavía no hay planes configurados.",
  "passes.unavailable": "El pago online no está disponible. Puedes comprar o renovar en el salón.",
  "passes.search": "Buscar nombre del bono",
  "passes.view": "Ver bono",
  "passes.back": "Volver a bonos",
  "passes.visits": "{available} disponibles · {used} usadas · {held} retenidas para devolución",
  "passes.returned": "Visitas devueltas: {count}",
  "passes.remaining": "Valor prepago sin usar: {amount}",
  "passes.periods": "Periodos pagados y renovaciones",
  "passes.period": "Periodo {index}",
  "passes.status.pending": "Pendiente de pago",
  "passes.status.active": "Activo",
  "passes.status.upcoming": "Próximo",
  "passes.status.expired": "Caducado",
  "passes.status.void": "Anulado",
  "passes.status.cancelled": "Cancelado",
  "passes.from": "Válido desde: {date}",
  "passes.until": "Válido hasta: {date}",
  "passes.noExpiry": "Sin fecha de caducidad",
  "passes.awaitingValidity": "La validez comienza después del pago.",
  "passes.renew": "Renovar membresía",
  "passes.cancel": "Detener renovación",
  "passes.reason": "Motivo de cancelación",
  "passes.cancelledHelp":
    "Renovación detenida. Las ventajas pagadas siguen vigentes hasta su fecha de caducidad.",
  "passes.manualHelp":
    "Cada renovación requiere una compra y un pago. No se hará ningún cargo automático.",
  "passes.discounts": "Descuento de miembro: {discount}% en servicios incluidos",
  "passes.error":
    "No pudimos guardar. Revisa las condiciones actuales, el comprador, las visitas y el estado del pago e inténtalo de nuevo.",
  "passes.receipt": "Comprobante de compra",
  "passes.redeem": "Usar visita prepagada",
  "passes.tenderHelp":
    "Cada visita cubre una línea de servicio incluida. Aplica las visitas antes de otros pagos; las propinas y los productos se pagan aparte.",
  "passes.line": "Servicio cubierto por la visita",
  "passes.choose": "Elegir visita de bono",
  "passes.refundUnits": "Visitas sin usar que devolver",
  "passes.refundHelp":
    "Las compras se devuelven por visitas completas sin usar a su valor original. Las visitas canjeadas se devuelven completas.",
  "passes.feeHelp":
    "Devolver una cuota de acceso finaliza los descuentos futuros del periodo; los pagos divididos se devuelven por separado.",
  "passes.nominalApplied": "Visitas prepagadas aplicadas (valor del recibo)",
  "passes.nominalReturned": "Visitas prepagadas devueltas (valor del recibo)",
  "passes.allocatedApplied": "Valor reconocido de visitas prepagadas",
  "passes.allocatedReturned": "Valor revertido de visitas prepagadas",
  "passes.fees": "Cuotas de acceso de membresía",
  "passes.planHelp":
    "Los precios incluyen impuestos. Las compras existentes conservan sus condiciones al editar o archivar un plan.",
};
