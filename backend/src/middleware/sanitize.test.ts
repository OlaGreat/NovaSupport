import { describe, it } from "node:test";
import assert from "node:assert";
import { sanitizeString, sanitizeObject } from "./sanitize.js";

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
