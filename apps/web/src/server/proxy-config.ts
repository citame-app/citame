const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]):/;

/**
 * `WEB_TRUST_PROXY=true` makes the web server believe `X-Forwarded-For`. If the port is also
 * published beyond loopback, anyone can send that header and choose the identity the API
 * rate-limits. Compose passes `WEB_PUBLISH` through so this combination is refused at startup;
 * `WEB_TRUST_PROXY_UNSAFE_OK=true` is for an edge you control on a private network.
 */
export function assertSafeProxyConfig(env: Record<string, string | undefined>): void {
  if (env.WEB_TRUST_PROXY !== "true" || env.WEB_TRUST_PROXY_UNSAFE_OK === "true") return;
  const publish = env.WEB_PUBLISH;
  if (publish && !LOOPBACK.test(publish)) {
    throw new Error(
      `WEB_TRUST_PROXY=true with WEB_PUBLISH=${publish}: the web port is reachable without your proxy, ` +
        "so visitors could spoof X-Forwarded-For. Publish on 127.0.0.1, set WEB_TRUST_PROXY=false, " +
        "or set WEB_TRUST_PROXY_UNSAFE_OK=true if only your proxy can reach this port.",
    );
  }
}
