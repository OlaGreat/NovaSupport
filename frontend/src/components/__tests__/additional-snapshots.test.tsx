import React from "react";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ThemeToggle } from "../theme-toggle";
import { MilestoneCard } from "../milestone-card";
import { EmbedWidget } from "../embed-widget";
import { ActivityFeed } from "../activity-feed";
import { NotificationPreferences } from "../notification-preferences";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

vi.mock("framer-motion", () => {
  // Passthrough for any motion.<element>, not just the handful used today.
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const Passthrough = ({ children, ...props }: any) =>
          React.createElement(tag, props, children);
        Passthrough.displayName = `motion.${tag}`;
        return Passthrough;
      },
    },
  );
  return { motion, AnimatePresence: ({ children }: any) => children };
});

vi.mock("lucide-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react")>()),
  TrendingUp: () => <span>TrendingUp</span>,
  Send: () => <span>Send</span>,
  Award: () => <span>Award</span>,
  RefreshCw: () => <span>RefreshCw</span>,
  ChevronDown: () => <span>ChevronDown</span>,
  Loader2: () => <span>Loader2</span>,
  AlertTriangle: () => <span>AlertTriangle</span>,
  Trophy: () => <span>Trophy</span>,
  Target: () => <span>Target</span>,
  Sparkles: () => <span>Sparkles</span>,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  SITE_URL: "https://novasupport.app",
  API_BASE_URL: "http://localhost:4000",
}));

vi.stubGlobal(
  "fetch",
  vi.fn().mockReturnValue(new Promise(() => {})),
);

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("Additional Component Snapshots", () => {
  it("ThemeToggle matches snapshot", () => {
    const { container } = render(<ThemeToggle />);
    expect(container).toMatchSnapshot();
  });

  it("MilestoneCard matches snapshot (in-progress)", () => {
    const milestone = {
      id: "m1",
      title: "New Equipment Fund",
      description: "Raising funds for recording gear",
      targetAmount: "1000",
      currentAmount: "250",
      assetCode: "XLM",
      status: "active",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const { container } = render(<MilestoneCard milestone={milestone} index={0} />);
    expect(container).toMatchSnapshot();
  });

  it("MilestoneCard matches snapshot (reached)", () => {
    const milestone = {
      id: "m2",
      title: "Goal Reached!",
      description: null,
      targetAmount: "500",
      currentAmount: "600",
      assetCode: "XLM",
      status: "reached",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    // A reached milestone renders a confetti burst whose particle sizes and
    // colours come from Math.random(), so pin it to keep the snapshot stable.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.42);
    try {
      const { container } = render(<MilestoneCard milestone={milestone} index={1} />);
      expect(container).toMatchSnapshot();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("MilestoneCard renders zero progress when the current amount is malformed", () => {
    render(
      <MilestoneCard
        milestone={{
          id: "malformed",
          title: "Malformed amount",
          targetAmount: "100",
          currentAmount: "invalid",
          assetCode: "XLM",
          status: "active",
          createdAt: "2024-01-01T00:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.queryByText("NaN%")).not.toBeInTheDocument();
  });

  it("EmbedWidget matches snapshot (dark theme, minimal props)", () => {
    const { container } = render(
      <EmbedWidget
        username="johndoe"
        displayName="John Doe"
        bio="Stellar developer and content creator"
        acceptedAssets={[{ code: "XLM" }]}
        profileUrl="https://novasupport.app/johndoe"
      />,
    );
    expect(container).toMatchSnapshot();
  });

  it("EmbedWidget matches snapshot (light theme, with stats)", () => {
    const { container } = render(
      <EmbedWidget
        username="johndoe"
        displayName="John Doe"
        bio="Stellar developer"
        acceptedAssets={[
          { code: "XLM" },
          { code: "USDC", issuer: "GBBD47IF6LWK7P7MDMSCR4XFM6KJLGMGR5E2Q3ZXZQ4KQQYT5R3332W" },
        ]}
        stats={{
          totalTransactions: 42,
          uniqueSupporters: 15,
          assetTotals: [{ assetCode: "XLM", total: "1000.0000000" }],
        }}
        recentSupporters={[
          {
            supporterAddress: "GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM",
            totalAmount: "100.0000000",
            assetCode: "XLM",
          },
        ]}
        theme="light"
        size="large"
        profileUrl="https://novasupport.app/johndoe"
      />,
    );
    expect(container).toMatchSnapshot();
  });

  it("EmbedWidget renders stats when asset totals are omitted", () => {
    render(
      <EmbedWidget
        username="johndoe"
        displayName="John Doe"
        bio="Stellar developer"
        acceptedAssets={[{ code: "XLM" }]}
        stats={{ totalTransactions: 1, uniqueSupporters: 1 }}
        profileUrl="https://novasupport.app/johndoe"
      />,
    );

    expect(screen.getByText("Transactions")).toBeInTheDocument();
    expect(screen.getByText("Supporters")).toBeInTheDocument();
  });

  it("ActivityFeed matches snapshot (loading state)", () => {
    const { container } = renderWithQueryClient(<ActivityFeed username="johndoe" limit={5} />);
    expect(container).toMatchSnapshot();
  });

  it("ActivityFeed matches snapshot (with loaded data)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            transactions: [
              {
                id: "tx1",
                amount: "100.0000000",
                assetCode: "XLM",
                status: "SUCCESS",
                createdAt: "2024-01-15T10:30:00Z",
                supporterAddress: "GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ milestones: [] }),
        } as unknown as Response),
    );

    const { container } = renderWithQueryClient(<ActivityFeed username="johndoe" limit={5} />);

    await waitFor(() => {
      expect(container).toHaveTextContent("Received 100.0000000 XLM");
    });

    // Restore the original never-resolving mock for subsequent tests
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
  });

  it("NotificationPreferences matches snapshot (no auth token)", () => {
    const { container } = render(<NotificationPreferences username="johndoe" />);
    expect(container).toMatchSnapshot();
  });

  // Issue #597: milestones fetch failure shows a partial-failure notice
  it("ActivityFeed shows partial-failure notice when milestones fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ transactions: [] }),
        } as unknown as Response)
        .mockRejectedValueOnce(new Error("Network error")),
    );

    const { container } = renderWithQueryClient(<ActivityFeed username="johndoe" limit={5} />);

    await waitFor(() => {
      expect(container.textContent).toContain("Milestone data could not be loaded");
    });

    // Restore the original never-resolving mock for subsequent tests
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
  });
});
