import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/app-shell";

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: any) => <img src={src} alt={alt} />,
}));

vi.mock("@/lib/stellar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar")>()),
  getNetworkLabel: vi.fn(() => "Testnet"),
}));

vi.mock("@/components/wallet-connect", () => ({
  WalletConnect: () => <div data-testid="wallet-connect">WalletConnect</div>,
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Toggle</button>,
}));

const RESULTS = [
  {
    username: "stellar-dev",
    displayName: "Stellar Dev",
    avatarUrl: null,
    bio: "Building on Stellar.",
  },
];

/**
 * fetch double that never settles on its own, so a test can hold the request
 * in flight and observe what the UI renders while it is pending.
 */
function deferredFetch() {
  let resolveWith: (body: unknown) => void = () => {};
  const fetchMock = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveWith = (body: unknown) =>
          resolve({ ok: true, json: async () => body });
      }),
  );
  return { fetchMock, resolve: (body: unknown) => resolveWith(body) };
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Search creators..."), {
    target: { value },
  });
}

describe("AppShell search dropdown", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows "Searching..." while the request is still in flight', async () => {
    const { fetchMock } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell>content</AppShell>);
    typeQuery("stellar");

    // Visible immediately, before the 300ms debounce has even elapsed.
    expect(screen.getByText("Searching...")).toBeInTheDocument();

    // ...and still visible once the request itself is outstanding.
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.getByText("Searching...")).toBeInTheDocument();
  });

  it("replaces the loading state with results once the request resolves", async () => {
    const { fetchMock, resolve } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell>content</AppShell>);
    typeQuery("stellar");

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("Searching...")).toBeInTheDocument();

    await act(async () => {
      resolve(RESULTS);
    });

    await waitFor(() =>
      expect(screen.getByText("Stellar Dev")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Searching...")).not.toBeInTheDocument();
  });

  it('shows "No results found" when the search returns nothing', async () => {
    const { fetchMock, resolve } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell>content</AppShell>);
    typeQuery("nobody");

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      resolve([]);
    });

    await waitFor(() =>
      expect(screen.getByText("No results found")).toBeInTheDocument(),
    );
  });

  it("keeps the dropdown closed while the query is empty", async () => {
    const { fetchMock } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell>content</AppShell>);

    expect(screen.queryByText("Searching...")).not.toBeInTheDocument();

    // Whitespace alone is not a query either.
    typeQuery("   ");
    expect(screen.queryByText("Searching...")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes the dropdown again when the query is cleared", async () => {
    const { fetchMock, resolve } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell>content</AppShell>);
    typeQuery("stellar");
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      resolve(RESULTS);
    });
    await waitFor(() =>
      expect(screen.getByText("Stellar Dev")).toBeInTheDocument(),
    );

    typeQuery("");
    expect(screen.queryByText("Stellar Dev")).not.toBeInTheDocument();
    expect(screen.queryByText("Searching...")).not.toBeInTheDocument();
  });

  it("closes the dropdown when the request fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<AppShell>content</AppShell>);
    typeQuery("stellar");
    expect(screen.getByText("Searching...")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() =>
      expect(screen.queryByText("Searching...")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("No results found")).not.toBeInTheDocument();
    consoleError.mockRestore();
  });
});
