import type { Request, Response, NextFunction } from "express";
import sanitizeHtml from "sanitize-html";
import { BlockList, isIP } from "node:net";
import { logger } from "../logger.js";

const PRIVATE_IP_RANGES = new BlockList();
PRIVATE_IP_RANGES.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_IP_RANGES.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_IP_RANGES.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_IP_RANGES.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_IP_RANGES.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_IP_RANGES.addSubnet("::1", 128, "ipv6");
PRIVATE_IP_RANGES.addSubnet("::", 128, "ipv6");
PRIVATE_IP_RANGES.addSubnet("fc00::", 7, "ipv6");
PRIVATE_IP_RANGES.addSubnet("fe80::", 10, "ipv6");

function isPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;

  const address = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 0) return false;

  if (family === 6) {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return PRIVATE_IP_RANGES.check(mapped[1], "ipv4");
  }

  return PRIVATE_IP_RANGES.check(address, family === 4 ? "ipv4" : "ipv6");
}

const STRIP_ALL_HTML: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
};

// Enhanced HTML sanitization options for rich text (if needed in future)
const SAFE_HTML: sanitizeHtml.IOptions = {
  allowedTags: ["b", "i", "em", "strong", "p", "br"],
  allowedAttributes: {},
  allowedSchemes: [],
};

// Free-text user content fields where HTML should be stripped to prevent stored XSS
const HTML_CONTENT_FIELDS = new Set([
  "bio",
  "message",
  "description",
  "displayName",
  "title",
  "name",
  "text",
  "content",
  "notes",
  "username",
  "tags_item", // For array items in query params
  "tags", // For direct tags field
]);

// URL fields that should be normalized and validated
const URL_FIELDS = new Set([
  "websiteUrl",
  "avatarUrl",
  "webhookUrl",
  "url",
  "link",
]);

// Social handle fields that need special validation
const SOCIAL_HANDLE_FIELDS = new Set([
  "twitterHandle",
  "githubHandle",
  "linkedinHandle",
  "discordHandle",
]);

// Email fields that need validation
const EMAIL_FIELDS = new Set([
  "email",
  "contactEmail",
  "notificationEmail",
]);

// Fields that should be converted to lowercase
const LOWERCASE_FIELDS = new Set([
  "username",
  "email",
  "contactEmail",
  "notificationEmail",
]);

// Maximum lengths for different field types
const MAX_LENGTHS = {
  bio: 280,
  message: 280,
  description: 1000,
  displayName: 64,
  title: 200,
  username: 32,
  twitterHandle: 15,
  githubHandle: 39,
  url: 2048,
} as const;

interface SanitizationResult {
  result: string;
  changed: boolean;
  violations: string[];
}

function normalizeUrl(value: string): { url: string | null; violations: string[] } {
  const violations: string[] = [];
  
  if (!value || value.length === 0) {
    return { url: null, violations };
  }

  // Check length
  if (value.length > MAX_LENGTHS.url) {
    violations.push(`URL too long (max ${MAX_LENGTHS.url} characters)`);
    return { url: null, violations };
  }

  try {
    // Add protocol if missing, but validate the original format first
    let urlString = value;

    // Block non-http(s) schemes that may not contain "://" (e.g. javascript:, data:)
    const colonIdx = value.indexOf(":");
    if (colonIdx !== -1) {
      const scheme = value.slice(0, colonIdx).toLowerCase().trim();
      if (scheme !== "http" && scheme !== "https" && !/^\s*$/.test(scheme)) {
        violations.push("Only HTTP and HTTPS protocols are allowed");
        return { url: null, violations };
      }
    }

    // Check for invalid protocols in the original string
    if (value.includes("://")) {
      const protocol = value.split("://")[0].toLowerCase();
      if (!["http", "https"].includes(protocol)) {
        violations.push("Only HTTP and HTTPS protocols are allowed");
        return { url: null, violations };
      }
    } else if (colonIdx === -1) {
      // Add https if no protocol
      urlString = `https://${urlString}`;
    }

    const url = new URL(urlString);
    
    // Double-check protocol after URL parsing
    if (!["http:", "https:"].includes(url.protocol)) {
      violations.push("Only HTTP and HTTPS protocols are allowed");
      return { url: null, violations };
    }

    // Block localhost and private IPs for security
    const hostname = url.hostname.toLowerCase();
    if (isPrivateHostname(hostname)) {
      violations.push("Private/local URLs are not allowed");
      return { url: null, violations };
    }

    // Block suspicious TLDs
    const suspiciousTlds = [".tk", ".ml", ".ga", ".cf"];
    if (suspiciousTlds.some(tld => hostname.endsWith(tld))) {
      violations.push("Suspicious domain detected");
      return { url: null, violations };
    }

    // Always return the canonical href (with trailing slash for bare origins).
    return { url: url.href, violations };
  } catch (error) {
    violations.push("Invalid URL format");
    return { url: null, violations };
  }
}

