/** Local rendering only; no link or visitor data is sent to a QR service. */
export async function generateBookingQr(url: string): Promise<string> {
  const qr = await import("qrcode");
  return qr.toDataURL(url, {
    width: 512,
    margin: 4,
    errorCorrectionLevel: "Q",
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
}
