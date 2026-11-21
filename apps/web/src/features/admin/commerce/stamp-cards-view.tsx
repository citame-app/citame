import {
  type ChangeStampCard,
  changeStampCardSchema,
  type IssueStampCard,
  issueStampCardSchema,
  permissionsFor,
  type StaffAccessPreset,
  type StampCard,
  type StampProgramTerms,
  type UserRole,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { stampCardsQueryKey } from "~/lib/api/reward-endpoints";
import { addDaysLocal, formatDateWithYear, localDateOf } from "~/lib/format";
import { zonedInstant } from "~/lib/zoned";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import { StampBulkForm } from "./stamp-bulk-form";
import { StampProgramForm } from "./stamp-program-form";

const cardStyles = {
  neutral: "bg-surface text-text",
  rose: "bg-accent-soft text-accent",
  mint: "bg-success-soft text-success-fg",
};
const stampPositions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
type ActionKind = ChangeStampCard["type"];
type Selection = { type: "issue" } | { type: ActionKind; card: StampCard };
type Command =
  | { kind: "issue"; input: IssueStampCard }
  | { kind: "change"; id: string; input: ChangeStampCard };

export function StampCardsView({
  mode,
  role,
  accessPreset,
  clientId,
  visible = true,
}: {
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  clientId?: string | null;
  visible?: boolean;
}) {
  const { t } = useI18n();
  const permissions = permissionsFor(role, accessPreset);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const debounced = useDebounced(search.trim());
  const clients = useQuery({
    queryKey: ["rewards", "customers", debounced],
    queryFn: () =>
      api().admin.clients.list({ search: debounced, pageSize: 8, sort: "name", order: "asc" }),
    enabled:
      visible && mode === "admin" && !clientId && permissions.clients && debounced.length > 0,
  });
  if (mode === "client")
    return clientId ? <CustomerCards clientId={clientId} visible={visible} /> : null;
  return (
    <section className="space-y-6" aria-label={t("stamps.title")}>
      {role === "owner" && !clientId && (
        <>
          <StampProgramForm />
          <StampBulkForm />
        </>
      )}
      {permissions.clients && !clientId && (
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2">
          <TextField
            label={t("loyalty.searchClient")}
            type="search"
            value={search}
            disabled={editing}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected("");
            }}
          />
          <SelectField
            label={t("loyalty.client")}
            value={selected}
            disabled={editing}
            options={[
              { value: "", label: t("loyalty.chooseClient") },
              ...(clients.data?.clients ?? []).map(({ id, name, email }) => ({
                value: id,
                label: email ? `${name} · ${email}` : name,
              })),
            ]}
            onChange={setSelected}
          />
          {clients.isError && (
            <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
          )}
        </div>
      )}
      {permissions.clients && (clientId || selected) && (
        <AdminCards
          key={clientId || selected}
          clientId={clientId || selected}
          canEdit={permissions.editClients}
          onEditing={setEditing}
        />
      )}
    </section>
  );
}

