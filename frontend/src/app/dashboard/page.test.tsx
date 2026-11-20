import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  Toast: ({ message, type }: { message: string; type: string }) => (
    <div role="status" data-type={type}>
      {message}
    </div>
  ),
}));

vi.mock("@/components/onboarding-checklist", () => ({
  OnboardingChecklist: () => null,
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: Parameters<typeof fetch>) => mockApiFetch(...args),
}));

vi.mock("@/lib/config", () => ({
  API_BASE_URL: "http://localhost:4000/v1",
}));

import DashboardPage from "./page";

const API = "http://localhost:4000/v1";

const webhook = {
  id: "wh_1",
  url: "https://example.com/hook",
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const milestone = {
  id: "ms_1",
  title: "Album Production",
  description: null,
  targetAmount: "100",
  currentAmount: "10",
  assetCode: "XLM",
  assetIssuer: null,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function json(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(),
    json: async () => body,
  } as Response;
}

type Override = (url: string, init?: RequestInit) => Response | undefined;

function mockBackend(override: Override = () => undefined) {
  mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const custom = override(url, init);
    if (custom) return custom;
    if (url === `${API}/auth/me`) return json({ username: "alice" });
    if (url === `${API}/profiles/alice/stats`) {
      return json({ totalTransactions: 0, uniqueSupporters: 0, assetTotals: [] });
    }
    if (url === `${API}/profiles/alice/milestones?limit=100`) return json({ milestones: [milestone] });
    if (url === `${API}/profiles/alice/webhooks`) return json({ webhooks: [webhook] });
    if (url === `${API}/profiles/alice`) return json({ acceptedAssets: [] });
    return json({});
  });
}

function mutatingCalls() {
  return mockApiFetch.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
}

async function openMilestoneForm() {
  render(<DashboardPage />);
  fireEvent.click(await screen.findByRole("button", { name: /add goal/i }));
  fireEvent.change(screen.getByPlaceholderText("e.g., Album Production"), {
    target: { value: "New goal" },
  });
  return screen.getByPlaceholderText("1000") as HTMLInputElement;
}