function sanitizeSocialHandle(platform: string, handle: string): SanitizationResult {
  const violations: string[] = [];
  let result = handle.trim();

  if (!result) {
    return { result: "", changed: handle !== result, violations };
  }

  // Remove @ symbol if present
  if (result.startsWith("@")) {
    result = result.slice(1);
  }

  // Platform-specific validation
  switch (platform) {
    case "twitterHandle":
      // Twitter handles: 1-15 characters, alphanumeric + underscore
      if (!/^[a-zA-Z0-9_]{1,15}$/.test(result)) {
        violations.push("Twitter handle must be 1-15 characters, letters, numbers, and underscores only");
        result = result.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 15);
      }
      break;
      
    case "githubHandle":
      // GitHub handles: 1-39 characters, alphanumeric + hyphens + dots, can't start/end with hyphen or dot
      if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,37}[a-zA-Z0-9])?$/.test(result)) {
        violations.push("GitHub handle must be 1-39 characters, letters, numbers, hyphens, or dots (not at start/end)");
        result = result.replace(/[^a-zA-Z0-9.-]/g, "").slice(0, 39);
        // Remove leading/trailing hyphens or dots
        result = result.replace(/^[-.]+|[-.]+$/g, "");
      }
      break;
      
    default:
      // Generic social handle validation
      if (!/^[a-zA-Z0-9._-]{1,50}$/.test(result)) {
        violations.push("Social handle contains invalid characters");
        result = result.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 50);
      }
  }

  return {
    result,
    changed: result !== handle,
    violations,
  };
}

function validateEmail(email: string): SanitizationResult {
  const violations: string[] = [];
  let result = email.trim().toLowerCase();

  if (!result) {
    return { result: "", changed: email !== result, violations };
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(result)) {
    violations.push("Invalid email format");
  }

  // Check for suspicious patterns
  if (result.includes("..") || result.startsWith(".") || result.endsWith(".")) {
    violations.push("Email contains suspicious patterns");
  }

  // Block temporary email domains (basic list)
  const tempDomains = ["10minutemail.com", "tempmail.org", "guerrillamail.com"];
  const domain = result.split("@")[1];
  if (tempDomains.includes(domain)) {
    violations.push("Temporary email addresses are not allowed");
  }

  return {
    result,
    changed: result !== email,
    violations,
  };
}

export function sanitizeString(
  key: string,
  value: string,
): SanitizationResult {
  const original = value;
  const violations: string[] = [];
  let result = value;

  // Always trim whitespace first
  result = result.trim();

  // Apply lowercase transformation if needed
  if (LOWERCASE_FIELDS.has(key)) {
    result = result.toLowerCase();
  }

  // Check maximum length
  const maxLength = MAX_LENGTHS[key as keyof typeof MAX_LENGTHS];
  if (maxLength && result.length > maxLength) {
    violations.push(`Field exceeds maximum length of ${maxLength} characters`);
    result = result.slice(0, maxLength);
  }

  // HTML sanitization for content fields
  if (HTML_CONTENT_FIELDS.has(key)) {
    const stripped = sanitizeHtml(result, STRIP_ALL_HTML);
    if (stripped !== result) {
      violations.push("HTML tags removed for security");
      result = stripped;
    }
  }

  // URL validation and normalization
  if (URL_FIELDS.has(key) && result.length > 0) {
    const { url, violations: urlViolations } = normalizeUrl(result);
    violations.push(...urlViolations);
    if (url !== null) {
      result = url;
    } else if (urlViolations.length > 0) {
      result = ""; // Clear invalid URLs
    }
  }

  // Social handle validation
  if (SOCIAL_HANDLE_FIELDS.has(key) && result.length > 0) {
    const { result: sanitizedHandle, violations: handleViolations } = sanitizeSocialHandle(key, result);
    violations.push(...handleViolations);
    result = sanitizedHandle;
  }

  // Email validation
  if (EMAIL_FIELDS.has(key) && result.length > 0) {
    const { result: sanitizedEmail, violations: emailViolations } = validateEmail(result);
    violations.push(...emailViolations);
    result = sanitizedEmail;
  }

  // Additional security checks
  if (result.length > 0) {
    // Check for null bytes
    if (result.includes("\0")) {
      violations.push("Null bytes removed");
      result = result.replace(/\0/g, "");
    }

    // Check for control characters (except newlines and tabs for some fields)
    const allowNewlines = ["bio", "message", "description", "content"].includes(key);
    const controlCharRegex = allowNewlines ? /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g : /[\x00-\x08\x0B-\x1F\x7F]/g;
    if (controlCharRegex.test(result)) {
      violations.push("Control characters removed");
      result = result.replace(controlCharRegex, "");
    }

    // Normalize Unicode (prevent homograph attacks)
    const normalized = result.normalize("NFC");
    if (normalized !== result) {
      violations.push("Unicode normalized");
      result = normalized;
    }
  }

  return {
    result,
    changed: result !== original,
    violations,
  };
}

