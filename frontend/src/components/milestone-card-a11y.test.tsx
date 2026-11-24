import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MilestoneCard } from "./milestone-card";

const base = {
  id: "m1",
  title: "New laptop",
  targetAmount: "200",
  currentAmount: "50",
  assetCode: "XLM",
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("MilestoneCard accessibility and malformed amounts", () => {
  it("exposes a named progressbar with value attributes", () => {
    render(<MilestoneCard milestone={base} />);
    const bar = screen.getByRole("progressbar", {
      name: "Funding progress for New laptop",
    });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
  });

  it("never renders NaN for malformed amounts", () => {
    const { container } = render(
      <MilestoneCard milestone={{ ...base, currentAmount: "", targetAmount: "abc" }} />,
    );
    expect(container.textContent).not.toContain("NaN");
  });
});
