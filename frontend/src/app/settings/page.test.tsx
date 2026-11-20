import React from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPush = vi.fn();
const mockApiFetch = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/toast", () => ({
  Toast: () => null,
}));

vi.mock("@/components/notification-preferences", () => ({
  NotificationPreferences: () => null,
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: Parameters<typeof fetch>) => mockApiFetch(...args),
}));

vi.mock("@/lib/config", () => ({
  API_BASE_URL: "http://localhost:4000/v1",
}));

import SettingsPage from "./page";

describe("SettingsPage auth gate", () => {
  beforeEach(() => {
    localStorage.clear();
    mockPush.mockClear();
    mockApiFetch.mockReset();
  });

  it("loads the current user from the cookie-backed session instead of localStorage", async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "http://localhost:4000/v1/auth/me") {
        return {
          ok: true,
          json: async () => ({ username: "alice" }),
        } as Response;
      }
      return { ok: true, json: async () => ({ emailVerified: true }) } as Response;
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("http://localhost:4000/v1/auth/me", {
        suppressAuthExpired: true,
      });
    });

    await waitFor(() => {
      expect(mockPush).not.toHaveBeenCalled();
    });
  });
});
