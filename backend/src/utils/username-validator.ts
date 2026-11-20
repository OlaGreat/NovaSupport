/**
 * Username validation and suggestions engine
 * Ensures usernames are safe, unique, and comply with platform policies
 */

// Reserved words that cannot be used as usernames
const RESERVED_WORDS = new Set([
  "admin",
  "api",
  "support",
  "system",
  "moderator",
  "root",
  "app",
  "dashboard",
  "profile",
  "create",
  "explore",
  "settings",
  "wallet",
  "transactions",
  "analytics",
  "webhook",
  "callback",
  "notify",
  "payment",
  "sponsor",
  "sponsor-page",
  "about",
  "contact",
  "help",
  "terms",
  "privacy",
  "tos",
  "admin-panel",
  "docs",
  "api-docs",
  "health",
  "status",
  "login",
  "logout",
  "auth",
  "verify",
  "unsubscribe",
  "billing",
  "upgrade",
  "downgrade",
  "import",
  "export",
  "archive",
  "delete",
  "restore",
  "report",
  "appeal",
  "block",
  "unblock",
  "flag",
  "moderate",
  "ban",
  "mute",
  "bot",
  "test",
  "dev",
  "staging",
  "production",
]);

// Common profanity and inappropriate words (basic filter)
// This list includes common offensive words and their variations
const PROFANITY_FILTER =
  /\b(ass|asshole|bitch|bitches|crap|damn|dammit|dammits|damn|fart|farts|farted|farthed|farthing|farting|farts|fuck|fucks|fucked|fucker|fuckers|fuckin|fucking|fuckings|gag|gags|gagged|gagging|god|goddam|goddamn|goddamned|goddamner|goddamners|goddamning|goddamns|goddamner|goddamners|goddamning|goddamns|godsdamn|godsake|hell|hells|hitter|hitters|horseshit|horseshits|jackass|jackasses|jerk|jerks|jerked|jerking|jerkings|jerks|motherfucker|motherfuckers|motherfucking|motherfuckings|piss|pissed|pisser|pissers|pisses|pissing|pissy|shit|shits|shitted|shitter|shitters|shitting|shittings|shitty|whore|whores|whored|whoring|suck|sucks|sucked|sucker|suckers|sucking|suckings|tit|tits|titted|titting|tittings|tittish|titty)\b/i;

/**
 * Patterns that look confusing:
 * l (lowercase L) vs 1 (number one)
 * o (lowercase o) vs 0 (zero)
 * Note: Uppercase O is not checked since the format check ensures lowercase-only
 */
const CONFUSING_PATTERNS = /[l01o]{3,}/;

/**
 * Check if a username is valid
 */
export function isValidUsername(username: string): {
  valid: boolean;
  error?: string;
} {
  // Check length (3-32 characters)
  if (username.length < 3) {
    return { valid: false, error: "Username must be at least 3 characters" };
  }

  if (username.length > 32) {
    return { valid: false, error: "Username must be at most 32 characters" };
  }

  // Check format (lowercase alphanumeric and hyphens, no leading/trailing hyphens, no consecutive hyphens)
  const validFormat = /^[a-z0-9]([a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;
  if (!validFormat.test(username)) {
    return {
      valid: false,
      error:
        "Username must contain only lowercase letters, numbers, and hyphens (no leading/trailing hyphens or consecutive hyphens)",
    };
  }

  return { valid: true };
}

/**
 * Check if a username is reserved
 */
export function isReservedUsername(username: string): boolean {
  return RESERVED_WORDS.has(username.toLowerCase());
}

/**
 * Check if a username contains profanity
 */
export function containsProfanity(username: string): boolean {
  return PROFANITY_FILTER.test(username);
}

/**
 * Check if a username contains confusing character patterns
 */
export function hasConfusingPatterns(username: string): boolean {
  return CONFUSING_PATTERNS.test(username);
}

/**
 * Comprehensive username validation
 */
export function validateUsername(username: string): {
  valid: boolean;
  error?: string;
  suggestions?: string[];
} {
  // Basic format validation
  const formatCheck = isValidUsername(username);
  if (!formatCheck.valid) {
    return { valid: false, error: formatCheck.error };
  }

  // Check reserved words
  if (isReservedUsername(username)) {
    const suggestions = generateSuggestions(username);
    return {
      valid: false,
      error: `Username "${username}" is reserved and cannot be used`,
      suggestions,
    };
  }

  // Check profanity
  if (containsProfanity(username)) {
    const suggestions = generateSuggestions(username);
    return {
      valid: false,
      error: "Username contains inappropriate content",
      suggestions,
    };
  }

  // Check confusing patterns
  if (hasConfusingPatterns(username)) {
    return {
      valid: false,
      error:
        "Username contains confusing character combinations (e.g., multiple l, 1, O, 0). Please use a clearer username.",
    };
  }

  return { valid: true };
}

/**
 * Generate alternative username suggestions
 */
export function generateSuggestions(baseUsername: string): string[] {
  const suggestions: string[] = [];
  const base = baseUsername.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Suggestion 1: Add random number suffix
  const numericSuffix = Math.floor(Math.random() * 10000).toString();
  suggestions.push(
    `${base.slice(0, 31 - numericSuffix.length)}-${numericSuffix}`,
  );

  // Suggestion 2: Add "creator" prefix (if result stays within 32 char limit)
  if (!base.includes("creator") && base.length < 25) {
    suggestions.push(`creator-${base}`);
  }

  // Suggestion 3: Add "dev" suffix if it's a dev-related username
  if (base.length < 28) {
    suggestions.push(`${base}-dev`);
  }

  // Suggestion 4: Reverse the name
  const reversed = base.split("").reverse().join("");
  if (reversed !== base && reversed.length <= 32) {
    suggestions.push(reversed);
  }

  // Suggestion 5: Add timestamp-based suffix (unique)
  const timestamp = Date.now().toString(36);
  suggestions.push(`${base}-${timestamp}`.substring(0, 32));

  return suggestions.slice(0, 5); // Return top 5 suggestions
}

/**
 * Validate and provide suggestions for taken usernames
 */
export function validateUsernameWithTakenCheck(
  username: string,
  isTaken: boolean,
): {
  valid: boolean;
  error?: string;
  suggestions?: string[];
} {
  const validation = validateUsername(username);

  if (!validation.valid) {
    return validation;
  }

  if (isTaken) {
    const suggestions = generateSuggestions(username);
    return {
      valid: false,
      error: `Username "${username}" is already taken`,
      suggestions,
    };
  }

  return { valid: true };
}
