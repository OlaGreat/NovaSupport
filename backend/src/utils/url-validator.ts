import { BlockList, isIP } from "node:net";
import { promises as dnsPromises } from "node:dns";

/**
 * Address ranges an outbound request must never reach. Both families are
 * covered: a hostname is only safe when every A *and* AAAA record it resolves
 * to is public (#1520).
 */
const BLOCKED_RANGES = new BlockList();
// IPv4
BLOCKED_RANGES.addSubnet("0.0.0.0", 8, "ipv4"); // "this network" / unspecified
BLOCKED_RANGES.addSubnet("10.0.0.0", 8, "ipv4"); // private
BLOCKED_RANGES.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT
BLOCKED_RANGES.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
BLOCKED_RANGES.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (cloud metadata)
BLOCKED_RANGES.addSubnet("172.16.0.0", 12, "ipv4"); // private
BLOCKED_RANGES.addSubnet("192.168.0.0", 16, "ipv4"); // private
BLOCKED_RANGES.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
BLOCKED_RANGES.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, incl. 255.255.255.255 broadcast
// IPv6
BLOCKED_RANGES.addAddress("::", "ipv6"); // unspecified
BLOCKED_RANGES.addAddress("::1", "ipv6"); // loopback
BLOCKED_RANGES.addSubnet("fc00::", 7, "ipv6"); // unique local (fc00::/7, incl. fd00::/8)
BLOCKED_RANGES.addSubnet("fe80::", 10, "ipv6"); // link-local
BLOCKED_RANGES.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local
BLOCKED_RANGES.addSubnet("ff00::", 8, "ipv6"); // multicast

/**
 * IPv6 forms that embed an IPv4 address. The embedded address is checked
 * against the IPv4 ranges, so e.g. `::ffff:127.0.0.1` and `::ffff:7f00:1`
 * are both treated as loopback.
 */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return null;
}

/**
 * True when `address` is an IP literal (IPv4 or IPv6, optionally bracketed as
 * in a URL hostname) inside a blocked range. Hostnames return false; they are
 * checked through DNS resolution instead.
 */
export function isPrivateIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family === 4) return BLOCKED_RANGES.check(ip, "ipv4");
  if (family === 6) {
    const mapped = embeddedIpv4(ip);
    if (mapped !== null && isIP(mapped) === 4) return BLOCKED_RANGES.check(mapped, "ipv4");
    return BLOCKED_RANGES.check(ip, "ipv6");
  }
  return false;
}

export interface DnsResolvers {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
}

const systemResolvers: DnsResolvers = {
  resolve4: (hostname) => dnsPromises.resolve4(hostname),
  resolve6: (hostname) => dnsPromises.resolve6(hostname),
};

/** DNS answers that mean "this family has no records", not a failed lookup. */
const NO_RECORDS_CODES = new Set(["ENODATA", "ENOTFOUND"]);

type Resolution =
  | { ok: true; addresses: string[] }
  | { ok: false };

/**
 * Resolves both A and AAAA records. A family with no records is fine; any
 * other lookup error, or no records in either family, means the host cannot
 * be proven public and is treated as unresolvable.
 */
async function resolveAllAddresses(
  hostname: string,
  resolvers: DnsResolvers,
): Promise<Resolution> {
  const lookups = await Promise.allSettled([
    resolvers.resolve4(hostname),
    resolvers.resolve6(hostname),
  ]);
  const addresses: string[] = [];
  for (const lookup of lookups) {
    if (lookup.status === "fulfilled") {
      addresses.push(...lookup.value);
      continue;
    }
    const code = (lookup.reason as NodeJS.ErrnoException | undefined)?.code;
    if (!code || !NO_RECORDS_CODES.has(code)) return { ok: false };
  }
  if (addresses.length === 0) return { ok: false };
  return { ok: true, addresses };
}

/**
 * Hostname check shared by both validators: an IP literal is checked
 * directly, a name is resolved over both families and every record checked.
 */
async function checkHost(
  hostname: string,
  resolvers: DnsResolvers,
): Promise<{ kind: "ok" } | { kind: "private"; ip: string } | { kind: "unresolvable" }> {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return { kind: "private", ip: hostname };
  }
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) {
    return isPrivateIp(hostname) ? { kind: "private", ip: hostname } : { kind: "ok" };
  }
  const resolution = await resolveAllAddresses(hostname, resolvers);
  if (!resolution.ok) return { kind: "unresolvable" };
  const privateIp = resolution.addresses.find(isPrivateIp);
  return privateIp ? { kind: "private", ip: privateIp } : { kind: "ok" };
}

export async function validateWebhookUrl(
  url: string,
  resolvers: DnsResolvers = systemResolvers,
): Promise<string | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return "Invalid URL format";
  }
  if (!hostname) return "Invalid URL hostname";

  const result = await checkHost(hostname, resolvers);
  if (result.kind === "private") return `Hostname resolves to private IP: ${result.ip}`;
  // A DNS failure means we cannot prove the host is public, so reject the URL
  // instead of letting it through unchecked (#1519).
  if (result.kind === "unresolvable") return "URL hostname could not be resolved safely";
  return null;
}

export async function validatePublicUrl(
  url: string,
  resolvers: DnsResolvers = systemResolvers,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL hostname could not be resolved safely";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Only HTTP and HTTPS URLs are allowed";
  }
  if (!parsed.hostname) return "Invalid URL hostname";

  const result = await checkHost(parsed.hostname, resolvers);
  if (result.kind === "private") {
    return isIP(parsed.hostname.replace(/^\[|\]$/g, "")) !== 0
      ? "Private IP addresses are not allowed"
      : "Hostname resolves to a private IP";
  }
  if (result.kind === "unresolvable") return "URL hostname could not be resolved safely";
  return null;
}
