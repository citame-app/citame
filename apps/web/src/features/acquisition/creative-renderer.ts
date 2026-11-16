import { createTranslator, type Locale } from "~/i18n";
import { fitCreativeText } from "./creative-layout";
import { type CreativeSource, creativeModel } from "./creative-model";
import { bookingEntryUrl } from "./links";
import { generateBookingQr } from "./qr";
export type CreativeFormat = "square" | "portrait" | "story";
export type CreativePalette = "cream" | "rose" | "ink";
export interface CreativeRenderInput {
  source: CreativeSource;
  salonName: string;
  locale: Locale;
  timeZone: string;
  origin: string;
  format: CreativeFormat;
  palette: CreativePalette;
}
export interface PreparedCreative {
  dataUrl: string;
  caption: string;
  title: string;
  bookingUrl: string;
}
export type CreativeRenderer = (input: CreativeRenderInput) => Promise<PreparedCreative>;
const colours = {
  cream: { bg: "#fbf8f5", fg: "#30262b", accent: "#a24c69", soft: "#f0d8e1" },
  rose: { bg: "#f5e4e9", fg: "#3a222d", accent: "#923e60", soft: "#eac4d2" },
  ink: { bg: "#211a20", fg: "#fbf8f5", accent: "#f2b9cd", soft: "#44303b" },
};
export const renderCreative: CreativeRenderer = async (input) => {
  await document.fonts.ready;
  const t = createTranslator(input.locale);
  const model = creativeModel(input.source, {
    locale: input.locale,
    timeZone: input.timeZone,
    now: new Date(),
  });
  const bookingUrl = bookingEntryUrl(input.origin, { serviceIds: model.serviceIds });
  const qrUrl = await generateBookingQr(bookingUrl);
  const qr = new Image();
  qr.src = qrUrl;
  await qr.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = input.format === "square" ? 1080 : input.format === "portrait" ? 1350 : 1920;
  const candidate = canvas.getContext("2d");
  if (!candidate) throw new Error("Canvas unavailable");
  const context = candidate;
  const palette = colours[input.palette];
  const height = canvas.height;
  const width = 936;
  context.fillStyle = palette.bg;
  context.fillRect(0, 0, canvas.width, height);
  context.fillStyle = palette.soft;
  context.beginPath();
  context.arc(1080, 0, 440, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = palette.fg;
  context.textBaseline = "top";
  const display = '"Fraunces Variable", Georgia, serif';
  const sans = '"Inter Variable", sans-serif';
  function text(
    value: string,
    y: number,
    maxHeight: number,
    min: number,
    max: number,
    family = sans,
    weight = 400,
    colour = palette.fg,
    textWidth = width,
  ) {
    const fitted = fitCreativeText(
      value,
      textWidth,
      maxHeight,
      { min, max, lineHeight: 1.22 },
      (line, size) => {
        context.font = `${weight} ${size}px ${family}`;
        return context.measureText(line).width;
      },
    );
    context.font = `${weight} ${fitted.fontSize}px ${family}`;
    context.fillStyle = colour;
    for (const [index, line] of fitted.lines.entries())
      context.fillText(line, 72, y + index * fitted.lineHeight);
    return fitted.height;
  }
  text(input.salonName, 64, 108, 26, 48, display, 600);
  text(model.eyebrow.toLocaleUpperCase(input.locale), 188, 40, 22, 26, sans, 600, palette.accent);
  let y = 256;
  const bottom = height - 340;
  y += text(model.title, y, Math.min(210, (bottom - y) * 0.32), 42, 72, display, 600) + 24;
  y += text(model.emphasis, y, 92, 36, 68, display, 500, palette.accent) + 26;
  const attribution = model.attribution ? 100 : 0;
  const excerpt = model.reviewExcerpted ? 66 : 0;
  y +=
    text(
      model.paragraphs.join("\n"),
      y,
      bottom - y - attribution - excerpt,
      model.kind === "promotion" ? 28 : 34,
      model.kind === "promotion" ? 34 : 44,
    ) + 12;
  if (model.attribution) y += text(`— ${model.attribution}`, y, 88, 28, 36, sans, 500) + 10;
  if (model.reviewExcerpted) text(t("social.excerpt"), y, 56, 22, 24);
  context.fillStyle = palette.accent;
  context.fillRect(72, height - 306, 936, 2);
  text(t("social.book"), height - 268, 106, 30, 42, display, 600, palette.fg, 640);
  text(new URL(bookingUrl).host, height - 158, 68, 24, 30, sans, 400, palette.fg, 640);
  text(t("social.scan"), height - 84, 34, 20, 24, sans, 500, palette.accent, 640);
  context.fillStyle = "#ffffff";
  context.fillRect(780, height - 282, 228, 228);
  context.imageSmoothingEnabled = false;
  context.drawImage(qr, 788, height - 274, 212, 212);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    caption: `${model.caption}\n\n${bookingUrl}`,
    title: model.title,
    bookingUrl,
  };
};
