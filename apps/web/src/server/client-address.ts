/**
 * The visitor's address as this web server sees it. `X-Forwarded-For` is attacker-controlled, so it
 * is only read with `trustProxy` (the web server sits behind an edge proxy that appends to it) and
 * then the LAST entry is used: the address that trusted proxy saw. Otherwise it is the socket peer.
 */
export function visitorAddress(
  request: Request,
  socketAddress: string | null,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const last = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (last) return last;
  }
  return socketAddress;
}
