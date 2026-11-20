import React from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ username: "alice" }),
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: Parameters<typeof fetch>) => mockApiFetch(...args),
}));

vi.mock("@/lib/config", () => ({
  API_BASE_URL: "http://localhost:4000/v1",
}));

import DashboardPage from "./page";

const API = "http://localhost:4000/v1";
const OWNER_WALLET = "GOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_WALLET = "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function mockBackend() {
  mockApiFetch.mockImplementation(async (url: string) => {
    if (url === `${API}/analytics/alice`) {
      return json({
        summary: { totalRaised: 10, totalContributors: 1, avgContribution: 10, activeDrips: 0 },
        recentTransactions: [],
      });
    }
    if (url === `${API}/profiles/alice`) {
      return json({
        walletAddress: OWNER_WALLET,
        email: "alice@example.com",
        emailVerified: true,
        notifyOnSupport: true,
      });
    }
    if (url === `${API}/profiles/alice/analytics/assets`) return json({ breakdown: [], total: 0 });
    if (url.startsWith(`${API}/v1/recurring-support`)) return json([]);
    return json({ data: [] });
  });
}

async function renderDashboard() {
  render(<DashboardPage />);
  expect(await screen.findByText("Campaign")).toBeInTheDocument();
}

function connectWallet(address: string) {
  act(() => {
    localStorage.setItem("walletAddress", address);
    window.dispatchEvent(new Event("wallet-connected"));
  });
}

describe("Per-creator DashboardPage wallet ownership (#1288)", () => {
  beforeEach(() => {
    localStorage.clear();
    mockApiFetch.mockReset();
    mockBackend();
  });

  it("shows owner-only sections when the owner connects mid-session", async () => {
    await renderDashboard();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Download CSV")).not.toBeInTheDocument();

    connectWallet(OWNER_WALLET);

    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Download CSV")).toBeInTheDocument();
    expect(await screen.findByText("No active drips set up for this profile.")).toBeInTheDocument();
  });

  it("keeps owner-only sections hidden when a different wallet connects", async () => {
    await renderDashboard();

    connectWallet(OTHER_WALLET);

    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Download CSV")).not.toBeInTheDocument();
  });

  it("hides owner-only sections again when the wallet disconnects", async () => {
    localStorage.setItem("walletAddress", OWNER_WALLET);
    await renderDashboard();
    expect(await screen.findByText("Settings")).toBeInTheDocument();

    act(() => {
      localStorage.removeItem("walletAddress");
      window.dispatchEvent(new Event("wallet-disconnected"));
    });

    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("picks up a wallet connected in another tab", async () => {
    await renderDashboard();

    act(() => {
      localStorage.setItem("walletAddress", OWNER_WALLET);
      window.dispatchEvent(
        new StorageEvent("storage", { key: "walletAddress", newValue: OWNER_WALLET }),
      );
    });

    expect(await screen.findByText("Settings")).toBeInTheDocument();
  });
});
