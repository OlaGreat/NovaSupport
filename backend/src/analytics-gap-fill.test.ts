import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fillGaps, utcDaysInRange } from "./analytics.js";

// #1496: the gap-fill walk must step through UTC days, matching the UTC date
// truncation in SQL, even when the server runs in a zone with DST.
describe("analytics gap-fill on a non-UTC server (#1496)", () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    // US DST ends on 2025-11-02, so that local day is 25 hours long.
    process.env.TZ = "America/New_York";
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  const labels = (days: Date[]) => days.map((d) => d.toISOString().slice(0, 10));

  it("lists every UTC day across a DST change exactly once", () => {
    const days = utcDaysInRange(
      new Date("2025-11-01T23:30:00Z"),
      new Date("2025-11-04T23:30:00Z"),
    );
    assert.deepEqual(labels(days), ["2025-11-01", "2025-11-02", "2025-11-03", "2025-11-04"]);
  });

  it("lists every UTC day across the spring DST change exactly once", () => {
    const days = utcDaysInRange(
      new Date("2025-03-08T03:30:00Z"),
      new Date("2025-03-11T03:30:00Z"),
    );
    assert.deepEqual(labels(days), ["2025-03-08", "2025-03-09", "2025-03-10", "2025-03-11"]);
  });

  it("includes the end day even when it starts earlier in the day than start", () => {
    const days = utcDaysInRange(
      new Date("2025-01-01T14:00:00Z"),
      new Date("2025-01-03T10:00:00Z"),
    );
    assert.deepEqual(labels(days), ["2025-01-01", "2025-01-02", "2025-01-03"]);
  });

  it("keeps a real day's data in fillGaps when DST falls inside the range", () => {
    const filled = fillGaps(
      [
        { date: new Date("2025-11-02T00:00:00Z"), total: 40, txCount: 2 },
        { date: new Date("2025-11-03T00:00:00Z"), total: 10, txCount: 1 },
      ],
      "daily",
      new Date("2025-11-01T23:30:00Z"),
      new Date("2025-11-04T23:30:00Z"),
    );
    assert.deepEqual(
      filled.data.map((d) => [d.date.toISOString().slice(0, 10), d.amount]),
      [
        ["2025-11-01", "0"],
        ["2025-11-02", "40"],
        ["2025-11-03", "10"],
        ["2025-11-04", "0"],
      ],
    );
  });
});
