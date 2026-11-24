import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/config", () => ({ API_BASE_URL: "http://api" }));

import { apiFetch } from "@/lib/api-client";
import { NotificationPreferences } from "./notification-preferences";

const mocked = vi.mocked(apiFetch);

function json(data: unknown) {
  return { ok: true, json: async () => data } as unknown as Response;
}

describe("NotificationPreferences staleness", () => {
  beforeEach(() => mocked.mockReset());

  it("ignores a late response for a previous username", async () => {
    let resolveA!: (v: Response) => void;
    mocked.mockImplementation((url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/alice/notification-preferences"))
        return new Promise<Response>((r) => (resolveA = r));
      if (u.includes("/alice")) return Promise.resolve(json({ emailVerified: true }));
      if (u.includes("/bob/notification-preferences"))
        return Promise.resolve(
          json({ notifyOnSupport: false, notifyOnMilestone: false, weeklyDigest: false }),
        );
      return Promise.resolve(json({ emailVerified: true }));
    });

    const { rerender } = render(<NotificationPreferences username="alice" />);
    rerender(<NotificationPreferences username="bob" />);

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Weekly digest" })).toBeInTheDocument(),
    );

    await act(async () => {
      resolveA(
        json({ notifyOnSupport: true, notifyOnMilestone: true, weeklyDigest: true }),
      );
    });

    expect(screen.getByRole("switch", { name: "New support received" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Weekly digest" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
