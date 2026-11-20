import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import DashboardLoading from "./loading";

describe("DashboardLoading (#1286)", () => {
  it("renders one placeholder per summary stat card on the page", () => {
    render(<DashboardLoading />);
    expect(screen.getAllByTestId("stat-card-skeleton")).toHaveLength(4);
  });

  it("does not use the non-existent steel shade utilities", () => {
    const { container } = render(<DashboardLoading />);
    expect(container.querySelector('[class*="steel-"]')).toBeNull();
  });
});
