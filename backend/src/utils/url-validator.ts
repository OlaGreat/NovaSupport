import { promisify } from "util";
import { resolve } from "dns";

const resolveAsync = promisify(resolve);

const PRIVATE_IP_RANGES = [
  /^0\./, // "this network" / unspecified (0.0.0.0)
  /^127\./, // loopback
  /^10\./, // private
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // private
  /^192\.168\./, // private
  /^169\.254\./, // link-local
  /^224\./, // multicast
  /^255\./, // broadcast
  /^::1$/, // IPv6 loopback
  /^fe80:/, // IPv6 link-local
  /^fc00:/, // IPv6 unique local
  /^ff00:/, // IPv6 multicast
  /^::ffff:0\./, // IPv6 "this network" mapped
  /^::ffff:127\./, // IPv6 loopback mapped
  /^::ffff:10\./, // IPv6 private mapped
  /^::ffff:172\.(1[6-9]|2[0-9]|3[01])\./, // IPv6 private mapped
  /^::ffff:192\.168\./, // IPv6 private mapped
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_RANGES.some(pattern => pattern.test(ip));
}

export async function validateWebhookUrl(url: string): Promise<string | null> {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    if (!hostname) return "Invalid URL hostname";

    if (isPrivateIp(hostname)) {
      return `Hostname resolves to private IP: ${hostname}`;
    }

    // Resolve hostname and check if any resolved IP is private
    try {
      const addresses = await resolveAsync(hostname);
      for (const ip of addresses) {
        if (isPrivateIp(ip)) {
          return `Hostname resolves to private IP: ${ip}`;
        }
      }
    } catch (dnsError) {
      // A DNS failure means we cannot prove the host is public, so reject the
      // URL instead of letting it through unchecked (#1519). This matches the
      // stricter behavior of validatePublicUrl below.
      return "URL hostname could not be resolved safely";
    }

    return null;
  } catch (error) {
    return "Invalid URL format";
  }
}

export async function validatePublicUrl(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Only HTTP and HTTPS URLs are allowed";
    }
    if (!parsed.hostname) return "Invalid URL hostname";
    if (isPrivateIp(parsed.hostname)) return "Private IP addresses are not allowed";
    const addresses = await resolveAsync(parsed.hostname);
    if (addresses.some(isPrivateIp)) return "Hostname resolves to a private IP";
    return null;
  } catch {
    return "URL hostname could not be resolved safely";
  }
}
