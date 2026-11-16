import { expect, test } from "bun:test";
import sharp from "sharp";
import { normalizeClientPhoto } from "./photo-image";

test("supported raster formats produce bounded metadata-free JPEG pixels", async () => {
  for (const format of ["jpeg", "png", "webp"] as const) {
    const input = await sharp({
      create: { width: 48, height: 32, channels: 3, background: "#a24c69" },
    })
      .toFormat(format)
      .withMetadata()
      .toBuffer();
    const normalized = await normalizeClientPhoto(input.toString("base64"));
    const meta = await sharp(normalized.image).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(normalized.bytes).toBeLessThanOrEqual(262144);
  }
});
test("fresh pixel encoding discards trailing non-image content", async () => {
  const input = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } })
    .jpeg()
    .toBuffer();
  const result = await normalizeClientPhoto(
    Buffer.concat([input, Buffer.from("<script>untrusted()</script>")]).toString("base64"),
  );
  expect(result.image.includes(Buffer.from("untrusted"))).toBe(false);
});
