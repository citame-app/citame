import {
  CAMPAIGN_EMAIL_LIMITS,
  type CampaignEmailLayout,
  campaignEmailLayoutText,
} from "@sob/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { useI18n } from "~/i18n/react";

type Block = CampaignEmailLayout["blocks"][number];
const blockKinds = ["paragraph", "heading", "booking"] as const;
const emphases = ["none", "strong", "italic"] as const;

function newBlock(kind: Block["kind"]): Block {
  if (kind === "booking") return { kind, label: "" };
  if (kind === "heading") return { kind, text: "" };
  return { kind, text: "", emphasis: "none" };
}

export function CampaignEmailEditor({
  body,
  layout,
  onBodyChange,
  onLayoutChange,
  invalid,
  bodyError,
}: {
  body: string;
  layout: CampaignEmailLayout | null | undefined;
  onBodyChange: (body: string) => void;
  onLayoutChange: (layout: CampaignEmailLayout | null, body: string) => void;
  invalid: boolean;
  bodyError?: string;
}) {
  const { t } = useI18n();
  const formatName = useId();
  const nextId = useRef(layout?.blocks.length ?? 0);
  const [keys, setKeys] = useState(() => layout?.blocks.map((_, index) => index) ?? []);
  const error = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (invalid) error.current?.focus();
  }, [invalid]);

  const setFormat = (formatted: boolean) => {
    if (!formatted) {
      if (layout) onLayoutChange(null, campaignEmailLayoutText(layout));
      return;
    }
    if (layout) return;
    const next: CampaignEmailLayout = {
      heading: "",
      preheader: "",
      blocks: [{ kind: "paragraph", text: body, emphasis: "none" }],
    };
    setKeys(next.blocks.map(() => nextId.current++));
    onLayoutChange(next, body);
  };
  const showLayoutLimit =
    !!layout && campaignEmailLayoutText(layout).length > CAMPAIGN_EMAIL_LIMITS.body;

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{t("marketing.emailFormat")}</legend>
      <div className="flex flex-wrap gap-x-5">
        {[false, true].map((formatted) => (
          <label key={String(formatted)} className="flex min-h-12 items-center gap-2 text-sm">
            <input
              type="radio"
              name={formatName}
              checked={Boolean(layout) === formatted}
              onChange={() => setFormat(formatted)}
            />
            {t(formatted ? "marketing.formattedEmail" : "marketing.plainEmail")}
          </label>
        ))}
      </div>
      {!layout ? (
        <TextAreaField
          label={t("marketing.emailBody")}
          name="emailBody"
          value={body}
          rows={7}
          maxLength={CAMPAIGN_EMAIL_LIMITS.body}
          onChange={(event) => onBodyChange(event.target.value)}
          error={bodyError}
        />
      ) : (
        <div className="space-y-4">
          <TextField
            label={t("marketing.emailHeading")}
            name="emailHeading"
            value={layout.heading}
            maxLength={CAMPAIGN_EMAIL_LIMITS.heading}
            onChange={(event) => onLayoutChange({ ...layout, heading: event.target.value }, body)}
          />
          <TextField
            label={t("marketing.emailPreheader")}
            name="emailPreheader"
            value={layout.preheader}
            maxLength={CAMPAIGN_EMAIL_LIMITS.preheader}
            onChange={(event) => onLayoutChange({ ...layout, preheader: event.target.value }, body)}
          />
          <ol className="space-y-3">
            {layout.blocks.map((block, index) => {
              const replace = (value: Block) => {
                onLayoutChange(
                  {
                    ...layout,
                    blocks: layout.blocks.map((item, i) => (i === index ? value : item)),
                  },
                  body,
                );
              };
              const move = (to: number) => {
                const blocks = [...layout.blocks];
                const order = [...keys];
                const target = blocks[to];
                const sourceId = order[index];
                const targetId = order[to];
                if (!target || sourceId === undefined || targetId === undefined) return;
                [blocks[index], blocks[to]] = [target, block];
                [order[index], order[to]] = [targetId, sourceId];
                setKeys(order);
                onLayoutChange({ ...layout, blocks }, body);
              };
              const value = block.kind === "booking" ? block.label : block.text;
              const label = t(`marketing.emailBlock.${block.kind}`);
              const inputError = invalid
                ? !value.trim()
                  ? t("marketing.emailBlockRequired")
                  : block.kind === "paragraph" &&
                      value.split("\n").length > CAMPAIGN_EMAIL_LIMITS.paragraphLines
                    ? t("marketing.emailParagraphLines")
                    : undefined
                : undefined;
              return (
                <li key={keys[index]} className="space-y-3 rounded-xl border border-line p-3">
                  {block.kind === "paragraph" ? (
                    <>
                      <TextAreaField
                        label={label}
                        name={`block-${index}`}
                        value={value}
                        maxLength={CAMPAIGN_EMAIL_LIMITS.body}
                        error={inputError}
                        onChange={(event) => replace({ ...block, text: event.target.value })}
                      />
                      <SelectField
                        label={t("marketing.emailEmphasis")}
                        name={`emphasis-${index}`}
                        value={block.emphasis}
                        options={emphases.map((item) => ({
                          value: item,
                          label: t(`marketing.emailEmphasis.${item}`),
                        }))}
                        onChange={(value) => {
                          const emphasis = emphases.find((item) => item === value);
                          if (emphasis) replace({ ...block, emphasis });
                        }}
                      />
                    </>
                  ) : (
                    <TextField
                      label={label}
                      name={`block-${index}`}
                      value={value}
                      maxLength={
                        block.kind === "booking"
                          ? CAMPAIGN_EMAIL_LIMITS.bookingLabel
                          : CAMPAIGN_EMAIL_LIMITS.heading
                      }
                      error={inputError}
                      onChange={(event) =>
                        replace(
                          block.kind === "booking"
                            ? { ...block, label: event.target.value }
                            : { ...block, text: event.target.value },
                        )
                      }
                    />
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={index === 0}
                      onClick={() => move(index - 1)}
                    >
                      {t("marketing.blockUp")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={index === layout.blocks.length - 1}
                      onClick={() => move(index + 1)}
                    >
                      {t("marketing.blockDown")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={layout.blocks.length === 1}
                      onClick={() => {
                        setKeys(keys.filter((_, i) => i !== index));
                        onLayoutChange(
                          { ...layout, blocks: layout.blocks.filter((_, i) => i !== index) },
                          body,
                        );
                      }}
                    >
                      {t("marketing.blockRemove")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap gap-2">
            {blockKinds.map((kind) => (
              <Button
                key={kind}
                type="button"
                variant="secondary"
                disabled={layout.blocks.length >= CAMPAIGN_EMAIL_LIMITS.blocks}
                onClick={() => {
                  setKeys([...keys, nextId.current++]);
                  onLayoutChange({ ...layout, blocks: [...layout.blocks, newBlock(kind)] }, body);
                }}
              >
                {t(`marketing.emailAdd.${kind}`)}
              </Button>
            ))}
          </div>
          {invalid && (
            <p ref={error} role="alert" tabIndex={-1} className="text-sm text-danger-fg">
              {t(showLayoutLimit ? "marketing.emailLayoutLimit" : "marketing.emailLayoutInvalid")}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

function previewText(value: string) {
  return value
    .replaceAll("{{first_name}}", "Ana")
    .replaceAll("{{salon_name}}", "Citame")
    .replaceAll("{{booking_url}}", "https://citame.example/book");
}

export function CampaignEmailPreview({
  body,
  layout,
}: {
  body: string;
  layout?: CampaignEmailLayout | null;
}) {
  if (!layout) return <p className="mt-3 whitespace-pre-wrap break-words">{previewText(body)}</p>;
  return (
    <div className="mt-3 space-y-3 break-words">
      {layout.preheader && <p className="text-sm text-muted">{previewText(layout.preheader)}</p>}
      {layout.heading && <h4 className="text-xl font-semibold">{previewText(layout.heading)}</h4>}
      {layout.blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: This static preview has no state or focusable controls.
        <div key={index}>
          {block.kind === "heading" ? (
            <h5 className="font-semibold">{previewText(block.text)}</h5>
          ) : block.kind === "booking" ? (
            <span className="inline-block rounded-md border border-line-strong bg-surface px-4 py-2 font-medium">
              {previewText(block.label)}
            </span>
          ) : (
            <p className="whitespace-pre-wrap">
              {block.emphasis === "strong" ? (
                <strong>{previewText(block.text)}</strong>
              ) : block.emphasis === "italic" ? (
                <em>{previewText(block.text)}</em>
              ) : (
                previewText(block.text)
              )}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export function SavedCampaignEmailPreview({
  subject,
  layout,
}: {
  subject: string;
  layout: CampaignEmailLayout;
}) {
  const { t } = useI18n();
  return (
    <details className="rounded-xl border border-line bg-sunken px-4">
      <summary className="cursor-pointer py-3 text-sm font-medium">
        {t("marketing.preview")}
      </summary>
      <div className="pb-4">
        <strong className="block break-words">{previewText(subject)}</strong>
        <CampaignEmailPreview body="" layout={layout} />
      </div>
    </details>
  );
}
