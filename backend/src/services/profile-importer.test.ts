// Unit tests for profile-importer.ts — issue #756
// Run with: NODE_ENV=test tsx backend/src/services/profile-importer.test.ts

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  fetchGitHubProfile,
  mapGitHubToNovaSupport,
  GitHubUserNotFoundError,
  GitHubRateLimitError,
  GitHubFetchError,
  type GitHubProfileData,
} from "./profile-importer.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeGitHubProfile(overrides: Partial<GitHubProfileData> = {}): GitHubProfileData {
  return {
    login: "octocat",
    name: "The Octocat",
    bio: "A mischievous Octocat.",
    avatar_url: "https://avatars.githubusercontent.com/u/583231",
    blog: "https://github.blog",
    twitter_username: "github",
    html_url: "https://github.com/octocat",
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const original = global.fetch;
  // @ts-expect-error — stubbing global fetch
  global.fetch = (url: string, init?: RequestInit) => Promise.resolve(handler(url, init));
  return () => {
    global.fetch = original;
  };
}

function mockFetchThrow(err: Error) {
  const original = global.fetch;
  global.fetch = (() => Promise.reject(err)) as typeof global.fetch;
  return () => {
    global.fetch = original;
  };
}

// ─── fetchGitHubProfile ─────────────────────────────────────────────────────

describe("fetchGitHubProfile", () => {
  it("returns parsed profile data on a successful 200 response", async () => {
    const payload = makeGitHubProfile();
    const restore = mockFetch(() =>
      new Response(JSON.stringify(payload), { status: 200 })
    );
    try {
      const result = await fetchGitHubProfile("octocat");
      assert.equal(result.login, "octocat");
      assert.equal(result.name, "The Octocat");
    } finally {
      restore();
    }
  });

  it("throws GitHubUserNotFoundError on 404", async () => {
    const restore = mockFetch(() => new Response(null, { status: 404 }));
    try {
      await assert.rejects(
        () => fetchGitHubProfile("ghost-user-xyz"),
        (err: unknown) => err instanceof GitHubUserNotFoundError
      );
    } finally {
      restore();
    }
  });

  it("throws GitHubRateLimitError on 403 with X-RateLimit-Remaining: 0", async () => {
    const restore = mockFetch(() =>
      new Response(null, {
        status: 403,
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "9999999999",
        },
      })
    );
    try {
      await assert.rejects(
        () => fetchGitHubProfile("anyone"),
        (err: unknown) => err instanceof GitHubRateLimitError
      );
    } finally {
      restore();
    }
  });

  it("throws GitHubRateLimitError on 429 with X-RateLimit-Remaining: 0", async () => {
    const restore = mockFetch(() =>
      new Response(null, {
        status: 429,
        headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "9999999999" },
      })
    );
    try {
      await assert.rejects(
        () => fetchGitHubProfile("anyone"),
        (err: unknown) => err instanceof GitHubRateLimitError
      );
    } finally {
      restore();
    }
  });

  it("throws GitHubFetchError on 403 without rate-limit headers", async () => {
    const restore = mockFetch(() =>
      new Response(null, {
        status: 403,
        headers: { "X-RateLimit-Remaining": "10" },
      })
    );
    try {
      await assert.rejects(
        () => fetchGitHubProfile("anyone"),
        (err: unknown) => err instanceof GitHubFetchError && (err as GitHubFetchError).status === 403
      );
    } finally {
      restore();
    }
  });

  it("throws GitHubFetchError on unexpected 5xx status", async () => {
    const restore = mockFetch(() => new Response(null, { status: 503 }));
    try {
      await assert.rejects(
        () => fetchGitHubProfile("anyone"),
        (err: unknown) => err instanceof GitHubFetchError && (err as GitHubFetchError).status === 503
      );
    } finally {
      restore();
    }
  });

  it("throws GitHubFetchError wrapping a network error", async () => {
    const restore = mockFetchThrow(new TypeError("Failed to fetch"));
    try {
      await assert.rejects(
        () => fetchGitHubProfile("anyone"),
        (err: unknown) =>
          err instanceof GitHubFetchError && (err as GitHubFetchError).status === 0
      );
    } finally {
      restore();
    }
  });

  it("attaches a resetAt Date when X-RateLimit-Reset header is present", async () => {
    const resetTs = "2000000000"; // a fixed Unix timestamp
    const restore = mockFetch(() =>
      new Response(null, {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": resetTs },
      })
    );
    try {
      await assert.rejects(
        () => fetchGitHubProfile("anyone"),
        (err: unknown) => {
          assert.ok(err instanceof GitHubRateLimitError);
          assert.ok((err as GitHubRateLimitError).resetAt instanceof Date);
          return true;
        }
      );
    } finally {
      restore();
    }
  });
});

// ─── mapGitHubToNovaSupport ─────────────────────────────────────────────────

describe("mapGitHubToNovaSupport", () => {
  it("maps all fields correctly for a fully populated profile", () => {
    const gh = makeGitHubProfile();
    const result = mapGitHubToNovaSupport(gh);

    assert.equal(result.displayName, "The Octocat");
    assert.equal(result.bio, "A mischievous Octocat.");
    assert.equal(result.websiteUrl, "https://github.blog");
    assert.equal(result.twitterHandle, "github");
    assert.equal(result.avatarUrl, gh.avatar_url);
    assert.equal(result.githubHandle, "octocat");
  });

  it("falls back to login when name is null", () => {
    const gh = makeGitHubProfile({ name: null });
    const result = mapGitHubToNovaSupport(gh);
    assert.equal(result.displayName, "octocat");
  });

  it("falls back to login when name is an empty string", () => {
    const gh = makeGitHubProfile({ name: "   " });
    const result = mapGitHubToNovaSupport(gh);
    assert.equal(result.displayName, "octocat");
  });

  it("maps null bio to empty string (not the string 'null')", () => {
    const gh = makeGitHubProfile({ bio: null });
    const result = mapGitHubToNovaSupport(gh);
    assert.equal(result.bio, "");
    assert.notEqual(result.bio, "null");
  });

  it("maps null blog to null websiteUrl (not the string 'null')", () => {
    const gh = makeGitHubProfile({ blog: null });
    const result = mapGitHubToNovaSupport(gh);
    assert.equal(result.websiteUrl, null);
  });

  it("maps null twitter_username to null twitterHandle", () => {
    const gh = makeGitHubProfile({ twitter_username: null });
    const result = mapGitHubToNovaSupport(gh);
    assert.equal(result.twitterHandle, null);
  });

  it("normalises a blog URL that is missing the https:// scheme", () => {
    const gh = makeGitHubProfile({ blog: "github.blog" });
    const result = mapGitHubToNovaSupport(gh);
    assert.equal(result.websiteUrl, "https://github.blog");
  });

  it("discards malformed blog URLs", () => {
    const gh = makeGitHubProfile({ blog: "not a url !" });
    const result = mapGitHubToNovaSupport(gh);
    assert.equal(result.websiteUrl, null);
  });

  it("truncates bio longer than 280 characters", () => {
    const longBio = "x".repeat(300);
    const gh = makeGitHubProfile({ bio: longBio });
    const result = mapGitHubToNovaSupport(gh);
    assert.equal(result.bio.length, 280);
  });
});
