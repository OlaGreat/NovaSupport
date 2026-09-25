import { promisify } from "util";
import { resolve } from "dns";

const resolveAsync = promisify(resolve);

const PRIVATE_IP_RANGES = [
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
      // DNS resolution failure is not a SSRF violation, let it through
      // The actual delivery will fail if the hostname is invalid
    }

    return null;
  } catch (error) {
    return "Invalid URL format";
  }
}