describe("DashboardPage", () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockPush.mockClear();
    mockApiFetch.mockReset();
    alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  describe("milestone target amount validation (#1248)", () => {
    it("constrains the target amount input to positive values", async () => {
      mockBackend();
      const input = await openMilestoneForm();
      expect(input).toHaveAttribute("min", "0.01");
    });

    it.each(["0", "-5"])("rejects a target amount of %s without calling the backend", async (value) => {
      mockBackend();
      const input = await openMilestoneForm();
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest("form")!);

      expect(await screen.findByRole("status")).toHaveTextContent(
        "Target amount must be a positive number.",
      );
      expect(mutatingCalls()).toHaveLength(0);
    });

    it("submits a positive target amount", async () => {
      mockBackend((url, init) =>
        url === `${API}/profiles/alice/milestones` && init?.method === "POST"
          ? json({ ...milestone, id: "ms_2", title: "New goal", targetAmount: "50" })
          : undefined,
      );
      const input = await openMilestoneForm();
      fireEvent.change(input, { target: { value: "50" } });
      fireEvent.submit(input.closest("form")!);

      expect(await screen.findByText("New goal")).toBeInTheDocument();
      expect(mutatingCalls()).toHaveLength(1);
    });
  });

  describe("backend error messages (#1249)", () => {
    it("surfaces the backend error when saving a milestone fails", async () => {
      mockBackend((url, init) =>
        url === `${API}/profiles/alice/milestones` && init?.method === "POST"
          ? json({ error: "Asset USDC is not accepted by this profile" }, { ok: false, status: 400 })
          : undefined,
      );
      const input = await openMilestoneForm();
      fireEvent.change(input, { target: { value: "50" } });
      fireEvent.submit(input.closest("form")!);

      const toast = await screen.findByRole("status");
      expect(toast).toHaveTextContent("Asset USDC is not accepted by this profile");
      expect(toast).toHaveAttribute("data-type", "error");
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it("surfaces the backend error when deleting a milestone fails", async () => {
      mockBackend((url, init) =>
        url === `${API}/profiles/alice/milestones/ms_1` && init?.method === "DELETE"
          ? json({ error: "Milestone not found" }, { ok: false, status: 404 })
          : undefined,
      );
      render(<DashboardPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Delete milestone: Album Production" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

      expect(await screen.findByRole("status")).toHaveTextContent("Milestone not found");
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it("surfaces the backend error when adding a webhook fails", async () => {
      mockBackend((url, init) =>
        url === `${API}/profiles/alice/webhooks` && init?.method === "POST"
          ? json({ error: "Webhook URL already registered" }, { ok: false, status: 409 })
          : undefined,
      );
      render(<DashboardPage />);
      fireEvent.click(await screen.findByRole("button", { name: /add webhook/i }));
      const input = screen.getByPlaceholderText("https://example.com/webhook");
      fireEvent.change(input, { target: { value: "https://example.com/other" } });
      fireEvent.submit(input.closest("form")!);

      expect(await screen.findByRole("status")).toHaveTextContent("Webhook URL already registered");
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it("falls back to a generic message when the webhook delete response has no error body", async () => {
      mockBackend((url, init) =>
        url === `${API}/profiles/alice/webhooks/wh_1` && init?.method === "DELETE"
          ? ({
              ok: false,
              status: 500,
              headers: new Headers(),
              json: async () => {
                throw new SyntaxError("Unexpected end of JSON input");
              },
            } as unknown as Response)
          : undefined,
      );
      render(<DashboardPage />);
      fireEvent.click(await screen.findByRole("button", { name: `Delete webhook for ${webhook.url}` }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent("Failed to delete webhook");
      });
      expect(alertSpy).not.toHaveBeenCalled();
    });
  });

  describe("Total Earned asset label (#1285)", () => {
    function totalEarnedValue() {
      return screen.getByText("Total Earned").nextElementSibling;
    }

    it("labels a USDC-only creator's earnings as USDC", async () => {
      mockBackend((url) =>
        url === `${API}/profiles/alice/stats`
          ? json({
              totalTransactions: 2,
              uniqueSupporters: 2,
              assetTotals: [{ assetCode: "USDC", assetIssuer: "GISSUER", total: "25.5000000" }],
            })
          : undefined,
      );
      render(<DashboardPage />);

      expect(await screen.findByText("Total Earned")).toBeInTheDocument();
      expect(totalEarnedValue()).toHaveTextContent("25.5 USDC");
      expect(totalEarnedValue()).not.toHaveTextContent("XLM");
    });

    it("uses the asset with the largest total", async () => {
      mockBackend((url) =>
        url === `${API}/profiles/alice/stats`
          ? json({
              totalTransactions: 3,
              uniqueSupporters: 2,
              assetTotals: [
                { assetCode: "XLM", assetIssuer: null, total: "5.0000000" },
                { assetCode: "AQUA", assetIssuer: "GISSUER", total: "40.0000000" },
              ],
            })
          : undefined,
      );
      render(<DashboardPage />);

      expect(await screen.findByText("Total Earned")).toBeInTheDocument();
      expect(totalEarnedValue()).toHaveTextContent("40 AQUA");
    });

    it("falls back to XLM when there are no earnings yet", async () => {
      mockBackend();
      render(<DashboardPage />);

      expect(await screen.findByText("Total Earned")).toBeInTheDocument();
      expect(totalEarnedValue()).toHaveTextContent("0 XLM");
    });
  });

  describe("load failure (#1287)", () => {
    it("renders the captured error instead of an empty dashboard", async () => {
      mockBackend((url) => {
        if (url === `${API}/profiles/alice/stats`) throw new Error("Network request failed");
        return undefined;
      });
      render(<DashboardPage />);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Dashboard Unavailable");
      expect(alert).toHaveTextContent("Network request failed");
      expect(screen.queryByText("Funding Goals")).not.toBeInTheDocument();
    });

    it("shows the error even when the failure happens before the username resolves", async () => {
      mockApiFetch.mockRejectedValue(new Error("Failed to fetch"));
      render(<DashboardPage />);

      expect(await screen.findByRole("alert")).toHaveTextContent("Failed to fetch");
      expect(screen.queryByText("Redirecting...")).not.toBeInTheDocument();
      expect(mockPush).not.toHaveBeenCalled();
    });
  });
});
