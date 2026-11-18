// Profile import service: fetches public profile data from external platforms
// (GitHub) and maps it to NovaSupport profile fields.
//
// The GitHub endpoint uses the public REST API v3. An optional bearer token
// (GITHUB_TOKEN env var or caller-supplied) raises the rate limit from 60 to
// 5 000 requests/hour. Without a token the service still works for public
// profiles; it just has a lower burst capacity.

const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubProfileData {
  login: string;
  name: string | null;
  bio: string | null;
  avatar_url: string;
  blog: string | null;
  twitter_username: string | null;
  html_url: string;
}

export interface ImportedProfileData {
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  websiteUrl: string | null;
  twitterHandle: string | null;
  githubHandle: string;
}

export class GitHubUserNotFoundError extends Error {
  readonly name = "GitHubUserNotFoundError";
  constructor(username: string) {
    super(`GitHub user '${username}' not found`);
  }
}

export class GitHubRateLimitError extends Error {
  readonly name = "GitHubRateLimitError";
  readonly resetAt: Date | null;
  constructor(resetTimestamp: string | null) {
    super("GitHub API rate limit exceeded");
    this.resetAt = resetTimestamp ? new Date(Number(resetTimestamp) * 1000) : null;
  }
}

export class GitHubFetchError extends Error {
  readonly name = "GitHubFetchError";
  readonly status: number;
  constructor(status: number, detail?: string) {
    super(`GitHub API error ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

export async function fetchGitHubProfile(
  username: string,
  token?: string,
): Promise<GitHubProfileData> {
  const resolvedToken = token ?? process.env.GITHUB_TOKEN;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NovaSupport/1.0",
  };
  if (resolvedToken) {
    headers["Authorization"] = `Bearer ${resolvedToken}`;
  }

  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API_BASE}/users/${encodeURIComponent(username)}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
  } catch (err) {
    throw new GitHubFetchError(0, err instanceof Error ? err.message : String(err));
  }

  if (response.status === 404) {
    throw new GitHubUserNotFoundError(username);
  }

  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("X-RateLimit-Remaining");
    if (remaining === "0") {
      throw new GitHubRateLimitError(response.headers.get("X-RateLimit-Reset"));
    }
    // #1337 — GitHub secondary/abuse-detection rate limits return a 403 with no
    // X-RateLimit-Remaining header at all. Classify these as rate-limit errors too,
    // using the Retry-After header (seconds) for the retry timing when present.
    if (response.status === 403 && remaining === null) {
      const retryAfter = response.headers.get("Retry-After");
      const resetTimestamp = retryAfter
        ? String(Math.floor(Date.now() / 1000) + Number(retryAfter))
        : null;
      throw new GitHubRateLimitError(resetTimestamp);
    }
    throw new GitHubFetchError(response.status);
  }

  if (!response.ok) {
    throw new GitHubFetchError(response.status);
  }

  return response.json() as Promise<GitHubProfileData>;
}

export function mapGitHubToNovaSupport(gh: GitHubProfileData): ImportedProfileData {
  const displayName = gh.name?.trim() || gh.login;
  // 280 characters (code points). A plain slice counts UTF-16 units and can cut an emoji in half.
  const bio = Array.from((gh.bio ?? "").trim()).slice(0, 280).join("");

  let websiteUrl: string | null = null;
  const blog = gh.blog?.trim();
  if (blog) {
    const normalized = blog.startsWith("http") ? blog : `https://${blog}`;
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        websiteUrl = normalized;
      }
    } catch {
      // malformed URL — leave as null
    }
  }

  const twitterHandle = gh.twitter_username?.trim() || null;

  return {
    displayName,
    bio,
    avatarUrl: gh.avatar_url || null,
    websiteUrl,
    twitterHandle,
    githubHandle: gh.login,
  };
}
