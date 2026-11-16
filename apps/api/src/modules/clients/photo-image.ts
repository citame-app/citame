import { CLIENT_PHOTO_INPUT_MAX_BYTES, CLIENT_PHOTO_STORED_MAX_BYTES } from "@sob/contracts";
import sharp from "sharp";
import { DomainError } from "../../errors";

let processing = 0;
/** Decode only bounded raster inputs and store fresh JPEG pixels without their metadata. */
export async function normalizeClientPhoto(base64: string) {
  const input = Buffer.from(base64, "base64");
  const raster =
    input.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (input.subarray(0, 4).toString() === "RIFF" && input.subarray(8, 12).toString() === "WEBP");
  if (!raster || !input.length || input.length > CLIENT_PHOTO_INPUT_MAX_BYTES)
    throw new DomainError("validation_error", "Use a JPEG, PNG or WebP image up to 512 KiB");
  if (processing >= 2)
    throw new DomainError("rate_limited", "Image processing is busy; retry shortly");
  processing++;
  try {
    const options = { limitInputPixels: 16_000_000, failOn: "error" as const };
    const metadata = await sharp(input, options).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) > 1 ||
      !["jpeg", "png", "webp"].includes(metadata.format)
    )
      throw new Error("Unsupported image");
    for (const [size, quality] of [
      [1024, 82],
      [1024, 68],
      [768, 60],
    ] as const) {
      const output = await sharp(input, options)
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, progressive: true })
        .timeout({ seconds: 3 })
        .toBuffer({ resolveWithObject: true });
      if (output.data.byteLength <= CLIENT_PHOTO_STORED_MAX_BYTES)
        return {
          image: output.data,
          width: output.info.width,
          height: output.info.height,
          bytes: output.data.byteLength,
        };
    }
    throw new Error("Normalized image exceeds the storage limit");
  } catch {
    throw new DomainError(
      "validation_error",
      "The image could not be safely decoded within the photo limits",
    );
  } finally {
    processing--;
  }
}
