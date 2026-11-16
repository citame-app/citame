/** Probe the actual listener instead of assuming the image's default port. */
export function webHealthcheckUrl(env: Readonly<Record<string, string | undefined>>): string {
  const port = Number(env.PORT ?? "4173");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid web port");
  const rawHost = env.HOST ?? "0.0.0.0";
  const host =
    rawHost === "0.0.0.0"
      ? "127.0.0.1"
      : rawHost === "::"
        ? "[::1]"
        : rawHost.includes(":") && !rawHost.startsWith("[")
          ? `[${rawHost}]`
          : rawHost;
  const url = new URL(`http://${host}:${port}/healthz`);
  if (url.username || url.password || url.pathname !== "/healthz" || url.search || url.hash)
    throw new Error("Invalid web host");
  return url.toString();
}
if (import.meta.main) {
  try {
    const response = await fetch(webHealthcheckUrl(process.env), {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    process.exit(response.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
