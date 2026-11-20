import { type WhatsAppRule, whatsappKindSchema, whatsappVariableSchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { loadFacebookSdk, startMetaSignup } from "./meta-signup";

const settingsKey = ["admin", "whatsapp"] as const;
const deliveriesKey = [...settingsKey, "deliveries"] as const;
const templatesKey = [...settingsKey, "templates"] as const;
const events = whatsappKindSchema.options;
const fields = whatsappVariableSchema.options;
type Variable = WhatsAppRule["variables"][number];

const words = {
  en: {
    connect: "Connect WhatsApp Business",
    disconnect: "Disconnect from Citame",
    renew: "Renew connection",
    confirmDisconnect: "Confirm disconnect",
    cancel: "Cancel",
    introduction:
      "Send appointment notifications from your business number. Connect your existing WhatsApp Business app when Meta offers coexistence.",
    missing:
      "The server needs a Meta app and an Embedded Signup configuration before you can connect.",
    prepare: "Load Meta sign-in",
    sdkError: "Meta sign-in could not load. Try again or check your browser settings.",
    signupError:
      "The connection has not been completed. Try again and select a single business number.",
    connecting: "Connecting",
    pin: "Two-step verification PIN for a new number (optional)",
    pinHelp:
      "Set six digits if you are registering a new Cloud API number. Leave this empty for your existing WhatsApp Business app.",
    existing: "WhatsApp Business app connected",
    cloud: "Cloud API connected",
    expiry: "Connection expires",
    expired: "The authorization expired. Reconnect to resume sending.",
    disconnectHelp: "This stops pending WhatsApp notifications from Citame.",
    automation: "Appointment automations",
    timing:
      "Reminder timings come from Settings → Reminders. Customers must enable WhatsApp in their notification preferences.",
    manage: "Manage approved templates in WhatsApp Manager",
    refresh: "Refresh templates",
    template: "Approved utility template",
    off: "Disabled",
    choose: "Choose a field",
    save: "Save automations",
    saved: "Automations saved",
    preview: "Preview with sample data",
    noTemplates: "Add a text utility template in WhatsApp Manager and wait for Meta to approve it.",
    deliveries: "Recent activity",
    none: "No WhatsApp notifications yet.",
    states: {
      pending: "Scheduled",
      processing: "Processing",
      sent: "Accepted by Meta",
      skipped: "Skipped",
      cancelled: "Cancelled",
      failed: "Failed",
      delivered: "Delivered",
      read: "Read",
    },
    unknown: "Delivery unknown",
    events: [
      "Booking confirmation",
      "First reminder",
      "Second reminder",
      "Booking rescheduled",
      "Booking cancelled",
    ],
    fields: [
      "Customer name",
      "Business name",
      "Appointment date",
      "Appointment time",
      "Professional",
      "Services",
      "Notification preferences link",
    ],
  },
  es: {
    connect: "Conectar WhatsApp Business",
    disconnect: "Desconectar de Citame",
    renew: "Renovar conexión",
    confirmDisconnect: "Confirmar desconexión",
    cancel: "Cancelar",
    introduction:
      "Envía avisos de citas desde el número del centro. Si Meta ofrece coexistencia, podrás seguir usando tu WhatsApp Business en el móvil.",
    missing:
      "Configura la app de Meta y Embedded Signup en el servidor para poder conectar un número.",
    prepare: "Cargar inicio de sesión de Meta",
    sdkError: "No se pudo cargar Meta. Vuelve a intentarlo o revisa los ajustes del navegador.",
    signupError:
      "La conexión quedó sin completar. Vuelve a intentarlo y selecciona un único número del centro.",
    connecting: "Conectando",
    pin: "PIN de verificación para un número nuevo (opcional)",
    pinHelp:
      "Introduce seis cifras si vas a registrar un número nuevo en Cloud API. Para conectar tu WhatsApp Business del móvil, déjalo vacío.",
    existing: "WhatsApp Business del móvil conectado",
    cloud: "Cloud API conectada",
    expiry: "La autorización caduca el",
    expired: "La autorización ha caducado. Vuelve a conectar para reanudar los envíos.",
    disconnectHelp: "Esto detiene los avisos pendientes de WhatsApp que salen de Citame.",
    automation: "Automatizaciones de citas",
    timing:
      "Configura los horarios desde Ajustes → Recordatorios. Los clientes deben autorizar WhatsApp en sus preferencias de notificaciones.",
    manage: "Gestionar plantillas aprobadas en WhatsApp Manager",
    refresh: "Actualizar plantillas",
    template: "Plantilla de utilidad aprobada",
    off: "Desactivada",
    choose: "Elige un dato",
    save: "Guardar automatizaciones",
    saved: "Automatizaciones guardadas",
    preview: "Vista previa con datos de ejemplo",
    noTemplates:
      "Crea una plantilla de utilidad de texto en WhatsApp Manager y espera la aprobación de Meta.",
    deliveries: "Actividad reciente",
    none: "Todavía no hay avisos de WhatsApp.",
    states: {
      pending: "Programado",
      processing: "En proceso",
      sent: "Aceptado por Meta",
      skipped: "Omitido",
      cancelled: "Cancelado",
      failed: "Fallido",
      delivered: "Entregado",
      read: "Leído",
    },
    unknown: "Entrega sin confirmar",
    events: [
      "Confirmación de cita",
      "Primer recordatorio",
      "Segundo recordatorio",
      "Cambio de cita",
      "Cancelación de cita",
    ],
    fields: [
      "Nombre del cliente",
      "Nombre del centro",
      "Fecha de la cita",
      "Hora de la cita",
      "Profesional",
      "Servicios",
      "Enlace de preferencias de notificaciones",
    ],
  },
};
const sample: Record<Variable, string> = {
  client: "Lucía",
  salon: "Citame",
  date: "18/11/2026",
  time: "16:00",
  staff: "Natalia",
  services: "Manicura",
  preferences: "https://citame.example/notifications",
};
type Draft = Partial<Record<WhatsAppRule["kind"], { templateId: string; variables: string[] }>>;

export function WhatsAppSettings() {
  const { locale } = useI18n();
  const copy = locale.startsWith("es") ? words.es : words.en;
  const queryClient = useQueryClient();
  const endpoints = api().admin.whatsapp;
  const status = useQuery({ queryKey: settingsKey, queryFn: endpoints.get });
  const connection = status.data?.connection;
  const setup = status.data?.setup;
  const templates = useQuery({
    queryKey: templatesKey,
    queryFn: endpoints.templates,
    enabled: Boolean(connection && setup),
  });
  const deliveries = useQuery({
    queryKey: deliveriesKey,
    queryFn: endpoints.deliveries,
    enabled: Boolean(connection),
    refetchInterval: 30000,
  });
  const [draft, setDraft] = useState<Draft>({});
  const [pin, setPin] = useState("");
  const [sdk, setSdk] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [popup, setPopup] = useState(false);
  const [signupError, setSignupError] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    setDraft(Object.fromEntries((connection?.rules ?? []).map((rule) => [rule.kind, rule])));
  }, [connection]);

  const connect = useMutation({
    mutationFn: endpoints.connect,
    onSuccess: (result) => {
      setPin("");
      setRenewing(false);
      queryClient.removeQueries({ queryKey: templatesKey });
      queryClient.setQueryData(settingsKey, result);
    },
    onSettled: () => setPopup(false),
  });
  const disconnect = useMutation({
    mutationFn: endpoints.disconnect,
    onSuccess: (result) => {
      queryClient.removeQueries({ queryKey: templatesKey });
      queryClient.setQueryData(settingsKey, result);
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: deliveriesKey });
    },
  });
  const save = useMutation({
    mutationFn: endpoints.save,
    onSuccess: (result) => {
      queryClient.setQueryData(settingsKey, result);
      void queryClient.invalidateQueries({ queryKey: deliveriesKey });
    },
  });
  const findTemplate = (id?: string) => templates.data?.find((item) => item.id === id);
  const rules: WhatsAppRule[] = events.flatMap((kind) => {
    const selection = draft[kind];
    if (!selection?.templateId) return [];
    return [
      { kind, templateId: selection.templateId, variables: selection.variables as Variable[] },
    ];
  });
  const invalid = rules.some(
    ({ templateId, variables }) =>
      findTemplate(templateId)?.parameters.length !== variables.length ||
      variables.some((value) => !fields.includes(value)),
  );
  const savedRules = events.flatMap((kind) =>
    (connection?.rules ?? []).filter((item) => item.kind === kind),
  );
  const dirty = JSON.stringify(rules) !== JSON.stringify(savedRules);
  const expired = Boolean(
    connection?.expiresAt && new Date(connection.expiresAt).getTime() <= Date.now(),
  );

  if (status.isError)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  if (!status.data) return <Skeleton className="h-64" />;

  async function prepareSdk() {
    if (!setup) return;
    setSdk("loading");
    try {
      const facebook = await loadFacebookSdk();
      facebook.init({
        appId: setup.appId,
        version: setup.version,
        xfbml: false,
        autoLogAppEvents: false,
      });
      setSdk("ready");
    } catch {
      setSdk("failed");
    }
  }

  function begin() {
    if (!setup) return;
    setPopup(true);
    setSignupError(false);
    connect.reset();
    cleanup.current?.();
    cleanup.current = startMetaSignup(
      setup.configId,
      pin,
      (input) => connect.mutate(input),
      () => {
        setPopup(false);
        setSignupError(true);
      },
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
        <h2 className="text-heading">
          {connection ? (connection.coexistence ? copy.existing : copy.cloud) : copy.connect}
        </h2>
        {connection && !renewing ? (
          <>
            <p className="font-semibold">{connection.phone}</p>
            {connection.expiresAt && (
              <p className="text-sm text-muted">
                {expired
                  ? copy.expired
                  : `${copy.expiry} ${new Date(connection.expiresAt).toLocaleDateString(locale)}`}
              </p>
            )}
            {confirm && <p className="text-sm">{copy.disconnectHelp}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                variant={confirm ? "danger" : "secondary"}
                loading={disconnect.isPending}
                onClick={() => (confirm ? disconnect.mutate() : setConfirm(true))}
              >
                {confirm ? copy.confirmDisconnect : copy.disconnect}
              </Button>
              {!confirm && setup && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRenewing(true);
                    setSignupError(false);
                    connect.reset();
                  }}
                >
                  {copy.renew}
                </Button>
              )}
              {confirm && (
                <Button variant="ghost" onClick={() => setConfirm(false)}>
                  {copy.cancel}
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">{setup ? copy.introduction : copy.missing}</p>
            {setup && sdk !== "ready" && (
              <Button onClick={() => void prepareSdk()} loading={sdk === "loading"}>
                {copy.prepare}
              </Button>
            )}
            {setup && sdk === "ready" && (
              <>
                {!renewing && (
                  <>
                    <label className="block space-y-2 text-sm">
                      <span>{copy.pin}</span>
                      <input
                        type="password"
                        inputMode="numeric"
                        maxLength={6}
                        autoComplete="off"
                        className="block min-h-11 w-36 rounded-md border border-line bg-surface px-3"
                        value={pin}
                        onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                        aria-describedby="whatsapp-pin-help"
                      />
                    </label>
                    <p id="whatsapp-pin-help" className="text-sm text-muted">
                      {copy.pinHelp}
                    </p>
                  </>
                )}
                <Button
                  onClick={begin}
                  disabled={pin.length !== 0 && pin.length !== 6}
                  loading={popup}
                >
                  {popup ? copy.connecting : copy.connect}
                </Button>
              </>
            )}
            {renewing && !popup && (
              <Button variant="ghost" onClick={() => setRenewing(false)}>
                {copy.cancel}
              </Button>
            )}
            {(sdk === "failed" || signupError) && (
              <p role="alert" className="text-danger-fg">
                {sdk === "failed" ? copy.sdkError : copy.signupError}
              </p>
            )}
          </>
        )}
        {(connect.error || disconnect.error) && (
          <p role="alert" className="text-danger-fg">
            {(connect.error ?? disconnect.error)?.message}
          </p>
        )}
      </section>

      {connection && setup && !expired && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid && dirty) save.mutate(rules);
          }}
        >
          <section className="space-y-3">
            <h2 className="text-heading">{copy.automation}</h2>
            <p className="text-sm text-muted">{copy.timing}</p>
            <div className="flex flex-wrap items-center gap-3">
              <a
                className="text-sm font-semibold text-accent-text underline"
                href="https://business.facebook.com/wa/manage/home/"
                target="_blank"
                rel="noreferrer"
              >
                {copy.manage}
              </a>
              <Button
                variant="secondary"
                onClick={() => void templates.refetch()}
                loading={templates.isFetching}
              >
                {copy.refresh}
              </Button>
            </div>
          </section>
          {templates.isError && (
            <ErrorState error={templates.error} onRetry={() => void templates.refetch()} />
          )}
          {templates.data?.length === 0 && <p className="text-sm text-muted">{copy.noTemplates}</p>}
          {events.map((kind, eventIndex) => {
            const selection = draft[kind];
            const template = findTemplate(selection?.templateId);
            const unavailable = !template && selection?.templateId;
            const setRule = (value: Draft[typeof kind]) =>
              setDraft((current) => ({ ...current, [kind]: value }));
            return (
              <section
                key={kind}
                className="space-y-3 rounded-xl border border-line bg-surface p-5"
              >
                <h3 className="font-semibold">{copy.events[eventIndex]}</h3>
                <SelectField
                  label={copy.template}
                  value={selection?.templateId ?? ""}
                  options={[
                    { label: copy.off, value: "" },
                    ...(unavailable
                      ? [{ label: unavailable, value: unavailable, disabled: true }]
                      : []),
                    ...(templates.data ?? []).map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${item.language}`,
                    })),
                  ]}
                  onChange={(id) => {
                    const selected = findTemplate(id);
                    setRule(
                      selected
                        ? { templateId: id, variables: selected.parameters.map(() => "") }
                        : undefined,
                    );
                  }}
                />
                {template && selection && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {template.parameters.map((key, index) => (
                        <SelectField
                          key={key}
                          label={`{{${key}}}`}
                          value={selection.variables[index] ?? ""}
                          options={[
                            { value: "", label: copy.choose },
                            ...fields.map((field, i) => ({ value: field, label: copy.fields[i]! })),
                          ]}
                          onChange={(value) =>
                            setRule({
                              ...selection,
                              variables: selection.variables.map((field, i) =>
                                i === index ? value : field,
                              ),
                            })
                          }
                        />
                      ))}
                    </div>
                    <figure className="rounded-md bg-sunken p-3">
                      <figcaption className="mb-1 text-xs text-muted">{copy.preview}</figcaption>
                      <p className="whitespace-pre-wrap text-sm">
                        {template.body.replace(
                          /{{\s*([a-z0-9_]+)\s*}}/g,
                          (match, key: string) =>
                            sample[
                              selection.variables[template.parameters.indexOf(key)] as Variable
                            ] ?? match,
                        )}
                      </p>
                    </figure>
                  </>
                )}
              </section>
            );
          })}
          {save.error && (
            <p role="alert" className="text-danger-fg">
              {save.error.message}
            </p>
          )}
          {save.isSuccess && !dirty && (
            <p role="status" className="text-sm">
              {copy.saved}
            </p>
          )}
          <Button type="submit" disabled={invalid || !dirty} loading={save.isPending}>
            {copy.save}
          </Button>
        </form>
      )}
      {connection && (
        <section className="space-y-3 rounded-xl border border-line bg-surface p-5">
          <h2 className="text-heading">{copy.deliveries}</h2>
          {deliveries.isPending && <Skeleton className="h-14" />}
          {deliveries.isError && (
            <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} />
          )}
          {deliveries.data?.length === 0 && <p className="text-sm text-muted">{copy.none}</p>}
          <ul className="divide-y divide-line">
            {deliveries.data?.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span>
                  {copy.events[events.indexOf(item.kind)]} ·{" "}
                  {new Date(item.scheduledFor).toLocaleString(locale, {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
                <span className="font-semibold text-muted">
                  {!item.delivery && item.lastError === "whatsapp_delivery_unknown"
                    ? copy.unknown
                    : copy.states[item.delivery ?? item.status]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
