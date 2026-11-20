import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "@/components/error-boundary";

// AppShell renders *inside* the boundary at the real call site, so it is one
// of the components that can throw. The flag lets a test make it do exactly
// that, which is the scenario #1062 is about.
const shell = vi.hoisted(() => ({ throws: false }));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => {
    if (shell.throws) throw new Error("AppShell exploded");
    return <div data-testid="app-shell">{children}</div>;
  },
}));

import { AppShell } from "@/components/app-shell";

function Boom({ message = "child exploded" }: { message?: string }): never {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shell.throws = false;
    // React logs every caught render error, and componentDidCatch logs too.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <AppShell>
          <p>dashboard content</p>
        </AppShell>
      </ErrorBoundary>,
    );

    expect(screen.getByText("dashboard content")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("renders the fallback when the page content throws", () => {
    render(
      <ErrorBoundary>
        <AppShell>
          <Boom />
        </AppShell>
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  // The regression this fixes: the fallback used to re-render AppShell, so an
  // error originating in AppShell threw again during the fallback render —
  // this time with no ancestor boundary — blanking the page entirely.
  it("still degrades gracefully when AppShell itself is the error source", () => {
    shell.throws = true;

    expect(() =>
      render(
        <ErrorBoundary>
          <AppShell>
            <p>dashboard content</p>
          </AppShell>
        </ErrorBoundary>,
      ),
    ).not.toThrow();

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders a fallback that does not mount AppShell", () => {
    shell.throws = true;

    render(
      <ErrorBoundary>
        <AppShell>
          <p>dashboard content</p>
        </AppShell>
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByText("dashboard content")).not.toBeInTheDocument();
  });

  it("surfaces the error message in the details panel", () => {
    render(
      <ErrorBoundary>
        <Boom message="metrics request failed" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Error details")).toBeInTheDocument();
    expect(screen.getByText("metrics request failed")).toBeInTheDocument();
  });

  it('re-renders the children when "Try again" is pressed', () => {
    function Flaky({ fail }: { fail: boolean }) {
      if (fail) throw new Error("transient");
      return <p>recovered</p>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <Flaky fail />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    // The underlying cause is gone by the time the user retries.
    rerender(
      <ErrorBoundary>
        <Flaky fail={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("recovered")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});
