// Component tests for ActivityFeed — issue #757
// Run with: vitest run

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// ── Stub out Next.js Link so tests don't need a full Next.js context ────────
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Stub framer-motion to avoid animation side-effects in tests
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ActivityFeed } from "./activity-feed";

// ─── test helpers ─────────────────────────────────────────────────────────

const makeTransaction = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  amount: "10.0000000",
  assetCode: "XLM",
  senderAddress: "GABC1234567890",
  txHash: "abc123def456",
  createdAt: new Date().toISOString(),
  ...overrides,
});

const makeMilestone = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: "First 100 XLM",
  targetAmount: "100",
  assetCode: "XLM",
  reachedAt: new Date().toISOString(),
  ...overrides,
});

function stubFetch(
  transactions: ReturnType<typeof makeTransaction>[],
  milestones: ReturnType<typeof makeMilestone>[] = []
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/milestones")) {
        return Promise.resolve(
          new Response(JSON.stringify({ milestones }), { status: 200 })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ transactions }), { status: 200 })
      );
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── tests ────────────────────────────────────────────────────────────────

describe("ActivityFeed", () => {
  it("renders skeleton placeholders while loading", () => {
    // Never resolves — keeps the component in loading state
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);

    // The skeletons are animated pulse divs rendered during loading
    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders 'No activity yet' when there are no transactions or milestones", async () => {
    stubFetch([]);
    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);
    await waitFor(() => expect(screen.getByText(/no activity yet/i)).toBeInTheDocument());
  });

  it("renders transaction items with correct amount, asset, and timestamp", async () => {
    const tx = makeTransaction("tx-1", { amount: "25.5000000", assetCode: "USDC" });
    stubFetch([tx]);
    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);

    await waitFor(() => {
      // The amount appears both in the title and the metadata chip — assert
      // on presence, not uniqueness, of the text.
      expect(screen.getAllByText(/25\.5000000/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0);
    });
  });

  it("shows 'Load more' button only when items exceed the limit prop", async () => {
    const txs = Array.from({ length: 8 }, (_, i) => makeTransaction(`tx-${i}`));
    stubFetch(txs);
    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument();
    });
  });

  it("does NOT show 'Load more' when items are within the limit", async () => {
    const txs = [makeTransaction("tx-0"), makeTransaction("tx-1")];
    stubFetch(txs);
    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);

    await waitFor(() => expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("clicking 'Load more' reveals additional items", async () => {
    const txs = Array.from({ length: 6 }, (_, i) =>
      makeTransaction(`tx-${i}`, { amount: `${i + 1}.0000000` })
    );
    stubFetch(txs);
    renderWithQueryClient(<ActivityFeed username="octocat" limit={3} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument()
    );

    // Initially only 3 items shown
    expect(screen.getAllByText(/Received/).length).toBe(3);

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    // After clicking, more items should appear
    expect(screen.getAllByText(/Received/).length).toBeGreaterThan(3);
  });

  it("renders milestone reached items with the milestone title", async () => {
    const milestone = makeMilestone("m-1", { title: "First 100 XLM" });
    stubFetch([], [milestone]);
    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);

    await waitFor(() => {
      expect(screen.getByText(/First 100 XLM/)).toBeInTheDocument();
      expect(screen.getByText(/Milestone reached/i)).toBeInTheDocument();
    });
  });

  it("renders the error message when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Network error"))));

    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load activity feed/i)).toBeInTheDocument();
    });
  });

  it("shows partial-failure notice when milestones API fails but transactions load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/milestones")) {
          return Promise.resolve(new Response(null, { status: 500 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ transactions: [makeTransaction("tx-1")] }), {
            status: 200,
          })
        );
      })
    );

    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);

    await waitFor(() => {
      expect(screen.getByText(/milestone data could not be loaded/i)).toBeInTheDocument();
    });
  });

  it("shows transactions and a partial-failure notice when milestone JSON is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/milestones")) {
          return Promise.resolve(new Response("not valid JSON", { status: 200 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ transactions: [makeTransaction("tx-1")] }), {
            status: 200,
          })
        );
      })
    );

    renderWithQueryClient(<ActivityFeed username="octocat" limit={5} />);

    await waitFor(() => {
      expect(screen.getByText(/milestone data could not be loaded/i)).toBeInTheDocument();
      expect(screen.getByText(/Received 10\.0000000 XLM/i)).toBeInTheDocument();
    });
  });
});