export function sanitizeObject(
  obj: unknown,
  depth = 0,
): { result: unknown; changed: boolean; violations: string[] } {
  const allViolations: string[] = [];

  if (depth > 10 || obj === null || obj === undefined) {
    return { result: obj, changed: false, violations: allViolations };
  }

  if (Array.isArray(obj)) {
    let changed = false;
    const result = obj.map((item, index) => {
      if (typeof item === "string") {
        // Use a generic key so HTML sanitization still applies
        const { result: r, changed: c, violations } = sanitizeString("message", item);
        if (c) changed = true;
        allViolations.push(...violations.map(v => `[${index}] ${v}`));
        return r;
      }
      const { result: r, changed: c, violations } = sanitizeObject(item, depth + 1);
      if (c) changed = true;
      allViolations.push(...violations.map(v => `[${index}] ${v}`));
      return r;
    });
    return { result, changed, violations: allViolations };
  }

  if (typeof obj === "object") {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof value === "string") {
        const { result: r, changed: c, violations } = sanitizeString(key, value);
        if (c) changed = true;
        allViolations.push(...violations.map(v => `${key}: ${v}`));
        result[key] = r;
      } else {
        const { result: r, changed: c, violations } = sanitizeObject(value, depth + 1);
        if (c) changed = true;
        allViolations.push(...violations.map(v => `${key}.${v}`));
        result[key] = r;
      }
    }
    return { result, changed, violations: allViolations };
  }

  return { result: obj, changed: false, violations: allViolations };
}

export function sanitizeBody(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.body && typeof req.body === "object") {
    const { result, changed, violations } = sanitizeObject(
      req.body as Record<string, unknown>,
    );
    
    if (changed) {
      logger.info(
        { 
          method: req.method, 
          path: req.path,
          violations: violations.length > 0 ? violations : undefined,
          ip: req.ip,
        },
        "Request body sanitized",
      );
      req.body = result;
    }

    // Log security violations separately for monitoring
    if (violations.length > 0) {
      logger.warn(
        {
          method: req.method,
          path: req.path,
          violations,
          ip: req.ip,
          userAgent: req.get("User-Agent"),
        },
        "Input sanitization violations detected",
      );
    }
  }
  next();
}

export function sanitizeQuery(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.query || typeof req.query !== "object") return next();

  let changed = false;
  const violations: string[] = [];
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") {
      const { result, changed: fieldChanged, violations: fieldViolations } = sanitizeString(key, value);
      sanitized[key] = result;
      if (fieldChanged) changed = true;
      violations.push(...fieldViolations.map(v => `${key}: ${v}`));
    } else if (Array.isArray(value)) {
      const sanitizedArray: unknown[] = [];
      value.forEach((v, index) => {
        if (typeof v === "string") {
          const { result, changed: itemChanged, violations: itemViolations } = sanitizeString(`${key}_item`, v);
          sanitizedArray.push(result);
          if (itemChanged) changed = true;
          violations.push(...itemViolations.map(viol => `${key}[${index}]: ${viol}`));
        } else {
          sanitizedArray.push(v);
        }
      });
      sanitized[key] = sanitizedArray;
    } else {
      sanitized[key] = value;
    }
  }

  if (changed) {
    logger.info(
      { 
        method: req.method, 
        path: req.path,
        violations: violations.length > 0 ? violations : undefined,
        ip: req.ip,
      },
      "Query parameters sanitized",
    );
    req.query = sanitized as typeof req.query;
  }

  // Log security violations
  if (violations.length > 0) {
    logger.warn(
      {
        method: req.method,
        path: req.path,
        violations,
        ip: req.ip,
        userAgent: req.get("User-Agent"),
      },
      "Query parameter sanitization violations detected",
    );
  }

  next();
}
