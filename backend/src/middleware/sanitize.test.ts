import { describe, it } from "node:test";
import assert from "node:assert";
import type { Request, Response } from "express";
import { sanitizeString, sanitizeObject, sanitizeQuery } from "./sanitize.js";

describe("Sanitization Security Tests", () => {
  describe("XSS Prevention", () => {
    it("should strip script tags from message field", () => {
      const { result, violations } = sanitizeString(
        "message",
        '<script>alert("XSS")</script>Hello',
      );
      assert.strictEqual(result, "Hello");
      assert.ok(violations.some((v) => v.includes("HTML tags removed")));
    });

    it("should strip img tags with onerror from message", () => {
      const { result, violations } = sanitizeString(
        "message",
        '<img src=x onerror="alert(1)">Test',
      );
      assert.strictEqual(result, "Test");
      assert.ok(violations.some((v) => v.includes("HTML tags removed")));
    });

    it("should strip iframe tags from bio", () => {
      const { result, violations } = sanitizeString(
        "bio",
        '<iframe src="evil.com"></iframe>Safe bio',
      );
      assert.strictEqual(result, "Safe bio");
      assert.ok(violations.some((v) => v.includes("HTML tags removed")));
    });

    it("should handle encoded XSS attempts", () => {
      const { result, violations } = sanitizeString(
        "message",
        "&lt;script&gt;alert('XSS')&lt;/script&gt;Text",
      );
      // HTML entities should be decoded and then stripped
      assert.ok(!result.includes("<script>"));
      assert.ok(
        violations.length === 0 || violations.some((v) => v.includes("HTML")),
      );
    });

    it("should strip event handlers from message", () => {
      const { result } = sanitizeString(
        "message",
        '<div onclick="alert(1)">Click me</div>',
      );
      assert.ok(!result.includes("onclick"));
      assert.ok(!result.includes("alert"));
    });

    it("should handle multiple XSS vectors in one message", () => {
      const { result, violations } = sanitizeString(
        "message",
        "<script>alert(1)</script><img src=x onerror=alert(2)><iframe src=evil.com></iframe>Clean text",
      );
      assert.strictEqual(result, "Clean text");
      assert.ok(violations.some((v) => v.includes("HTML tags removed")));
    });
  });

  describe("SQL Injection Prevention", () => {
    it("should preserve SQL-like strings in message (parameterized queries handle this)", () => {
      const { result } = sanitizeString("message", "'; DROP TABLE users; --");
      // Sanitization doesn't need to strip SQL - parameterized queries handle this
      // But it should not contain HTML
      assert.ok(!result.includes("<"));
      assert.ok(!result.includes(">"));
    });

    it("should handle UNION SELECT attempts", () => {
      const { result } = sanitizeString(
        "message",
        "' UNION SELECT * FROM users --",
      );
      assert.ok(typeof result === "string");
      assert.ok(!result.includes("<script>"));
    });

    it("should handle OR 1=1 attempts", () => {
      const { result } = sanitizeString("message", "admin' OR '1'='1");
      assert.ok(typeof result === "string");
      // Should not be modified as long as no HTML
      assert.ok(result.length > 0);
    });

    it("should handle hex-encoded SQL injection", () => {
      const { result } = sanitizeString(
        "message",
        "0x53514C20496E6A656374696F6E",
      );
      assert.ok(typeof result === "string");
    });
  });

  describe("Message Length Validation", () => {
    it("should enforce 280 character limit on message", () => {
      const longMessage = "a".repeat(300);
      const { result, violations } = sanitizeString("message", longMessage);
      assert.strictEqual(result.length, 280);
      assert.ok(violations.some((v) => v.includes("maximum length")));
    });

    it("should allow messages up to 280 characters", () => {
      const validMessage = "a".repeat(280);
      const { result, violations } = sanitizeString("message", validMessage);
      assert.strictEqual(result.length, 280);
      assert.ok(!violations.some((v) => v.includes("maximum length")));
    });

    it("should handle empty messages", () => {
      const { result } = sanitizeString("message", "");
      assert.strictEqual(result, "");
    });

    it("should trim whitespace from messages", () => {
      const { result } = sanitizeString("message", "  Hello World  ");
      assert.strictEqual(result, "Hello World");
    });
  });

  describe("Control Character Prevention", () => {
    it("should remove null bytes from message", () => {
      const { result, violations } = sanitizeString("message", "Hello\0World");
      assert.strictEqual(result, "HelloWorld");
      assert.ok(violations.some((v) => v.includes("Null bytes")));
    });

    it("should remove control characters except newlines", () => {
      const { result, violations } = sanitizeString(
        "message",
        "Hello\x01\x02World\nNew line",
      );
      assert.ok(!result.includes("\x01"));
      assert.ok(!result.includes("\x02"));
      assert.ok(result.includes("\n")); // Newlines allowed in message
      assert.ok(violations.some((v) => v.includes("Control characters")));
    });
  });

  describe("Unicode Normalization", () => {
    it("should normalize Unicode to prevent homograph attacks", () => {
      // Using combining characters that look similar
      const { result, violations } = sanitizeString(
        "message",
        "Café", // é as combining character
      );
      assert.ok(result.includes("é"));
      // Normalization may or may not trigger violation depending on input
    });
  });

  describe("Object Sanitization", () => {
    it("should sanitize nested objects", () => {
      const input = {
        message: '<script>alert("XSS")</script>Hello',
        bio: "<img src=x onerror=alert(1)>Bio",
        nested: {
          description: "<iframe src=evil.com></iframe>Desc",
        },
      };
      const { result, violations } = sanitizeObject(input);
      const sanitized = result as typeof input;

      assert.strictEqual(sanitized.message, "Hello");
      assert.strictEqual(sanitized.bio, "Bio");
      assert.strictEqual(sanitized.nested.description, "Desc");
      assert.ok(violations.length > 0);
    });

    it("should sanitize arrays", () => {
      const input = {
        messages: [
          "<script>alert(1)</script>First",
          "<img src=x onerror=alert(2)>Second",
        ],
      };
      const { result } = sanitizeObject(input);
      const sanitized = result as typeof input;

      assert.ok(!sanitized.messages[0].includes("<script>"));
      assert.ok(!sanitized.messages[1].includes("<img"));
    });
  });

  describe("URL Validation", () => {
    it("should block javascript: protocol URLs", () => {
      const { result, violations } = sanitizeString(
        "websiteUrl",
        "javascript:alert(1)",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("protocol")));
    });

    it("should block data: protocol URLs", () => {
      const { result, violations } = sanitizeString(
        "websiteUrl",
        "data:text/html,<script>alert(1)</script>",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("protocol")));
    });

    it("should allow valid HTTPS URLs", () => {
      const { result, violations } = sanitizeString(
        "websiteUrl",
        "https://example.com",
      );
      assert.strictEqual(result, "https://example.com/");
      assert.ok(!violations.some((v) => v.includes("protocol")));
    });

    it("should block localhost URLs", () => {
      const { result, violations } = sanitizeString(
        "websiteUrl",
        "http://localhost:3000",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("Private/local")));
    });

    it("should block private IP addresses", () => {
      const { result, violations } = sanitizeString(
        "websiteUrl",
        "http://192.168.1.1",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("Private/local")));
    });

    it("should block cloud instance-metadata endpoint (169.254.169.254)", () => {
      const { result, violations } = sanitizeString(
        "websiteUrl",
        "http://169.254.169.254/latest/meta-data",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("Private/local")));
    });

    it("should block link-local addresses in the 169.254.0.0/16 range", () => {
      const { result, violations } = sanitizeString(
        "webhookUrl",
        "http://169.254.1.22/hook",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("Private/local")));
    });

    it("should block IPv6 loopback addresses", () => {
      const { result, violations } = sanitizeString(
        "webhookUrl",
        "https://[::1]/hook",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("Private/local")));
    });

    it("should block IPv6 unique-local (fc00::/7) addresses", () => {
      const { result, violations } = sanitizeString(
        "webhookUrl",
        "http://[fd00::1]/hook",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("Private/local")));
    });

    it("should block IPv4-mapped IPv6 addresses of private ranges", () => {
      const { result, violations } = sanitizeString(
        "webhookUrl",
        "http://[::ffff:127.0.0.1]/hook",
      );
      assert.strictEqual(result, "");
      assert.ok(violations.some((v) => v.includes("Private/local")));
    });

    it("should allow public IPv6 literals", () => {
      const { result, violations } = sanitizeString(
        "websiteUrl",
        "https://[2606:4700:4700::1111]",
      );
      assert.strictEqual(result, "https://[2606:4700:4700::1111]/");
      assert.ok(!violations.some((v) => v.includes("Private/local")));
    });
  });

  describe("Email Validation", () => {
    it("should normalize email to lowercase", () => {
      const { result } = sanitizeString("email", "Test@Example.COM");
      assert.strictEqual(result, "test@example.com");
    });

    it("should detect invalid email format", () => {
      const { violations } = sanitizeString("email", "not-an-email");
      assert.ok(violations.some((v) => v.includes("Invalid email")));
    });

    it("should detect suspicious email patterns", () => {
      const { violations } = sanitizeString("email", "test..user@example.com");
      assert.ok(violations.some((v) => v.includes("suspicious")));
    });
  });

  describe("Social Handle Validation", () => {
    it("should validate Twitter handle format", () => {
      const { result } = sanitizeString("twitterHandle", "@valid_handle");
      assert.strictEqual(result, "valid_handle");
    });

    it("should enforce Twitter handle length limit", () => {
      const { result, violations } = sanitizeString(
        "twitterHandle",
        "this_is_way_too_long_for_twitter",
      );
      assert.ok(result.length <= 15);
      assert.ok(violations.length > 0);
    });

    it("should validate GitHub handle format", () => {
      const { result } = sanitizeString("githubHandle", "valid-handle");
      assert.strictEqual(result, "valid-handle");
    });

    it("should remove invalid characters from GitHub handle", () => {
      const { result, violations } = sanitizeString(
        "githubHandle",
        "invalid@handle!",
      );
      assert.ok(!result.includes("@"));
      assert.ok(!result.includes("!"));
      assert.ok(violations.length > 0);
    });
  });
});

