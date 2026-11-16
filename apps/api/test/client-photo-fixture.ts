import sharp from "sharp";

/** Generated test pixels with synthetic EXIF. No real person, location or customer data. */
export async function clientPhotoFixture() {
  return sharp({ create: { width: 640, height: 400, channels: 3, background: "#a24c69" } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: "Synthetic private fixture" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" },
    })
    .toBuffer();
}
