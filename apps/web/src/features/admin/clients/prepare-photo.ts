import { CLIENT_PHOTO_INPUT_MAX_BYTES } from "@sob/contracts";

/** Reduce camera files locally; the server independently decodes and strips metadata again. */
export async function preparePrivatePhoto(file: File): Promise<string> {
  if (!file.size || file.size > 15 * 1024 * 1024) throw new Error("Photo exceeds the file limit");
  const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature = Array.from(prefix);
  const raster =
    (signature[0] === 255 && signature[1] === 216 && signature[2] === 255) ||
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => signature[i] === value) ||
    (String.fromCharCode(...prefix.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...prefix.slice(8, 12)) === "WEBP");
  if (!raster) throw new Error("Use a raster photo");
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const scale = Math.min(1, 1024 / bitmap.width, 1024 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.68, 0.55]) {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("Image conversion failed"))),
          "image/jpeg",
          quality,
        ),
      );
      if (blob.size > CLIENT_PHOTO_INPUT_MAX_BYTES) continue;
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Image conversion failed"));
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result.slice(reader.result.indexOf(",") + 1))
            : reject(new Error("Image conversion failed"));
        reader.readAsDataURL(blob);
      });
    }
    throw new Error("Image exceeds the upload limit");
  } finally {
    bitmap.close();
  }
}
