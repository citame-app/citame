export const clientTransferEn = {
  "clientTransfer.open": "Import clients",
  "clientTransfer.source": "CSV file and contents",
  "clientTransfer.selectAll": "Select all new profiles",
  "clientTransfer.selectNone": "Clear selection",
  "clientTransfer.export": "Export CSV",
  "clientTransfer.privacy":
    "Owner and manager access. Exports include private notes and all clients matching the current search, up to 5,000. Store downloaded files securely.",
  "clientTransfer.description": "Review a contact list before adding new client profiles.",
  "clientTransfer.format":
    "UTF-8 CSV, comma-separated, up to 500 clients and 400 KB. Use name, email, phone, notes and tags headers. A name and an email or phone are required. Separate tags with semicolons. Existing contacts are skipped; profiles and marketing consent are never overwritten.",
  "clientTransfer.template": "Download CSV template",
  "clientTransfer.file": "Choose CSV file",
  "clientTransfer.content": "CSV content",
  "clientTransfer.review": "Review import",
  "clientTransfer.preview": "Import preview",
  "clientTransfer.counts":
    "New: {create} · Repeated: {duplicate} · Invalid: {invalid} · Conflicting contacts: {ambiguous}",
  "clientTransfer.row": "Import row {row}: {name}",
  "clientTransfer.unnamed": "Unnamed client",
  "clientTransfer.status.create": "New profile — select to import",
  "clientTransfer.status.duplicate": "Repeated contact — skipped",
  "clientTransfer.status.invalid": "Correct this row before importing",
  "clientTransfer.status.ambiguous": "Contacts match different profiles — review separately",
  "clientTransfer.duplicateRow": "Contact already used in row {row}",
  "clientTransfer.issue.name": "Enter a name of 1–200 characters without line breaks.",
  "clientTransfer.issue.email": "Enter a valid email address or leave it empty.",
  "clientTransfer.issue.phone":
    "Enter a valid phone number with at least six digits or leave it empty.",
  "clientTransfer.issue.notes": "Private notes must be at most 2,000 characters.",
  "clientTransfer.issue.tags":
    "Use up to 20 unique tags of 1–40 characters, separated by semicolons.",
  "clientTransfer.issue.contact_required": "Provide an email address or phone number.",
  "clientTransfer.invalidFile":
    "Check the CSV: use UTF-8, supported headers, matching columns and closed quotes, within 500 clients and 400 KB. For a large export, narrow the directory search.",
  "clientTransfer.changed": "The directory changed. Review the file again before importing.",
  "clientTransfer.importSelected_one": "Import {count} client",
  "clientTransfer.importSelected_other": "Import {count} clients",
  "clientTransfer.created_one": "Imported {count} client.",
  "clientTransfer.created_other": "Imported {count} clients.",
  "clientTransfer.skipped_one": "Skipped {count} row.",
  "clientTransfer.skipped_other": "Skipped {count} rows.",
  "clientTransfer.exported_one": "Downloaded {count} client.",
  "clientTransfer.exported_other": "Downloaded {count} clients.",
} as const;
export const clientTransferEsAR: Record<keyof typeof clientTransferEn, string> = {
  "clientTransfer.open": "Importar clientes",
  "clientTransfer.source": "Archivo y contenido CSV",
  "clientTransfer.selectAll": "Seleccionar todas las fichas nuevas",
  "clientTransfer.selectNone": "Quitar selección",
  "clientTransfer.export": "Exportar CSV",
  "clientTransfer.privacy":
    "Acceso de propietario y gerente. La exportación incluye notas privadas y todos los clientes de la búsqueda actual, hasta 5.000. Guarda los archivos descargados de forma segura.",
  "clientTransfer.description":
    "Revisa una lista de contactos antes de añadir nuevas fichas de clientes.",
  "clientTransfer.format":
    "CSV UTF-8 separado por comas, hasta 500 clientes y 400 KB. Usa las cabeceras name, email, phone, notes y tags. Son obligatorios el nombre y un correo o teléfono. Separa las etiquetas con punto y coma. Los contactos existentes se omiten; las fichas y el consentimiento de marketing no se sobrescriben.",
  "clientTransfer.template": "Descargar plantilla CSV",
  "clientTransfer.file": "Elegir archivo CSV",
  "clientTransfer.content": "Contenido CSV",
  "clientTransfer.review": "Revisar importación",
  "clientTransfer.preview": "Vista previa de la importación",
  "clientTransfer.counts":
    "Nuevos: {create} · Repetidos: {duplicate} · No válidos: {invalid} · Contactos en conflicto: {ambiguous}",
  "clientTransfer.row": "Importar fila {row}: {name}",
  "clientTransfer.unnamed": "Cliente sin nombre",
  "clientTransfer.status.create": "Ficha nueva — selecciona para importar",
  "clientTransfer.status.duplicate": "Contacto repetido — se omite",
  "clientTransfer.status.invalid": "Corrige esta fila antes de importar",
  "clientTransfer.status.ambiguous":
    "Los contactos coinciden con fichas distintas — revisar por separado",
  "clientTransfer.duplicateRow": "Contacto ya utilizado en la fila {row}",
  "clientTransfer.issue.name": "Escribe un nombre de 1 a 200 caracteres sin saltos de línea.",
  "clientTransfer.issue.email": "Escribe un correo válido o deja el campo vacío.",
  "clientTransfer.issue.phone":
    "Escribe un teléfono válido con al menos seis dígitos o deja el campo vacío.",
  "clientTransfer.issue.notes": "Las notas privadas deben tener como máximo 2.000 caracteres.",
  "clientTransfer.issue.tags":
    "Usa hasta 20 etiquetas distintas de 1 a 40 caracteres, separadas por punto y coma.",
  "clientTransfer.issue.contact_required": "Indica un correo o un teléfono.",
  "clientTransfer.invalidFile":
    "Revisa el CSV: usa UTF-8, cabeceras admitidas, columnas coincidentes y comillas cerradas, con un máximo de 500 clientes y 400 KB. Para una exportación grande, acota la búsqueda.",
  "clientTransfer.changed":
    "El directorio ha cambiado. Revisa el archivo de nuevo antes de importar.",
  "clientTransfer.importSelected_one": "Importar {count} cliente",
  "clientTransfer.importSelected_other": "Importar {count} clientes",
  "clientTransfer.created_one": "Se ha importado {count} cliente.",
  "clientTransfer.created_other": "Se han importado {count} clientes.",
  "clientTransfer.skipped_one": "Se ha omitido {count} fila.",
  "clientTransfer.skipped_other": "Se han omitido {count} filas.",
  "clientTransfer.exported_one": "Se ha descargado {count} cliente.",
  "clientTransfer.exported_other": "Se han descargado {count} clientes.",
};
