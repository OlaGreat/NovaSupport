import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPush = vi.fn();
const mockApiFetch = vi.fn();
// Stable identity: the page's load effect depends on `router`.
const mockRouter = { push: mockPush };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/toast", () => ({
  Toast: () => null,
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: Parameters<typeof fetch>) => mockApiFetch(...args),
}));

vi.mock("@/lib/config", () => ({
  API_BASE_URL: "http://localhost:4000/v1",
}));

import RecurringPage from "./page";

const API = "http://localhost:4000/v1";

function subscription(id: string, status: "active" | "paused" | "cancelled") {
  return {
    id,
    profileId: `profile_${id}`,
    profileUsername: `creator_${id}`,
    profileDisplayName: `Creator ${id}`,
    profileAvatarUrl: null,
    amount: "5",
    assetCode: "XLM",
    frequency: "weekly",
    nextRunAt: "2026-10-01T00:00:00.000Z",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function mockSubscriptions(subscriptions: unknown[]) {
  mockApiFetch.mockImplementation(async (url: string) => {
    if (url === `${API}/auth/me`) {
      return { ok: true, json: async () => ({ username: "alice" }) } as Response;
    }
    if (url === `${API}/v1/recurring-support`) {
      return { ok: true, json: async () => subscriptions } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  });
}

describe("RecurringPage", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockApiFetch.mockReset();
  });

  it("shows the empty state only when there are no subscriptions at all", async () => {
    mockSubscriptions([]);
    render(<RecurringPage />);

    expect(await screen.findByText("No recurring support yet")).toBeInTheDocument();
  });

  it("does not show the empty state when only cancelled subscriptions exist (#1250)", async () => {
    mockSubscriptions([subscription("a", "cancelled")]);
    render(<RecurringPage />);

    expect(await screen.findByText("Cancelled (1)")).toBeInTheDocument();
    expect(screen.getByText("Creator a")).toBeInTheDocument();
    expect(screen.queryByText("No recurring support yet")).not.toBeInTheDocument();
  });

  it("renders cancelled subscriptions as read-only history", async () => {
    mockSubscriptions([subscription("a", "active"), subscription("b", "cancelled")]);
    render(<RecurringPage />);

    expect(await screen.findByText("Active (1)")).toBeInTheDocument();
    expect(screen.getByText("Cancelled (1)")).toBeInTheDocument();
    // Only the active subscription offers actions.
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    // A cancelled drip has no upcoming run.
    expect(screen.getAllByText(/· next/)).toHaveLength(1);
  });
});
