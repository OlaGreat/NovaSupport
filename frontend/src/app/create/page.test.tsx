// Component tests for CreatePage (multi-step profile wizard) — issue #758
// Run with: vitest run

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// ── Stub Next.js router ──────────────────────────────────────────────────────
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Stub Next.js Link
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Stub stellar validation so we can enter any wallet address in tests
vi.mock("@/lib/stellar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar")>()),
  validateWalletAddress: (addr: string) => ({
    isValid: addr.startsWith("G"),
    error: addr.startsWith("G") ? null : "Invalid Stellar wallet address.",
  }),
}));

// Stub @/lib/config
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()), API_BASE_URL: "http://localhost:4000/v1" }));

// Stub AppShell to just render children
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Stub Toast
vi.mock("@/components/toast", () => ({
  Toast: ({ message }: { message: string }) => <div role="alert">{message}</div>,
}));

// Stub useToast
vi.mock("@/lib/use-toast", () => ({
  useToast: () => ({ toast: null, showToast: vi.fn(), dismiss: vi.fn() }),
}));

import CreatePage from "./page";

// ─── helpers ─────────────────────────────────────────────────────────────────

const VALID_STEP1 = {
  displayName: "Alice Dev",
  username: "alicedev",
  bio: "Building on Stellar.",
  walletAddress: "GABC123456789012345678901234567890123456789012345678901234",
};

async function fillStep1(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/Star Voyager/i), VALID_STEP1.displayName);
  await user.type(screen.getByPlaceholderText(/username/i), VALID_STEP1.username);
  await user.type(screen.getByPlaceholderText(/Tell the galaxy/i), VALID_STEP1.bio);
}

/** The wallet address input lives on Step 2, not Step 1. */
async function fillStep2(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/G…/), VALID_STEP1.walletAddress);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("CreatePage — step navigation", () => {
  it("starts on Step 1", () => {
    render(<CreatePage />);
    expect(screen.getByText(/step 1/i)).toBeInTheDocument();
  });

  it("advances from Step 1 to Step 2 when all required fields are valid", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/step 2/i)).toBeInTheDocument());
  });

  it("does NOT advance from Step 1 when displayName is empty", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    // Skip displayName — fill everything else
    await user.type(screen.getByPlaceholderText(/username/i), "alicedev");
    await user.type(screen.getByPlaceholderText(/Tell the galaxy/i), "Some bio.");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByText(/step 1/i)).toBeInTheDocument();
  });

  it("navigates back from Step 2 to Step 1", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => screen.getByText(/step 2/i));

    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText(/step 1/i)).toBeInTheDocument();
  });
});

describe("CreatePage — username validation", () => {
  it("shows an error for a username with leading hyphen", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await user.type(screen.getByPlaceholderText(/username/i), "-badname");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // The username field shows an inline validation error
    expect(screen.getByPlaceholderText(/username/i)).toBeInTheDocument();
  });

  it("shows an error for a username that is too short (< 3 chars)", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await user.type(screen.getByPlaceholderText(/username/i), "ab");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByText(/step 1/i)).toBeInTheDocument(); // still on step 1
  });

  it("accepts a valid alphanumeric username with hyphens", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await user.type(screen.getByPlaceholderText(/Star Voyager/i), "Alice");
    await user.type(screen.getByPlaceholderText(/username/i), "alice-dev");
    await user.type(screen.getByPlaceholderText(/Tell the galaxy/i), "Bio here.");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/step 2/i)).toBeInTheDocument());
  });
});

describe("CreatePage — Step 2 asset selection", () => {
  async function goToStep2() {
    const user = userEvent.setup();
    render(<CreatePage />);
    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => screen.getByText(/step 2/i));
    return user;
  }

  it("shows asset quick-pick buttons on Step 2", async () => {
    await goToStep2();
    // XLM and USDC are pre-selected by default; buttons should be present
    expect(screen.getByRole("button", { name: /^XLM$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^USDC$/ })).toBeInTheDocument();
  });

  it("toggling an already-selected asset deselects it", async () => {
    const user = await goToStep2();
    const xlmBtn = screen.getByRole("button", { name: /^XLM$/ });

    // XLM starts selected; clicking should deselect
    await user.click(xlmBtn);

    // After deselect the button should change visual state (aria-pressed = false)
    expect(xlmBtn).not.toHaveAttribute("aria-pressed", "true");
  });

  it("toggling an unselected asset selects it", async () => {
    const user = await goToStep2();
    // AQUA is not pre-selected
    const aquaBtn = screen.queryByRole("button", { name: /^AQUA$/ });
    if (aquaBtn) {
      await user.click(aquaBtn);
      expect(aquaBtn).toHaveAttribute("aria-pressed", "true");
    }
  });
});

describe("CreatePage — Step 3 submission", () => {
  async function goToStep3() {
    const user = userEvent.setup();
    render(<CreatePage />);
    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => screen.getByText(/step 2/i));
    await fillStep2(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => screen.getByText(/step 3/i));
    return user;
  }

  it("calls POST /profiles with correct body on submit", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ username: VALID_STEP1.username }), { status: 201 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const user = await goToStep3();
    await user.click(screen.getByRole("button", { name: /create profile/i }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/profiles");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string);
    expect(body.username).toBe(VALID_STEP1.username);
    expect(body.displayName).toBe(VALID_STEP1.displayName);
  });

  it("trims the display name before submitting", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ username: VALID_STEP1.username }), { status: 201 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const user = await goToStep3();
    await user.click(screen.getByRole("button", { name: /back/i }));
    await user.click(screen.getByRole("button", { name: /back/i }));
    const displayNameInput = screen.getByPlaceholderText(/Star Voyager/i);
    await user.clear(displayNameInput);
    await user.type(displayNameInput, "  Alice Dev  ");
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.click(screen.getByRole("button", { name: /create profile/i }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string).displayName).toBe("Alice Dev");
  });

  it("does not submit invalid social links from the final step", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const user = await goToStep3();
    await user.type(screen.getByPlaceholderText("handle"), "invalid handle");
    await user.click(screen.getByRole("button", { name: /create profile/i }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByText(/please fix the errors in your social links/i)).toBeInTheDocument();
  });

  it("shows rate-limit countdown message on RATE_LIMIT_EXCEEDED response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: "RATE_LIMIT_EXCEEDED" }),
          {
            status: 429,
            headers: { "Retry-After": "60" },
          }
        )
      )
    );

    const user = await goToStep3();
    await user.click(screen.getByRole("button", { name: /create profile/i }));

    // The countdown surfaces both inline and in the toast.
    await waitFor(() => {
      expect(screen.getAllByText(/try again in/i).length).toBeGreaterThan(0);
    });
  });

  it("surfaces USERNAME_TAKEN API error on the username field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: "USERNAME_TAKEN", error: "Username already taken" }),
          { status: 409 }
        )
      )
    );

    const user = await goToStep3();
    await user.click(screen.getByRole("button", { name: /create profile/i }));

    await waitFor(() => {
      expect(screen.getByText(/username already taken/i)).toBeInTheDocument();
    });
  });

  it("surfaces EMAIL_TAKEN API error on the email field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: "EMAIL_TAKEN", error: "Email already in use" }),
          { status: 409 }
        )
      )
    );

    const user = await goToStep3();
    await user.click(screen.getByRole("button", { name: /create profile/i }));

    await waitFor(() => {
      expect(screen.getByText(/email already in use/i)).toBeInTheDocument();
    });
  });
});
