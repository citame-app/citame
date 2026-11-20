# WhatsApp Business en Citame

Cada instalación de Citame conecta un número remitente. El propietario abre **Ajustes → WhatsApp Business** y autoriza la cuenta y el número en Meta. Si Meta ofrece coexistencia, se puede elegir el número que el centro ya usa en WhatsApp Business. El número se vincula a Citame para enviar notificaciones. Citame no sincroniza los contactos ni el historial de conversaciones del móvil.

## Configuración de Meta

1. Registra la aplicación como Tech Provider y tramita los permisos y la revisión de Meta antes de ofrecer la conexión a otros negocios. Configura Facebook Login for Business con la variación WhatsApp Embedded Signup. Citame lanza la versión 5.
2. Autoriza el dominio público HTTPS de Citame y, donde Meta solicite la URL de retorno, la página `/admin/whatsapp`. Habilita el inicio de sesión con el SDK de JavaScript.
3. En WhatsApp, configura `https://tu-centro.example/api/whatsapp/webhook` como callback y suscribe las notificaciones de `messages` y `account_update`. La conexión registra también la suscripción de la cuenta con el callback de esa instalación. Sólo se procesan los estados de mensajes enviados por Citame.
4. Define las variables de despliegue en el API y el worker. Aplica las migraciones antes de iniciar ambos. Conserva la clave de autenticación de Citame de forma segura porque protege también las credenciales cifradas del remitente.

| Variable | Valor |
| --- | --- |
| `META_WHATSAPP_APP_ID` | ID de la aplicación de Meta |
| `META_WHATSAPP_CONFIG_ID` | ID de la configuración de Facebook Login for Business |
| `META_WHATSAPP_APP_SECRET` | Secreto de la aplicación |
| `META_WHATSAPP_VERIFY_TOKEN` | Token aleatorio para verificar el webhook, de al menos 24 caracteres |
| `META_WHATSAPP_GRAPH_VERSION` | Versión fijada de Graph API, por defecto `v27.0` |

Mantén el worker de notificaciones en ejecución. Completa en WhatsApp Manager la configuración de facturación que Meta pida a la empresa. Para registrar un número nuevo, introduce el PIN de verificación de seis cifras en Citame antes de abrir la ventana de Meta. La coexistencia utiliza el número existente sin volver a registrarlo. **Renovar conexión** conserva las reglas si se vuelve a elegir el mismo número.

Citame carga un documento nuevo al entrar o salir de WhatsApp Business. Así limita a esa página los permisos de navegador que necesita la ventana de Meta. [Política del documento de WhatsApp](adr/0019-whatsapp-signup-document.md).

[Implementación de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation) · [Versión 5](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-5) · [Coexistencia](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)

## Automatizaciones de citas

- Crea en WhatsApp Manager la plantilla de categoría **Utilidad** que quieras usar. Cuando esté aprobada, actualiza la lista en Citame. Se admiten variables posicionales y con nombre en el cuerpo, y encabezados y pies de texto fijo.
- Selecciona una plantilla para confirmación, primer recordatorio, segundo recordatorio, cambio o cancelación. Asigna cada variable a un dato de la cita y prueba la vista previa. Por ejemplo, en «Recuerda que tienes tu cita mañana a las {{1}} con {{2}}», asigna la hora a `{{1}}` y el profesional a `{{2}}`.
- En **Ajustes → Recordatorios** configura la antelación. Usa 1440 minutos para enviar el aviso el día anterior a la misma hora local de la cita. Al guardar las reglas, Citame programa también los recordatorios futuros que aún están a tiempo para las citas existentes.
- El destinatario activa WhatsApp desde **Mi cuenta → Notificaciones** y necesita un número con prefijo internacional. El permiso de WhatsApp es independiente del de SMS. La regla no utiliza un número distinto del autorizado. Puedes usar la variable del enlace de preferencias para que el cliente retire el permiso de recordatorios desde un aviso.
- La actividad distingue los avisos programados, los aceptados por Meta y los estados de entrega. Si Citame pierde la respuesta tras iniciar un envío, espera la confirmación de Meta y evita repetir el mensaje. Desconectar el remitente elimina su credencial local y cancela los avisos cuyo envío aún no ha empezado. Un envío en curso puede completarse y Citame conserva el resultado que reciba de esa petición. El número y la actividad de la app de WhatsApp Business se gestionan desde Meta.
- Para los envíos nuevos, Citame guarda la cuenta y el número de origen al iniciar el envío. Las confirmaciones firmadas de ese remitente se aplican aunque se desconecte o se conecte otro número. Los envíos anteriores a la migración solo pueden actualizarse con un identificador de mensaje ya confirmado y un remitente que siga conectado.

[Plantillas de WhatsApp](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/) · [Alta como Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)
