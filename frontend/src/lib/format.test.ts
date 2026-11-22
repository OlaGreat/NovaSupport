import { describe, expect, it } from "vitest";
import { formatAmount } from "./format";

describe("formatAmount", () => {
  it("adds grouping separators for large amounts", () => {
    expect(formatAmount("1234567")).toContain(",");
  });

  it("caps fractional digits at 7", () => {
    const fraction = formatAmount("1.123456789").split(".")[1];
    expect(fraction.length).toBeLessThanOrEqual(7);
  });

  it("returns non-numeric input unchanged", () => {
    expect(formatAmount("not-a-number")).toBe("not-a-number");
  });

  it("keeps zero as zero", () => {
    expect(formatAmount("0")).toBe("0");
  });
});