describe("name field length cap (#1521)", () => {
  it("caps name at the same 64 characters as displayName", () => {
    const long = "a".repeat(100);
    const name = sanitizeString("name", long);
    const displayName = sanitizeString("displayName", long);
    assert.strictEqual(name.result.length, 64);
    assert.strictEqual(name.result, displayName.result);
    assert.ok(name.violations.some((v) => v.includes("maximum length of 64")));
  });

  it("leaves a name at exactly the cap untouched", () => {
    const exact = "b".repeat(64);
    const { result, violations } = sanitizeString("name", exact);
    assert.strictEqual(result, exact);
    assert.deepStrictEqual(violations, []);
  });

  it("still strips HTML from name", () => {
    const { result } = sanitizeString("name", "<b>Ada</b> Lovelace");
    assert.strictEqual(result, "Ada Lovelace");
  });

  it("caps a nested name field in a request body", () => {
    const { result } = sanitizeObject({ team: { name: "x".repeat(500) } });
    assert.strictEqual((result as { team: { name: string } }).team.name.length, 64);
  });
});

describe("sanitizeQuery array values (#1523)", () => {
  function runQuery(query: Record<string, unknown>): Record<string, unknown> {
    const req = {
      query,
      method: "GET",
      path: "/test",
      ip: "127.0.0.1",
      get: () => undefined,
    } as unknown as Request;
    let nextCalled = false;
    sanitizeQuery(req, {} as Response, () => {
      nextCalled = true;
    });
    assert.ok(nextCalled, "next() must be called");
    return req.query as Record<string, unknown>;
  }

  it("strips HTML from items of an unknown array parameter", () => {
    const query = runQuery({ tag: ["<script>alert(1)</script>safe", "<b>bold</b>"] });
    assert.deepStrictEqual(query.tag, ["safe", "bold"]);
  });

  it("applies the field's own rules to a known array parameter", () => {
    const query = runQuery({ username: ["  MixedCase  ", "x".repeat(40)] });
    const [lowered, capped] = query.username as string[];
    assert.strictEqual(lowered, "mixedcase");
    assert.strictEqual(capped.length, 32);
  });

  it("caps a repeated name parameter like a single one", () => {
    const query = runQuery({ name: ["n".repeat(100)] });
    assert.strictEqual((query.name as string[])[0].length, 64);
  });

  it("validates URL items of a repeated url parameter", () => {
    const query = runQuery({ url: ["javascript:alert(1)", "example.com"] });
    assert.deepStrictEqual(query.url, ["", "https://example.com/"]);
  });

  it("validates social handle items", () => {
    const query = runQuery({ twitterHandle: ["@valid_handle"] });
    assert.deepStrictEqual(query.twitterHandle, ["valid_handle"]);
  });

  it("treats array items the same way as a single value of the same key", () => {
    const single = runQuery({ bio: "<img src=x onerror=alert(1)>hi" });
    const repeated = runQuery({ bio: ["<img src=x onerror=alert(1)>hi"] });
    assert.deepStrictEqual(repeated.bio, [single.bio]);
  });

  it("leaves non-string array items and clean values unchanged", () => {
    const nested = { inner: "value" };
    const query = runQuery({ page: "2", ids: ["a", nested] });
    assert.strictEqual(query.page, "2");
    assert.deepStrictEqual(query.ids, ["a", nested]);
  });
});
