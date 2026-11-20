import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { TransactionResultModal } from "../transaction-result-modal";

const TX_HASH = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";

vi.mock("@/lib/stellar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar")>()),
  stellarConfig: { horizonUrl: "https://horizon-testnet.stellar.org" },
  withStellarRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const defaultProps = {
  txHash: TX_HASH,
  amount: "5",
  assetCode: "XLM",
  recipientDisplayName: "Alice",
  isOpen: true,
  onClose: vi.fn(),
};

function mockHorizonResponse(status: number, body: object) {
  vi.spyOn(global, "fetch").mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe("TransactionResultModal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders with Confirming status initially", () => {
    const { container } = render(<TransactionResultModal {...defaultProps} />);
    expect(screen.getByText(/Support Sent!/i)).toBeInTheDocument();
    expect(screen.getByText(/Confirming\.\.\./i)).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });

  it("shows truncated tx hash", () => {
    render(<TransactionResultModal {...defaultProps} />);
    const truncated = `${TX_HASH.slice(0, 8)}...${TX_HASH.slice(-8)}`;
    expect(screen.getByText(truncated)).toBeInTheDocument();
  });

  it("shows a link to Stellar Expert", () => {
    render(<TransactionResultModal {...defaultProps} />);
    const link = screen.getByRole("link", { name: /View on Explorer/i });
    expect(link).toHaveAttribute(
      "href",
      `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`,
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("transitions to Confirmed ✓ when Horizon returns successful: true", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ successful: true }),
    } as Response);

    render(<TransactionResultModal {...defaultProps} />);

    await waitFor(
      () => expect(screen.getByText(/Confirmed ✓/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it("transitions to Finalized after confirmation", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ successful: true }),
    } as Response);

    render(<TransactionResultModal {...defaultProps} />);

    await waitFor(() => expect(screen.getByText(/Confirmed ✓/i)).toBeInTheDocument(), {
      timeout: 5000,
    });

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    await waitFor(() =>
      expect(screen.getByText(/Finalized/i)).toBeInTheDocument(),
    );
  });

  it("shows Failed status when Horizon reports unsuccessful: false", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ successful: false }),
    } as Response);

    render(<TransactionResultModal {...defaultProps} />);

    // Exact match: the status label is "Failed", while the message below it
    // ("Transaction failed on-chain.") would also match a loose /Failed/i.
    await waitFor(
      () => expect(screen.getByText("Failed")).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(screen.getByText(/Transaction failed on-chain/i)).toBeInTheDocument();
  });

  it("shows error message when Horizon fetch throws", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("Network error"));

    render(<TransactionResultModal {...defaultProps} />);

    await waitFor(
      () => expect(screen.getByText(/Failed/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(
      screen.getByText(/Couldn't confirm transaction/i),
    ).toBeInTheDocument();
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <TransactionResultModal {...defaultProps} isOpen={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when txHash is null", () => {
    const { container } = render(
      <TransactionResultModal {...defaultProps} txHash={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<TransactionResultModal {...defaultProps} onClose={onClose} />);
    const backdrop = document.querySelector(".absolute.inset-0") as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(<TransactionResultModal {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the optional note when provided", () => {
    render(
      <TransactionResultModal
        {...defaultProps}
        note="Thank you for your support!"
      />,
    );
    expect(screen.getByText("Thank you for your support!")).toBeInTheDocument();
  });

  it("does not render the note section when note is omitted", () => {
    render(<TransactionResultModal {...defaultProps} note={undefined} />);
    expect(
      screen.queryByText("Thank you for your support!"),
    ).not.toBeInTheDocument();
  });
});
