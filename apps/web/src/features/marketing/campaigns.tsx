import {
  CAMPAIGN_COMPARISON_MAX,
  type Campaign,
  type CampaignDraft,
  type CampaignQueue,
  type CampaignTestEmail,
  campaignDraftSchema,
  campaignStatusSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { usePolicySubmission } from "~/features/admin/policy-submission";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { useDebounced } from "~/features/admin/use-debounced";
import type { Translator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { localDateOf } from "~/lib/format";
import { zonedInstant } from "~/lib/zoned";
import { InvitationContacts } from "./invitation-contacts";

function lostMarketingAccess(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

function MarketingAccessError({ error, onClose }: { error: ApiError; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()} title={t("marketing.campaigns")}>
      <ErrorState error={error} />
    </Sheet>
  );
}

export const campaignFields = (c: CampaignDraft): CampaignDraft => ({
  name: c.name,
  channel: c.channel,
  subject: c.subject,
  emailBody: c.emailBody,
  smsBody: c.smsBody,
  audience: c.audience,
  trigger: c.trigger,
  delayMinutes: c.delayMinutes,
  birthdayLeadDays: c.birthdayLeadDays,
});
function template(t: Translator, trigger: CampaignDraft["trigger"]): CampaignDraft {
  const subject = t(
    trigger === "first_visit"
      ? "marketing.firstSubject"
      : trigger === "inactive"
        ? "marketing.inactiveSubject"
        : trigger === "birthday"
          ? "marketing.birthdaySubject"
          : "marketing.customSubject",
  );
  const body = t(
    trigger === "first_visit"
      ? "marketing.firstBody"
      : trigger === "inactive"
        ? "marketing.inactiveBody"
        : trigger === "birthday"
          ? "marketing.birthdayBody"
          : "marketing.customBody",
  );
  return {
    name: t(trigger === "manual" ? "marketing.custom" : `marketing.${trigger}`),
    channel: "email",
    subject,
    emailBody: body,
    smsBody: body,
    audience: {
      tags: [],
      inactiveDays: trigger === "inactive" ? 60 : null,
      noFutureAppointments: trigger === "inactive",
    },
    trigger,
    delayMinutes: trigger === "first_visit" ? 120 : 0,
    birthdayLeadDays: 0,
  };
}
export function CampaignsView({ viewerId, isOwner }: { viewerId: string; isOwner: boolean }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const term = useDebounced(search, 250);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{
    initial: Campaign | null;
    copy?: CampaignDraft;
    contacts?: Campaign["selectedContacts"];
  } | null>(null);
  const [review, setReview] = useState<Campaign | null>(null);
  const [detail, setDetail] = useState<Campaign | null>(null);
  const [selected, setSelected] = useState<Pick<Campaign, "id" | "name">[]>([]);
  const [comparing, setComparing] = useState(false);
  const removeSelection = (id: string) =>
    setSelected((items) => items.filter((item) => item.id !== id));
  const [saved, setSaved] = useState(false);
  const queries = useQueryClient();
  const query = useQuery({
    queryKey: ["marketing", "campaigns", viewerId, term, status, page],
    queryFn: () =>
      api().marketing.list({
        bookingInvitations: "1",
        search: term,
        status: campaignStatusSchema.safeParse(status).success
          ? (status as Campaign["status"])
          : undefined,
        page,
      }),
    refetchInterval: 15000,
  });
  const refresh = () => void queries.invalidateQueries({ queryKey: ["marketing"] });
  if (lostMarketingAccess(query.error)) return <ErrorState error={query.error} />;
  return (
    <section aria-label={t("marketing.campaigns")} className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-heading">{t("marketing.campaigns")}</h2>
          <p className="mt-2 text-sm text-muted">{t("marketing.campaignHelp")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {query.data?.bookingInvitations && !query.isError && (
            <Button
              variant="secondary"
              onClick={() => {
                setSaved(false);
                const draft = template(t, "manual");
                const body = t("marketing.invitationBody");
                setEditing({
                  initial: null,
                  copy: {
                    ...draft,
                    name: t("marketing.invite"),
                    subject: t("marketing.invitationSubject"),
                    emailBody: body,
                    smsBody: body,
                    audience: { ...draft.audience, selectedClientIds: [] },
                  },
                });
              }}
            >
              {t("marketing.invite")}
            </Button>
          )}
          <Button
            onClick={() => {
              setSaved(false);
              setEditing({ initial: null });
            }}
          >
            {t("marketing.new")}
          </Button>
        </div>
      </div>
      {saved && (
        <p role="status" className="text-sm text-success-fg">
          {t("marketing.saved")}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_15rem]">
        <TextField
          label={t("marketing.search")}
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <SelectField
          label={t("marketing.status")}
          value={status}
          options={[
            { value: "", label: t("marketing.allStatuses") },
            ...campaignStatusSchema.options.map((value) => ({
              value,
              label: t(`marketing.${value}`),
            })),
          ]}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={selected.length < 2 || query.isError}
          onClick={() => setComparing(true)}
        >
          {t("marketing.compare")}
        </Button>
        <p className="text-sm text-muted">
          {t("marketing.comparisonSelection", {
            count: selected.length,
            max: CAMPAIGN_COMPARISON_MAX,
          })}
        </p>
        {selected.map((item) => (
          <Button
            key={item.id}
            variant="secondary"
            onClick={() => removeSelection(item.id)}
            aria-label={t("marketing.invitationRemove", { name: item.name })}
            className="max-w-full"
          >
            <span className="truncate">{item.name}</span> <span aria-hidden="true">×</span>
          </Button>
        ))}
      </div>
      {query.isPending ? (
        <Skeleton className="h-56" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          {!query.data.campaigns.length ? (
            <EmptyState title={t("marketing.empty")} />
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {query.data.campaigns.map((c) => (
                <li key={c.id} className="flex items-center pl-2">
                  <label className="grid size-11 shrink-0 cursor-pointer place-items-center">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0"
                      aria-label={t("marketing.selectComparison", { name: c.name })}
                      checked={selected.some(({ id }) => id === c.id)}
                      disabled={
                        selected.length >= CAMPAIGN_COMPARISON_MAX &&
                        !selected.some(({ id }) => id === c.id)
                      }
                      onChange={(event) => {
                        if (event.currentTarget.checked) {
                          setSelected((items) =>
                            items.length < CAMPAIGN_COMPARISON_MAX
                              ? [...items, { id: c.id, name: c.name }]
                              : items,
                          );
                        } else {
                          removeSelection(c.id);
                        }
                      }}
                    />
                  </label>

                  <button
                    type="button"
                    className="flex min-h-24 w-full flex-wrap items-center justify-between gap-4 p-5 text-left hover:bg-sunken"
                    onClick={() =>
                      c.status === "draft" ? setEditing({ initial: c }) : setDetail(c)
                    }
                  >
                    <span className="min-w-0">
                      <strong className="block break-words">{c.name}</strong>
                      <span className="mt-1 block text-sm text-muted">
                        {t(`marketing.${c.trigger}`)} · {t(`marketing.${c.channel}`)}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-4 text-sm">
                      <span className="rounded-full bg-sunken px-3 py-1.5">
                        {t(`marketing.${c.status}`)}
                      </span>
                      <span>
                        {t("marketing.sent")}: {c.counts.sent}
                      </span>
                      <span>
                        {t("marketing.pending")}: {c.counts.pending + c.counts.processing}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
              {t("inventory.previous")}
            </Button>
            <span className="text-sm">{page}</span>
            <Button
              variant="secondary"
              disabled={page * 20 >= query.data.pagination.total}
              onClick={() => setPage(page + 1)}
            >
              {t("inventory.next")}
            </Button>
          </div>
        </>
      )}
      {comparing && (
        <CampaignComparison
          viewerId={viewerId}
          ids={selected.map(({ id }) => id)}
          onClose={() => setComparing(false)}
        />
      )}
      {editing && (
        <CampaignEditor
          key={editing.initial?.id ?? "new"}
          initial={editing.initial}
          copy={editing.copy}
          contacts={editing.contacts}
          viewerId={viewerId}
          onClose={() => setEditing(null)}
          onSaved={(c, shouldReview) => {
            setEditing(null);
            setSaved(true);
            refresh();
            if (shouldReview) setReview(c);
          }}
        />
      )}
      {review && (
        <CampaignReview
          campaign={review}
          viewerId={viewerId}
          isOwner={isOwner}
          onClose={() => setReview(null)}
          onQueued={(c) => {
            setReview(null);
            setDetail(c);
            refresh();
          }}
        />
      )}
      {detail && (
        <CampaignHistory
          initial={detail}
          viewerId={viewerId}
          onClose={() => setDetail(null)}
          onDuplicate={(c) => {
            setDetail(null);
            setEditing({
              initial: null,
              contacts: c.selectedContacts,
              copy: {
                ...campaignFields(c),
                name: `${c.name} · ${t("marketing.newCopy")}`.slice(0, 160),
              },
            });
          }}
        />
      )}
    </section>
  );
}
function CampaignComparison({
  viewerId,
  ids,
  onClose,
}: {
  viewerId: string;
  ids: string[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const result = useQuery({
    queryKey: ["marketing", "comparison", viewerId, ids],
    queryFn: () => api().marketing.compare(ids),
    refetchOnMount: "always",
    refetchInterval: 15000,
  });
  const metrics = [
    "pending",
    "processing",
    "sent",
    "skipped",
    "failed",
    "unknown",
    "cancelled",
  ] as const;
  const heading = "sticky left-0 z-10 border-b border-line bg-surface px-4 py-3 text-left";
  return (
    <Sheet
      open
      size="xl"
      onOpenChange={(open) => !open && onClose()}
      title={t("marketing.compare")}
    >
      <p className="mb-4 text-sm text-muted">{t("marketing.comparisonHelp")}</p>
      {result.isPaused ? (
        <ErrorState error={new NetworkError()} />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : result.isPending || (result.isFetching && !result.isFetchedAfterMount) ? (
        <Skeleton className="h-56" />
      ) : (
        <section
          aria-label={t("marketing.comparisonMetrics")}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region needs keyboard access.
          tabIndex={0}
          className="max-w-full overflow-auto rounded-lg border border-line focus-visible:outline"
        >
          <table className="w-full text-sm">
            <caption className="sr-only">{t("marketing.comparisonMetrics")}</caption>
            <thead>
              <tr>
                <th scope="col" className={heading}>
                  {t("marketing.comparisonMetrics")}
                </th>
                {result.data.campaigns.map((campaign) => (
                  <th
                    key={campaign.id}
                    scope="col"
                    className="min-w-36 border-b border-line p-3 text-right"
                  >
                    <span className="block max-w-52 [overflow-wrap:anywhere]">{campaign.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["status", "channel", ...metrics] as const).map((metric) => (
                <tr key={metric}>
                  <th scope="row" className={heading}>
                    {t(metric === "sent" ? "marketing.providerAccepted" : `marketing.${metric}`)}
                  </th>
                  {result.data.campaigns.map((campaign) => (
                    <td
                      key={campaign.id}
                      className="border-b border-line p-3 text-right tabular-nums"
                    >
                      {metric === "channel" || metric === "status"
                        ? t(`marketing.${campaign[metric]}`)
                        : campaign.counts[metric]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </Sheet>
  );
}

function CampaignEditor({
  initial,
  copy,
  contacts,
  viewerId,
  onClose,
  onSaved,
}: {
  initial: Campaign | null;
  copy?: CampaignDraft;
  contacts?: Campaign["selectedContacts"];
  viewerId: string;
  onClose: () => void;
  onSaved: (c: Campaign, review: boolean) => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const baseline = useRef(
    initial ? campaignFields(initial) : (copy ?? template(t, "manual")),
  ).current;
  const [draft, setDraft] = useState(baseline);
  const selected = draft.audience.selectedClientIds;
  const [tags, setTags] = useState(baseline.audience.tags.join(", "));
  const [inactive, setInactive] = useState(baseline.audience.inactiveDays?.toString() ?? "");
  const [id] = useState(() => crypto.randomUUID());
  const [invalid, setInvalid] = useState(false);
  const [discard, setDiscard] = useState(false);
  const action = useRef(false);
  const candidate = campaignDraftSchema.safeParse({
    ...draft,
    audience: {
      ...draft.audience,
      tags: tags
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      inactiveDays: inactive.trim() ? Number(inactive) : null,
    },
  });
  const dirty =
    !initial || !candidate.success || JSON.stringify(candidate.data) !== JSON.stringify(baseline);
  const {
    mutation: save,
    uncertain,
    disabled,
    changed,
  } = usePolicySubmission(
    candidate.success ? candidate.data : null,
    async (packet) => {
      if (!packet) throw Error("Invalid campaign draft");
      if (!initial) return api().marketing.create({ id, ...packet });
      try {
        return await api().marketing.update(initial.id, { ...packet, version: initial.version });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const current = await api().marketing.get(initial.id);
          if (
            current.status === "draft" &&
            current.version === initial.version + 1 &&
            JSON.stringify(campaignFields(current)) === JSON.stringify(packet)
          )
            return current;
        }
        throw error;
      }
    },
    (c) => onSaved(c, action.current),
  );
  const set = <K extends keyof CampaignDraft>(key: K, value: CampaignDraft[K]) => {
    setDraft({ ...draft, [key]: value });
    changed();
    setInvalid(false);
  };
  const close = () => {
    if (save.isPending) return;
    if (dirty || uncertain) setDiscard(true);
    else onClose();
  };
  const submit = (review: boolean) => {
    if (uncertain) {
      save.mutate();
      return;
    }
    action.current = review;
    setInvalid(!candidate.success);
    if (!candidate.success) return;
    if (
      selected &&
      ((draft.channel !== "sms" && !draft.emailBody.includes("{{booking_url}}")) ||
        (draft.channel !== "email" && !draft.smsBody.includes("{{booking_url}}")))
    ) {
      setInvalid(true);
      return;
    }
    if (initial && !dirty) {
      onSaved(initial, review);
      return;
    }
    save.mutate();
  };
  const error = (key: string) =>
    invalid && candidate.error?.issues.some((i) => i.path.join(".") === key)
      ? t("pos.invalidField")
      : undefined;
  if (lostMarketingAccess(save.error)) {
    return <MarketingAccessError error={save.error} onClose={onClose} />;
  }
  return (
    <>
      <UnsavedGuard dirty={dirty || uncertain} />
      <Sheet
        open
        onOpenChange={(v) => !v && close()}
        title={t(initial ? "admin.edit" : selected ? "marketing.invite" : "marketing.new")}
        size="lg"
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="secondary" disabled={save.isPending} onClick={close}>
              {t("admin.cancel")}
            </Button>
            <Button
              variant="secondary"
              disabled={!online || save.isPending || uncertain}
              onClick={() => submit(false)}
            >
              {t("marketing.saveDraft")}
            </Button>
            <Button
              disabled={!online || save.isPending}
              loading={save.isPending}
              onClick={() => submit(true)}
            >
              {t(uncertain ? "timing.retry" : "marketing.review")}
            </Button>
          </div>
        }
      >
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit(true);
          }}
        >
          <fieldset disabled={disabled} className="space-y-5">
            {!initial && !copy && (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">{t("marketing.templates")}</legend>
                <div className="flex flex-wrap gap-2">
                  {(["manual", "first_visit", "inactive", "birthday"] as const).map((trigger) => (
                    <Button
                      key={trigger}
                      variant="secondary"
                      onClick={() => {
                        const next = template(t, trigger);
                        setDraft(next);
                        setTags("");
                        setInactive(next.audience.inactiveDays?.toString() ?? "");
                        changed();
                      }}
                    >
                      {t(trigger === "manual" ? "marketing.custom" : `marketing.${trigger}`)}
                    </Button>
                  ))}
                </div>
              </fieldset>
            )}
            <TextField
              label={t("marketing.name")}
              value={draft.name}
              maxLength={160}
              onChange={(e) => set("name", e.target.value)}
              error={error("name")}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label={t("marketing.channel")}
                value={draft.channel}
                options={(["email", "sms", "optimized"] as const).map((value) => ({
                  value,
                  label: t(`marketing.${value}`),
                }))}
                onChange={(v) => set("channel", v as CampaignDraft["channel"])}
              />
              {!selected && (
                <SelectField
                  label={t("marketing.trigger")}
                  value={draft.trigger}
                  options={(["manual", "first_visit", "inactive", "birthday"] as const).map(
                    (value) => ({ value, label: t(`marketing.${value}`) }),
                  )}
                  onChange={(v) => {
                    const trigger = v as CampaignDraft["trigger"];
                    set("trigger", trigger);
                    if (trigger === "inactive" && !inactive) setInactive("60");
                  }}
                />
              )}
            </div>
            {draft.trigger === "first_visit" && (
              <TextField
                label={t("marketing.delay")}
                type="number"
                min={0}
                max={525600}
                value={draft.delayMinutes}
                onChange={(e) => set("delayMinutes", Number(e.target.value))}
                error={error("delayMinutes")}
              />
            )}
            {draft.trigger === "birthday" && (
              <TextField
                label={t("marketing.leadDays")}
                type="number"
                min={0}
                max={30}
                value={draft.birthdayLeadDays}
                onChange={(e) => set("birthdayLeadDays", Number(e.target.value))}
                error={error("birthdayLeadDays")}
              />
            )}
            {draft.channel !== "sms" && (
              <>
                <TextField
                  label={t("marketing.subject")}
                  value={draft.subject}
                  maxLength={200}
                  onChange={(e) => set("subject", e.target.value)}
                  error={error("subject")}
                />
                <TextAreaField
                  label={t("marketing.emailBody")}
                  value={draft.emailBody}
                  rows={7}
                  maxLength={10000}
                  onChange={(e) => set("emailBody", e.target.value)}
                  error={error("emailBody")}
                />
              </>
            )}
            {draft.channel !== "email" && (
              <TextAreaField
                label={t("marketing.smsBody")}
                value={draft.smsBody}
                rows={4}
                maxLength={304}
                onChange={(e) => set("smsBody", e.target.value)}
                hint={`${draft.smsBody.length}/304`}
                error={error("smsBody")}
              />
            )}
            <p className="text-xs text-muted">{t("marketing.variables")}</p>
            {selected ? (
              <InvitationContacts
                selected={selected}
                contacts={initial?.selectedContacts ?? contacts}
                viewerId={viewerId}
                feedback={
                  invalid && !selected.length ? t("marketing.invitationRequired") : undefined
                }
                onChange={(selectedClientIds) =>
                  set("audience", { ...draft.audience, selectedClientIds })
                }
              />
            ) : (
              <fieldset className="space-y-4 rounded-xl border border-line p-4">
                <legend className="px-1 font-semibold">{t("marketing.audience")}</legend>
                <TextField
                  label={t("marketing.tags")}
                  value={tags}
                  onChange={(e) => {
                    setTags(e.target.value);
                    changed();
                  }}
                  hint={t("marketing.tagsHelp")}
                  error={error("audience.tags")}
                />
                <TextField
                  label={t("marketing.inactiveDays")}
                  type="number"
                  min={1}
                  max={3650}
                  value={inactive}
                  onChange={(e) => {
                    setInactive(e.target.value);
                    changed();
                  }}
                  error={error("audience.inactiveDays")}
                />
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5 accent-accent"
                    checked={draft.audience.noFutureAppointments}
                    onChange={(e) =>
                      set("audience", { ...draft.audience, noFutureAppointments: e.target.checked })
                    }
                  />
                  {t("marketing.noFuture")}
                </label>
              </fieldset>
            )}
            <section
              className="rounded-xl border border-line bg-sunken p-5"
              aria-label={t("marketing.preview")}
            >
              <h3 className="mb-3 text-sm font-semibold">{t("marketing.preview")}</h3>
              {draft.channel !== "sms" && (
                <strong className="block break-words">{draft.subject}</strong>
              )}
              <p className="mt-3 whitespace-pre-wrap break-words">
                {(draft.channel === "sms" ? draft.smsBody : draft.emailBody)
                  .replaceAll("{{first_name}}", "Ana")
                  .replaceAll("{{salon_name}}", "Citame")
                  .replaceAll("{{booking_url}}", "https://citame.example/book")}
              </p>
            </section>
          </fieldset>
          {invalid && (
            <p role="alert" className="text-danger-fg">
              {t(
                invalid && candidate.success && selected
                  ? "marketing.invitationLinkRequired"
                  : "marketing.invalid",
              )}
            </p>
          )}
          {uncertain && <p role="alert">{t("timing.uncertain")}</p>}
          {save.isError && <ErrorState error={save.error} />}
        </form>
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title={t("admin.unsaved.title")}
        description={t(uncertain ? "timing.uncertain" : "admin.unsaved.body")}
        confirmLabel={t("admin.unsaved.leave")}
        cancelLabel={t("admin.unsaved.stay")}
        destructive
        onConfirm={onClose}
      />
    </>
  );
}
export function campaignScheduledInstant(value: string, timeZone: string): string | null {
  if (!value) return null;
  const [date, time] = value.split("T");
  if (!date || !time) throw Error("Invalid delivery time");
  const instant = zonedInstant(date, time, timeZone);
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
  if (`${localDateOf(instant, timeZone)}T${formatted}` !== value)
    throw Error("This local time does not exist");
  return instant;
}
function CampaignReview({
  campaign,
  viewerId,
  isOwner,
  onClose,
  onQueued,
}: {
  campaign: Campaign;
  viewerId: string;
  isOwner: boolean;
  onClose: () => void;
  onQueued: (c: Campaign) => void;
}) {
  const { t, timeZone } = useI18n();
  const online = useOnline();
  const [later, setLater] = useState(false);
  const [date, setDate] = useState("");
  const [discard, setDiscard] = useState(false);
  const audience = useQuery({
    queryKey: ["marketing", "preview", viewerId, campaign.id, campaign.version],
    queryFn: () => api().marketing.preview(campaign.id),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const capabilities = useQuery({
    queryKey: ["marketing", "capabilities", viewerId],
    queryFn: () => api().marketing.capabilities(),
  });
  const testEmail = useMutation({
    mutationFn: (request: CampaignTestEmail) => api().marketing.testEmail(campaign.id, request),
  });
  const testStatus = testEmail.data?.status;
  const retryTest = testEmail.isError || testStatus === "pending";
  const testConflict =
    testEmail.error instanceof ApiError && testEmail.error.code === "version_conflict";
  const requestTestEmail = () => {
    const requestId = retryTest
      ? (testEmail.data?.requestId ?? testEmail.variables?.requestId)
      : undefined;
    testEmail.mutate({
      version: campaign.version,
      requestId: requestId ?? crypto.randomUUID(),
      mode: retryTest ? "check" : testStatus === "unconfirmed" ? "replace_unconfirmed" : "send",
    });
  };
  const reviewMatches =
    audience.data?.campaignId === campaign.id && audience.data.version === campaign.version;
  let scheduledFor: string | null = null,
    invalidDate = false;
  try {
    if (later) {
      scheduledFor = campaignScheduledInstant(date, timeZone);
      if (!scheduledFor || new Date(scheduledFor).getTime() <= Date.now()) invalidDate = true;
    }
  } catch {
    invalidDate = true;
  }
  const packet: CampaignQueue | null = audience.data
    ? { version: campaign.version, audienceHash: audience.data.audienceHash, scheduledFor }
    : null;
  const {
    mutation: queue,
    uncertain,
    disabled,
    changed,
  } = usePolicySubmission(
    packet,
    async (input) => {
      if (!input) throw Error("Review audience first");
      return api().marketing.queue(campaign.id, input);
    },
    onQueued,
  );
  const configured =
    capabilities.data?.worker &&
    (campaign.channel === "email"
      ? capabilities.data.email
      : campaign.channel === "sms"
        ? capabilities.data.sms
        : capabilities.data.email || capabilities.data.sms);
  const close = () => {
    if (queue.isPending || testEmail.isPending) return;
    if (uncertain) setDiscard(true);
    else onClose();
  };
  const accessError = [audience.error, capabilities.error, queue.error, testEmail.error].find(
    lostMarketingAccess,
  );
  if (accessError) return <MarketingAccessError error={accessError} onClose={onClose} />;
  return (
    <>
      <UnsavedGuard dirty={uncertain} />
      <Sheet
        open
        onOpenChange={(v) => !v && close()}
        title={t("marketing.review")}
        description={t("marketing.reviewHelp")}
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              variant="secondary"
              onClick={close}
              disabled={queue.isPending || testEmail.isPending}
            >
              {t("admin.cancel")}
            </Button>
            <Button
              loading={queue.isPending}
              disabled={
                !online ||
                queue.isPending ||
                testEmail.isPending ||
                (!uncertain &&
                  (!configured ||
                    !audience.data ||
                    audience.isFetching ||
                    invalidDate ||
                    (campaign.trigger === "manual" && !audience.data.eligible)))
              }
              onClick={() => queue.mutate()}
            >
              {t(
                uncertain
                  ? "timing.retry"
                  : campaign.trigger === "manual"
                    ? "marketing.schedule"
                    : "marketing.activate",
              )}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <h3 className="font-semibold">{campaign.name}</h3>
          {audience.isPending ? (
            <Skeleton className="h-32" />
          ) : audience.isError ? (
            <ErrorState error={audience.error} onRetry={() => void audience.refetch()} />
          ) : (
            <>
              <p className="text-heading">
                {t("marketing.eligible", { count: audience.data.eligible })}
              </p>
              <p className="text-sm">
                {t("marketing.email")}: {audience.data.email} · {t("marketing.sms")}:{" "}
                {audience.data.sms}
              </p>
              <p className="text-sm text-muted">
                {t("marketing.excluded", { count: audience.data.excluded })}
              </p>
              {!!audience.data.sample.length && (
                <ul className="divide-y divide-line">
                  {audience.data.sample.map((c) => (
                    <li className="flex justify-between gap-3 py-2 text-sm" key={c.clientId}>
                      <span>{c.name}</span>
                      <span>{t(`marketing.${c.channel}`)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {campaign.trigger !== "manual" && (
            <p className="text-sm text-muted">{t("marketing.automaticHelp")}</p>
          )}
          {isOwner &&
            capabilities.data?.canTestEmail &&
            campaign.channel !== "sms" &&
            reviewMatches &&
            !audience.isError && (
              <div className="space-y-2">
                <Button
                  variant="secondary"
                  loading={testEmail.isPending}
                  disabled={
                    !online ||
                    audience.isFetching ||
                    testEmail.isPending ||
                    queue.isPending ||
                    testConflict
                  }
                  onClick={requestTestEmail}
                >
                  {t(
                    retryTest && !testConflict
                      ? "marketing.testEmailCheck"
                      : testStatus === "unconfirmed"
                        ? "marketing.testEmailAgain"
                        : "marketing.testEmail",
                  )}
                </Button>
                <p role="status" className="text-sm text-success-fg">
                  {testStatus === "accepted" && t("marketing.testEmailSent")}
                  {testStatus === "pending" && t("marketing.testEmailPending")}
                  {testStatus === "not_requested" && t("marketing.testEmailNotRequested")}
                </p>
                {(testEmail.isError ||
                  testStatus === "unconfirmed" ||
                  testStatus === "rejected") && (
                  <p role="alert" className="text-sm text-danger-fg">
                    {t(
                      testConflict
                        ? "marketing.testEmailChanged"
                        : testStatus === "rejected"
                          ? "marketing.testEmailRejected"
                          : "marketing.testEmailFailed",
                    )}
                  </p>
                )}
              </div>
            )}
          {capabilities.isError ? (
            <ErrorState error={capabilities.error} />
          ) : (
            capabilities.isSuccess &&
            !configured && (
              <p role="status" className="rounded-lg border border-line bg-sunken p-4 text-sm">
                {t("marketing.notConfigured")}
              </p>
            )
          )}
          <fieldset disabled={disabled} className="space-y-4">
            <SelectField
              label={t("marketing.timing")}
              value={later ? "later" : "now"}
              options={[
                { value: "now", label: t("marketing.now") },
                { value: "later", label: t("marketing.later") },
              ]}
              onChange={(v) => {
                setLater(v === "later");
                changed();
              }}
            />
            {later && (
              <TextField
                label={`${t("marketing.date")} (${timeZone})`}
                type="datetime-local"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  changed();
                }}
                error={invalidDate ? t("pos.invalidField") : undefined}
              />
            )}
            <Button
              variant="secondary"
              disabled={audience.isFetching}
              onClick={() => {
                changed();
                void audience.refetch();
              }}
            >
              {t("marketing.refresh")}
            </Button>
          </fieldset>
          {uncertain && <p role="alert">{t("timing.uncertain")}</p>}
          {queue.isError && <ErrorState error={queue.error} />}
        </div>
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title={t("admin.unsaved.title")}
        description={t("timing.uncertain")}
        confirmLabel={t("admin.unsaved.leave")}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={onClose}
      />
    </>
  );
}
function CampaignHistory({
  initial,
  viewerId,
  onClose,
  onDuplicate,
}: {
  initial: Campaign;
  viewerId: string;
  onClose: () => void;
  onDuplicate: (c: Campaign) => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: ["marketing", "campaign", viewerId, initial.id],
    queryFn: () => api().marketing.get(initial.id),
    initialData: initial,
    refetchInterval: 5000,
  });
  const c = query.data;
  const deliveries = useQuery({
    queryKey: ["marketing", "deliveries", viewerId, c.id, page],
    queryFn: () => api().marketing.deliveries(c.id, { page }),
    refetchInterval: 5000,
  });
  const cancel = useMutation({
    mutationFn: () => api().marketing.cancel(c.id, c.version),
    onSuccess: () => {
      setConfirm(false);
      void queries.invalidateQueries({ queryKey: ["marketing"] });
    },
  });
  const accessError = [query.error, deliveries.error, cancel.error].find(lostMarketingAccess);
  if (accessError) return <MarketingAccessError error={accessError} onClose={onClose} />;
  return (
    <>
      <Sheet
        open
        onOpenChange={(v) => !v && !cancel.isPending && onClose()}
        title={c.name}
        size="lg"
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={() => onDuplicate(c)}>
              {t("marketing.duplicate")}
            </Button>
            {["scheduled", "active"].includes(c.status) && (
              <Button variant="danger" disabled={!online} onClick={() => setConfirm(true)}>
                {t("marketing.cancel")}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-5">
          <p className="text-sm text-muted">
            {t(`marketing.${c.status}`)} · {t(`marketing.${c.trigger}`)}
          </p>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Object.entries(c.counts).map(([key, value]) => (
              <div key={key} className="rounded-xl border border-line p-4">
                <dt className="text-sm text-muted">
                  {t(`marketing.${key as keyof Campaign["counts"]}`)}
                </dt>
                <dd className="mt-2 text-xl font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          {c.counts.unknown > 0 && (
            <p role="status" className="text-sm text-warning-fg">
              {t("marketing.unknownHelp")}
            </p>
          )}
          <h3 className="font-semibold">{t("marketing.deliveries")}</h3>
          {deliveries.isPending ? (
            <Skeleton className="h-32" />
          ) : deliveries.isError ? (
            <ErrorState error={deliveries.error} />
          ) : (
            <>
              {!deliveries.data.deliveries.length ? (
                <p className="text-sm text-muted">{t("marketing.noDeliveries")}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {deliveries.data.deliveries.map((d) => (
                    <li key={d.id} className="flex flex-wrap justify-between gap-3 py-3 text-sm">
                      <div>
                        <strong>{d.clientName}</strong>
                        <p className="text-muted">
                          {t(`marketing.${d.channel}`)} ·{" "}
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                            timeZone,
                          }).format(new Date(d.sentAt ?? d.createdAt))}
                        </p>
                      </div>
                      <span>{t(`marketing.${d.status}`)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-end gap-3">
                <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
                  {t("inventory.previous")}
                </Button>
                <span className="self-center">{page}</span>
                <Button
                  variant="secondary"
                  disabled={page * 20 >= deliveries.data.pagination.total}
                  onClick={() => setPage(page + 1)}
                >
                  {t("inventory.next")}
                </Button>
              </div>
            </>
          )}
          {query.isError && <ErrorState error={query.error} />}
        </div>
      </Sheet>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("marketing.cancel")}
        description={t("marketing.cancelHelp")}
        confirmLabel={t("marketing.cancel")}
        cancelLabel={t("admin.cancel")}
        destructive
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      >
        {cancel.isError && <ErrorState error={cancel.error} />}
      </ConfirmDialog>
    </>
  );
}
