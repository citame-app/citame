import { Resolver } from "node:dns/promises";
import { BlockList, isIPv4 } from "node:net";
import { PermanentProviderError, TransientProviderError } from "./types";

const nonPublic = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  nonPublic.addSubnet(ip, prefix);

const resolver = new Resolver({ timeout: 2000, tries: 2 });

export async function resolvePublicSmtp(
  host: string,
  lookup: (hostname: string) => Promise<string[]> = (hostname) => resolver.resolve4(hostname),
) {
  // Resolve only public IPv4 destinations. The numeric address is passed to the socket so
  // Nodemailer cannot perform a second lookup, and TLS still verifies the configured hostname.
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local"))
    throw new PermanentProviderError("smtp_host_not_public");
  let addresses: string[];
  try {
    addresses = isIPv4(host) ? [host] : await lookup(host);
  } catch {
    throw new TransientProviderError("smtp_host_unresolvable");
  }
  const [address] = addresses;
  if (!address || addresses.some((ip) => !isIPv4(ip) || nonPublic.check(ip)))
    throw new PermanentProviderError("smtp_host_not_public");
  return address;
}