function StampCardTile({
  card,
  choose,
}: {
  card: StampCard;
  choose?: (selection: Selection) => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const expiration = card.completedAt ? card.rewardExpiresAt : card.stampExpiresAt;
  const available =
    card.state === "completed" && !card.needsReview
      ? "issue_reward"
      : card.state === "issued" && !card.needsReview
        ? "redeem"
        : null;
  const canAdjust =
    !card.rewardIssuedAt && ["active", "queued", "completed", "expired"].includes(card.state);
  return (
    <article className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className={`space-y-4 p-4 ${cardStyles[card.program.appearance]}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-heading">{card.program.name}</h3>
          <span className="text-sm font-semibold">{t(`stamps.state.${card.state}`)}</span>
        </div>
        <div className="flex flex-wrap gap-2" aria-hidden="true">
          {stampPositions.slice(0, card.program.goal).map((position) => (
            <span
              key={position}
              className={`grid size-8 place-items-center rounded-full border border-current ${position <= card.stamps ? "bg-accent font-semibold text-white" : "opacity-50"}`}
            >
              {position <= card.stamps ? "✓" : position}
            </span>
          ))}
        </div>
        <p className="text-sm">
          {t("stamps.progress", { filled: card.stamps, goal: card.program.goal })}
        </p>
      </div>
      <div className="space-y-2 p-4">
        <RewardSummary reward={card.program.reward} />
        {expiration && (
          <p className="text-sm text-muted">
            {t("stamps.expires", {
              date: formatDateWithYear(
                localDateOf(new Date(Date.parse(expiration) - 1).toISOString(), timeZone),
                locale,
              ),
            })}
          </p>
        )}
        {card.program.terms && (
          <p className="whitespace-pre-wrap break-words text-sm text-muted">{card.program.terms}</p>
        )}
        {card.needsReview && (
          <p className="text-sm font-semibold text-danger-fg">{t("stamps.needsReview")}</p>
        )}
        {choose && (
          <div className="flex flex-wrap gap-2 pt-2">
            {available && (
              <Button type="button" onClick={() => choose({ type: available, card })}>
                {t(`stamps.${available}`)}
              </Button>
            )}
            {canAdjust && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => choose({ type: "edit", card })}
              >
                {t("stamps.edit")}
              </Button>
            )}
            {card.state !== "void" && card.state !== "redeemed" && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => choose({ type: "void", card })}
              >
                {t("stamps.void")}
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function RewardSummary({ reward }: { reward: StampProgramTerms["reward"] }) {
  const { t, locale } = useI18n();
  return (
    <div>
      <p className="font-medium">{reward.name}</p>
      <p className="text-sm text-muted">
        {t(`stamps.${reward.kind}`)}
        {reward.discountBasisPoints !== null &&
          ` · ${new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(reward.discountBasisPoints / 10_000)}`}
      </p>
    </div>
  );
}

function CardList({
  cards,
  choose,
}: {
  cards: StampCard[];
  choose?: (selection: Selection) => void;
}) {
  const { t } = useI18n();
  if (!cards.length) return <EmptyState title={t("stamps.empty")} />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {cards.map((card) => (
        <StampCardTile key={card.id} card={card} choose={choose} />
      ))}
    </div>
  );
}

function CustomerCards({ clientId, visible }: { clientId: string; visible: boolean }) {
  const cards = useQuery({
    queryKey: ["rewards", "stamps", "me", clientId],
    queryFn: ({ signal }) => api().rewards.myStampCards(signal),
    refetchOnMount: "always",
    enabled: visible,
    refetchInterval: visible ? 15_000 : false,
  });
  if (cards.isPending) return <Skeleton className="h-40" />;
  if (!cards.data) return <ErrorState error={cards.error} onRetry={() => void cards.refetch()} />;
  return <CardList cards={cards.data.cards} />;
}

function AdminCards({
  clientId,
  canEdit,
  onEditing,
}: {
  clientId: string;
  canEdit: boolean;
  onEditing: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const [selection, setSelection] = useState<Selection>();
  const [updated, setUpdated] = useState(false);
  const key = [...stampCardsQueryKey, clientId];
  const cards = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api().rewards.stampCards(clientId, signal),
  });
  const choose = (value: Selection) => {
    setSelection(value);
    setUpdated(false);
    onEditing(true);
  };
  const close = () => {
    setSelection(undefined);
    onEditing(false);
  };
  if (cards.isPending) return <Skeleton className="h-40" />;
  if (!cards.data) return <ErrorState error={cards.error} onRetry={() => void cards.refetch()} />;
  const source = cards.data;
  return (
    <div className="space-y-4">
      {updated && <p role="status">{t("stamps.updated")}</p>}
      {selection ? (
        <CardCommandForm
          selection={selection}
          source={source}
          clientId={clientId}
          reload={() => void cards.refetch()}
          close={close}
          onSaved={(card, generation) => {
            const current = queries.getQueryData<typeof source>(key);
            if (current && generation !== current.generation) return false;
            queries.setQueryData<typeof source>(key, (previous) => {
              if (!previous) return previous;
              const newer = previous.cards.find((record) => record.id === card.id);
              if (newer && newer.version > card.version) return previous;
              return {
                ...previous,
                cards: [card, ...previous.cards.filter((record) => record.id !== card.id)],
              };
            });
            close();
            setUpdated(true);
            void queries.invalidateQueries({ queryKey: key });
            return true;
          }}
        />
      ) : (
        <>
          {canEdit &&
            source.program.enabled &&
            !source.cards.some((card) => card.state === "active" || card.state === "queued") && (
              <Button type="button" onClick={() => choose({ type: "issue" })}>
                {t("stamps.issue")}
              </Button>
            )}
          <CardList cards={source.cards} choose={canEdit ? choose : undefined} />
        </>
      )}
    </div>
  );
}

type Source = Awaited<ReturnType<ReturnType<typeof api>["rewards"]["stampCards"]>>;
function CardCommandForm({
  selection,
  source,
  clientId,
  reload,
  close,
  onSaved,
}: {
  selection: Selection;
  source: Source;
  clientId: string;
  reload: () => void;
  close: () => void;
  onSaved: (card: StampCard, generation: string) => boolean;
}) {
  const { t, timeZone } = useI18n();
  const online = useOnline();
  const heading = useId();
  const card = selection.type === "issue" ? undefined : selection.card;
  const [base] = useState({ generation: source.generation, programVersion: source.programVersion });
  const [command, setCommand] = useState<Command>();
  const [invalid, setInvalid] = useState(false);
  const [reason, setReason] = useState("");
  const [count, setCount] = useState(String(card?.stamps ?? source.program.welcomeStamps));
  const initialExpiry = card?.stampExpiresAt
    ? localDateOf(new Date(Date.parse(card.stampExpiresAt) - 1).toISOString(), timeZone)
    : "";
  const [expiry, setExpiry] = useState(initialExpiry);
  const current = card && source.cards.find((entry) => entry.id === card.id);
  const generationChanged = source.generation !== base.generation;
  const stale =
    generationChanged ||
    (!command &&
      (card ? current?.version !== card.version : source.programVersion !== base.programVersion));
  const save = useMutation({
    mutationFn: (packet: Command) =>
      packet.kind === "issue"
        ? api().rewards.issueStampCard(packet.input)
        : api().rewards.changeStampCard(packet.id, packet.input),
    onSuccess: (value, packet) => {
      if (!onSaved(value, packet.input.generation)) setCommand(undefined);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status < 500 && error.status !== 408)
        setCommand(undefined);
      if (error instanceof ApiError && error.status === 409) reload();
    },
  });
  const showCount = selection.type === "issue" || selection.type === "edit";
  const showReason = selection.type === "void" || selection.type === "edit";
  const goal = card?.program.goal ?? source.program.goal;

  function prepare(): Command | undefined {
    const idempotencyKey = crypto.randomUUID();
    const generation = base.generation;
    if (showCount && !/^\d+$/.test(count)) return;
    const expiresAt = expiry
      ? expiry === initialExpiry && card?.stampExpiresAt
        ? card.stampExpiresAt
        : zonedInstant(addDaysLocal(expiry, 1), "00:00", timeZone)
      : null;
    if (!card) {
      const input = issueStampCardSchema.safeParse({
        clientId,
        programVersion: base.programVersion,
        initialStamps: Number(count),
        ...(expiresAt ? { expiresAt } : {}),
        generation,
        idempotencyKey,
      });
      return input.success ? { kind: "issue", input: input.data } : undefined;
    }
    const input = changeStampCardSchema.safeParse({
      type: selection.type,
      version: card.version,
      generation,
      idempotencyKey,
      ...(selection.type === "edit" ? { stamps: Number(count), expiresAt, reason } : {}),
      ...(selection.type === "void" ? { reason } : {}),
    });
    return input.success ? { kind: "change", id: card.id, input: input.data } : undefined;
  }

  return (
    <form
      aria-labelledby={heading}
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!online || save.isPending || stale) return;
        if (command) return save.mutate(command);
        try {
          const next = prepare();
          setInvalid(!next);
          setCommand(next);
        } catch {
          setInvalid(true);
        }
      }}
    >
      <UnsavedGuard dirty />
      <h3 id={heading} className="text-heading">
        {t(`stamps.${selection.type}`)}
      </h3>
      <RewardSummary reward={(card?.program ?? source.program).reward} />
      <fieldset disabled={Boolean(command) || save.isPending} className="grid gap-3 sm:grid-cols-2">
        {showCount && (
          <TextField
            name="stamps"
            label={t(selection.type === "issue" ? "stamps.initial" : "stamps.count")}
            type="number"
            min={0}
            max={goal}
            required
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        )}
        {showCount && (
          <TextField
            name="expiry"
            label={t("stamps.date")}
            type="date"
            hint={selection.type === "issue" ? t("stamps.defaultExpiry") : undefined}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        )}
        {showReason && (
          <TextField
            name="reason"
            label={t("loyalty.reason")}
            required
            minLength={8}
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </fieldset>
      {stale && <p role="alert">{t("stamps.cardChanged")}</p>}
      {invalid && <p role="alert">{t("stamps.invalid")}</p>}
      {save.isError && <ErrorState error={save.error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!online || save.isPending || stale}>
          {t(command ? (save.isError ? "stamps.retry" : "stamps.confirm") : "stamps.review")}
        </Button>
        {!save.isPending && (!command || !save.isError || stale) && (
          <Button type="button" variant="secondary" onClick={close}>
            {t("admin.cancel")}
          </Button>
        )}
      </div>
    </form>
  );
}
