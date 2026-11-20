import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  isPrivateIp,
  validatePublicUrl,
  validateWebhookUrl,
  type DnsResolvers,
} from "./url-validator.js";

function dnsError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`queryA ${code}`);
  err.code = code;
  return err;
}

/** Fake resolvers: `null` for a family means "no records" (ENODATA). */
function resolvers(records: {
  v4?: string[] | null | NodeJS.ErrnoException;
  v6?: string[] | null | NodeJS.ErrnoException;
}): DnsResolvers & { calls: string[] } {
  const calls: string[] = [];
  const answer = (family: "v4" | "v6", hostname: string) => {
    calls.push(`${family}:${hostname}`);
    const value = records[family];
    if (value instanceof Error) return Promise.reject(value);
    if (value === null || value === undefined) return Promise.reject(dnsError("ENODATA"));
    return Promise.resolve(value);
  };
  return {
    calls,
    resolve4: (hostname) => answer("v4", hostname),
    resolve6: (hostname) => answer("v6", hostname),
  };
}

const validators = [
  ["validateWebhookUrl", validateWebhookUrl],
  ["validatePublicUrl", validatePublicUrl],
] as const;

describe("isPrivateIp", () => {
  test("classifies private and reserved IPv4 addresses", () => {
    for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "224.0.0.1", "255.255.255.255"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });

  test("classifies private and reserved IPv6 addresses across whole ranges", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "FD00::1"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });

  test("treats IPv4-mapped and NAT64 IPv6 addresses by their embedded IPv4", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::192.168.0.1"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
    assert.equal(isPrivateIp("::ffff:808:808"), false);
  });

  test("accepts bracketed URL-style IPv6 literals", () => {
    assert.equal(isPrivateIp("[::1]"), true);
    assert.equal(isPrivateIp("[fd00::1]"), true);
    assert.equal(isPrivateIp("[2606:4700:4700::1111]"), false);
  });

  test("public addresses and hostnames are not private", () => {
    for (const value of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2001:4860:4860::8888", "2606:4700:4700::1111", "example.com", "fc00.example.com"]) {
      assert.equal(isPrivateIp(value), false, value);
    }
  });
});

for (const [name, validate] of validators) {
  describe(`${name} DNS checks (#1520)`, () => {
    test("resolves both A and AAAA records", async () => {
      const dns = resolvers({ v4: ["93.184.216.34"], v6: ["2606:2800:220:1:248:1893:25c8:1946"] });
      assert.equal(await validate("https://example.com/hook", dns), null);
      assert.deepEqual(dns.calls.sort(), ["v4:example.com", "v6:example.com"]);
    });

    test("rejects an IPv6-only hostname pointing at a private target", async () => {
      const dns = resolvers({ v4: null, v6: ["fd00::5"] });
      const error = await validate("https://internal.example.com/", dns);
      assert.match(error ?? "", /private IP/i);
    });

    test("rejects an IPv6-only hostname pointing at loopback", async () => {
      const dns = resolvers({ v4: dnsError("ENOTFOUND"), v6: ["::1"] });
      assert.match((await validate("https://loop.example.com/", dns)) ?? "", /private IP/i);
    });

    test("rejects a dual-stack hostname whose AAAA record is private", async () => {
      const dns = resolvers({ v4: ["93.184.216.34"], v6: ["fe80::1"] });
      assert.match((await validate("https://dual.example.com/", dns)) ?? "", /private IP/i);
    });

    test("rejects a dual-stack hostname whose A record is private", async () => {
      const dns = resolvers({ v4: ["10.0.0.7"], v6: ["2606:4700:4700::1111"] });
      assert.match((await validate("https://dual.example.com/", dns)) ?? "", /private IP/i);
    });

    test("rejects an AAAA record that maps to a private IPv4 address", async () => {
      const dns = resolvers({ v4: null, v6: ["::ffff:169.254.169.254"] });
      assert.match((await validate("https://metadata.example.com/", dns)) ?? "", /private IP/i);
    });

    test("accepts an IPv6-only hostname with a public record", async () => {
      const dns = resolvers({ v4: null, v6: ["2606:4700:4700::1111"] });
      assert.equal(await validate("https://v6only.example.com/", dns), null);
    });

    test("accepts an IPv4-only hostname with a public record", async () => {
      const dns = resolvers({ v4: ["93.184.216.34"], v6: null });
      assert.equal(await validate("https://v4only.example.com/", dns), null);
    });

    test("rejects a hostname with no records in either family", async () => {
      const dns = resolvers({ v4: dnsError("ENOTFOUND"), v6: dnsError("ENOTFOUND") });
      assert.equal(await validate("https://nowhere.example.com/", dns), "URL hostname could not be resolved safely");
    });

    test("rejects when one family's lookup fails for a reason other than no records", async () => {
      // A SERVFAIL on AAAA could be hiding a private record; fail closed.
      const dns = resolvers({ v4: ["93.184.216.34"], v6: dnsError("ESERVFAIL") });
      assert.equal(await validate("https://flaky.example.com/", dns), "URL hostname could not be resolved safely");
    });

    test("rejects IPv6 literals in private ranges without a DNS lookup", async () => {
      for (const url of ["https://[::1]/", "https://[fd00::1]/", "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/"]) {
        const dns = resolvers({});
        assert.match((await validate(url, dns)) ?? "", /private/i, url);
        assert.deepEqual(dns.calls, [], url);
      }
    });

    test("accepts public IP literals without a DNS lookup", async () => {
      for (const url of ["https://8.8.8.8/", "https://[2606:4700:4700::1111]/"]) {
        const dns = resolvers({});
        assert.equal(await validate(url, dns), null, url);
        assert.deepEqual(dns.calls, [], url);
      }
    });

    test("rejects localhost names without trusting DNS", async () => {
      for (const url of ["http://localhost:3000/", "http://api.localhost/"]) {
        const dns = resolvers({ v4: ["93.184.216.34"] });
        assert.match((await validate(url, dns)) ?? "", /private/i, url);
      }
    });
  });
}

describe("validator-specific behaviour is unchanged", () => {
  test("validateWebhookUrl reports malformed URLs", async () => {
    assert.equal(await validateWebhookUrl("not a url", resolvers({})), "Invalid URL format");
  });

  test("validatePublicUrl only allows http and https", async () => {
    assert.equal(await validatePublicUrl("ftp://example.com/", resolvers({ v4: ["93.184.216.34"] })), "Only HTTP and HTTPS URLs are allowed");
  });

  test("validatePublicUrl distinguishes private literals from private resolutions", async () => {
    assert.equal(await validatePublicUrl("https://10.0.0.1/", resolvers({})), "Private IP addresses are not allowed");
    assert.equal(await validatePublicUrl("https://x.example.com/", resolvers({ v6: ["fd00::1"] })), "Hostname resolves to a private IP");
  });
});
