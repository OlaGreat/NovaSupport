import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EmptyState } from "../empty-state";

describe("EmptyState", () => {
  it("renders default variant", () => {
    const { container } = render(
      <EmptyState title="No data" description="There is no data to display" />
    );
    expect(container).toMatchSnapshot();
  });

  it("renders no-supporters variant", () => {
    const { container } = render(
      <EmptyState
        variant="no-supporters"
        title="Be the first to support!"
        description="This profile hasn't received support yet."
      />
    );
    expect(container).toMatchSnapshot();
  });

  it("renders no-transactions variant", () => {
    const { container } = render(
      <EmptyState
        variant="no-transactions"
        title="No transactions yet"
        description="Transactions will appear here once supporters send funds."
      />
    );
    expect(container).toMatchSnapshot();
  });

  it("renders no-results variant", () => {
    const { container } = render(
      <EmptyState
        variant="no-results"
        title="No creators found"
        description="Try adjusting your search or check back later."
      />
    );
    expect(container).toMatchSnapshot();
  });

  it("renders with a call-to-action link", () => {
    const { container } = render(
      <EmptyState
        title="No results"
        description="Try adjusting your search"
        ctaLabel="Clear Search"
        ctaHref="/explore"
      />
    );
    expect(container).toMatchSnapshot();
  });
});
