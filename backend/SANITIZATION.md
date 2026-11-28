# Input Sanitization Middleware

This document describes the comprehensive input sanitization middleware implemented to prevent XSS attacks and ensure data integrity across the NovaSupport backend.

## Overview

The sanitization middleware automatically processes all incoming requests to:
- Strip malicious HTML/JavaScript content
- Normalize and validate URLs
- Validate social media handles
- Enforce field length limits
- Remove control characters
- Normalize Unicode
- Log security violations for monitoring

## Features

### 1. HTML/XSS Prevention
- Strips all HTML tags from user content fields
- Prevents script injection attacks
- Handles complex XSS vectors (SVG, iframe, data URIs, etc.)
- Preserves text content while removing dangerous markup

### 2. URL Validation & Normalization
- Automatically adds HTTPS protocol to bare domains
- Blocks non-HTTP/HTTPS protocols (ftp, javascript, data, etc.)
- Prevents access to private/local IP addresses
- Blocks suspicious TLDs (.tk, .ml, .ga, .cf)
- Validates URL format and length

### 3. Social Handle Validation
- **Twitter**: 1-15 characters, alphanumeric + underscore, removes @ prefix
- **GitHub**: 1-39 characters, alphanumeric + hyphens (not at start/end)
- **Generic**: Alphanumeric + dots, underscores, hyphens

### 4. Email Validation
- Normalizes to lowercase
- Basic format validation
- Blocks temporary email domains
- Detects suspicious patterns (double dots, etc.)

### 5. Security Features
- Removes null bytes and control characters
- Unicode normalization (prevents homograph attacks)
- Field-specific length limits
- Comprehensive logging of violations

## Field Categories

### HTML Content Fields (XSS Protection)
```typescript
bio, message, memo, details, description, displayName, title, name, username
```

### URL Fields (Validation & Normalization)
```typescript
websiteUrl, avatarUrl, webhookUrl, url
```

### Social Handle Fields (Platform-Specific Validation)
```typescript
twitterHandle, githubHandle
```

### Email Fields (Format & Security Validation)
```typescript
email
```

### Lowercase Fields (Case Normalization)
```typescript
username, email
```

## Length Limits

| Field Type | Max Length | Description |
|------------|------------|-------------|
| bio | 280 | User biography |
| message | 280 | Support messages (Twitter-like) |
| description | 1000 | General descriptions |
| displayName | 64 | Display names |
| name | 64 | Names (same cap as displayName) |
| title | 200 | Titles and headings |
| username | 32 | Usernames |
| twitterHandle | 15 | Twitter handle limit |
| githubHandle | 39 | GitHub handle limit |
| url | 2048 | URL length limit |

### Array values

String items of an array get the rules of the field that holds the array, in
request bodies and in query strings alike (`?tag=a&tag=b`, `?tag[]=a`). An
array under an unknown field name falls back to the `message` rules, so its
items are still HTML-stripped.

## Usage

The middleware is automatically applied to all requests:

```typescript
// Applied globally in app.ts
app.use(sanitizeBody);    // Sanitizes request body
app.use(sanitizeQuery);   // Sanitizes query parameters
```

### Manual Sanitization

You can also use the sanitization functions directly:

```typescript
import { sanitizeString, sanitizeObject } from './middleware/sanitize.js';

// Sanitize a single field
const { result, changed, violations } = sanitizeString('bio', userInput);

// Sanitize an entire object
const { result, changed, violations } = sanitizeObject(requestData);
```

## Security Logging

The middleware logs all sanitization activities:

### Info Level (Normal Operations)
```json
{
  "level": "info",
  "msg": "Request body sanitized",
  "method": "POST",
  "path": "/profiles",
  "ip": "192.168.1.100",
  "violations": ["bio: HTML tags removed for security"]
}
```

### Warning Level (Security Violations)
```json
{
  "level": "warn", 
  "msg": "Input sanitization violations detected",
  "method": "POST",
  "path": "/profiles",
  "violations": [
    "bio: HTML tags removed for security",
    "websiteUrl: Private/local URLs are not allowed"
  ],
  "ip": "192.168.1.100",
  "userAgent": "Mozilla/5.0..."
}
```

## Examples

### XSS Prevention
```typescript
// Input
{ bio: "<script>alert('xss')</script>Hello World" }

// Output
{ bio: "Hello World" }
// Violation: "bio: HTML tags removed for security"
```

### URL Normalization
```typescript
// Input
{ websiteUrl: "example.com" }

// Output  
{ websiteUrl: "https://example.com/" }
```

### Social Handle Validation
```typescript
// Input
{ twitterHandle: "@john_doe!" }

// Output
{ twitterHandle: "john_doe" }
// Violation: "twitterHandle: Twitter handle must be 1-15 characters, letters, numbers, and underscores only"
```

### Blocked URLs
```typescript
// Input
{ websiteUrl: "javascript:alert(1)" }

// Output
{ websiteUrl: "" }
// Violation: "websiteUrl: Only HTTP and HTTPS protocols are allowed"
```

## Testing

Run the sanitization tests:

```bash
cd backend
npx tsx src/middleware/sanitize.test.ts
```

The test suite covers:
- HTML/XSS prevention (16 test vectors)
- URL validation and normalization
- Social handle validation
- Email validation
- Length limit enforcement
- Control character removal
- Unicode normalization
- Middleware integration
- Nested object sanitization

## Security Considerations

1. **Defense in Depth**: Sanitization is the first line of defense, but should be combined with:
   - Content Security Policy (CSP) headers
   - Output encoding in templates
   - Parameterized database queries

2. **Monitoring**: Security violations are logged for monitoring and alerting

3. **Performance**: Sanitization adds minimal overhead but processes all requests

4. **Bypass Prevention**: Middleware is applied globally and cannot be easily bypassed

## Future Enhancements

- Rate limiting based on violation frequency
- Machine learning-based anomaly detection
- Integration with external threat intelligence
- Custom sanitization rules per endpoint
- Sanitization bypass for trusted sources
