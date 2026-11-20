import { useEffect } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SupportPanel } from '@/components/support-panel';
import { signTransaction } from '@stellar/freighter-api';
import { buildSupportIntent, horizonServer } from '@/lib/stellar';

vi.mock('@stellar/freighter-api', () => ({
  getAddress: vi.fn(),
  isAllowed: vi.fn(),
  setAllowed: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  Asset: {
    native: vi.fn(() => ({ type: 'native' })),
  },
  BASE_FEE: '100',
  // stellar.ts constructs `new Horizon.Server(...)` at module load.
  Horizon: { Server: vi.fn(() => ({})) },
  Transaction: vi.fn(),
  FeeBumpTransaction: vi.fn(),
  TransactionBuilder: {
    fromXDR: vi.fn(() => ({ mocked: true })),
  },
}));

vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  API_BASE_URL: 'http://localhost:4000',
  STELLAR_NETWORK: 'TESTNET',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  CONTRACT_ID: '',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
}));

vi.mock('@/lib/stellar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stellar')>()),
  buildSupportIntent: vi.fn(),
  buildPathPaymentIntent: vi.fn(),
  getNetworkLabel: vi.fn(() => 'Testnet'),
  horizonServer: {
    submitTransaction: vi.fn(),
    loadAccount: vi.fn().mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '100.0000000' }],
    }),
    strictSendPaths: vi.fn(() => ({
      call: vi.fn().mockResolvedValue({ records: [] }),
    })),
  },
  stellarConfig: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    stellarNetwork: 'TESTNET',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
}));

vi.mock('./wallet-connect', () => ({
  WalletConnect: ({ onConnect }: { onConnect?: (address: string) => void }) => {
    useEffect(() => {
      onConnect?.('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    }, [onConnect]);
    return <div data-testid="wallet-connect-mock">WalletConnect Mock</div>;
  },
}));

const showToast = vi.fn();
vi.mock('@/lib/use-toast', () => ({
  useToast: () => ({ showToast }),
}));

describe('SupportPanel', () => {
  const mockProps = {
    walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    acceptedAssets: [{ code: 'XLM' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // SupportPanel resolves a wallet adapter from the persisted walletId
    // before it will sign anything.
    localStorage.setItem('walletId', 'freighter');
    // clearAllMocks() clears calls but not implementations, so restore the
    // default funded account or a previous test's override leaks in here.
    vi.mocked(horizonServer.loadAccount).mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '100.0000000' }],
    } as never);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('submits a signed transaction and shows the transaction hash', async () => {
    vi.mocked(buildSupportIntent).mockResolvedValue('unsigned-xdr');
    vi.mocked(signTransaction).mockResolvedValue({
      signedTxXdr: 'signed-xdr',
      signerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    vi.mocked(horizonServer.submitTransaction).mockResolvedValue({
      hash: '1234567890abcdef1234567890abcdef',
    } as never);

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Send Support/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Send Support/i }));
    // Success opens the transaction result modal, which shows the truncated hash.
    await waitFor(
      () => expect(screen.getByText('12345678...90abcdef')).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the in-flight "Sending…" label while the signing prompt is open', async () => {
    vi.mocked(buildSupportIntent).mockResolvedValue('unsigned-xdr');
    // Never resolves — simulates Freighter prompt staying open
    vi.mocked(signTransaction).mockReturnValue(new Promise(() => {}));

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Send Support/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Send Support/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Sending/i })).toBeDisabled(),
    );
  });

  it('shows a readable error when the user rejects the transaction in Freighter', async () => {
    vi.mocked(buildSupportIntent).mockResolvedValue('unsigned-xdr');
    vi.mocked(signTransaction).mockResolvedValue({
      error: 'User declined signing the transaction',
    } as never);

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Send Support/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Send Support/i }));
    await waitFor(
      () =>
        expect(showToast).toHaveBeenCalledWith(
          'You declined the transaction in your wallet.',
          'error',
        ),
      { timeout: 3000 },
    );
  });

  it('shows a readable error when Freighter is not installed', async () => {
    vi.mocked(buildSupportIntent).mockResolvedValue('unsigned-xdr');
    vi.mocked(signTransaction).mockRejectedValue(new Error('Freighter is not installed'));

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Send Support/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Send Support/i }));
    await waitFor(
      () => expect(showToast).toHaveBeenCalledWith('Freighter is not installed', 'error'),
      { timeout: 3000 },
    );
  });

  it('surfaces a failed Horizon submission as a readable error toast', async () => {
    vi.mocked(buildSupportIntent).mockResolvedValue('unsigned-xdr');
    vi.mocked(signTransaction).mockResolvedValue({
      signedTxXdr: 'signed-xdr',
      signerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    vi.mocked(horizonServer.submitTransaction).mockRejectedValue(
      new Error('Transaction expired'),
    );

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Send Support/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Send Support/i }));
    await waitFor(
      () => expect(showToast).toHaveBeenCalledWith('Transaction expired', 'error'),
      { timeout: 3000 },
    );
  });

  it('button is disabled while the signing prompt is open', async () => {
    vi.mocked(buildSupportIntent).mockResolvedValue('unsigned-xdr');
    vi.mocked(signTransaction).mockReturnValue(new Promise(() => {}));

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Send Support/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Send Support/i }));
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Sending/i });
      expect(btn).toBeDisabled();
    });
  });

  it('renders payment asset selector when connected', async () => {
    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByText('Pay with')).toBeInTheDocument());
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('shows empty wallet message when connected wallet has no balances', async () => {
    vi.mocked(horizonServer.loadAccount).mockResolvedValue({
      balances: [],
    } as never);

    render(<SupportPanel {...mockProps} />);
    await waitFor(() =>
      expect(
        screen.getByText('Your wallet has no supported assets. Fund your wallet to continue.'),
      ).toBeInTheDocument(),
    );
  });

  it('renders recurring support toggle', async () => {
    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByText('Make it recurring')).toBeInTheDocument());
  });

  it('copies recipient address and shows inline feedback', async () => {
    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByText('Recipient Address')).toBeInTheDocument());
    fireEvent.click(
      screen.getByRole('button', { name: /copy recipient address to clipboard/i }),
    );

    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockProps.walletAddress);
  });

  it('supports Ctrl/Cmd+C on focused recipient address', async () => {
    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByText('Recipient Address')).toBeInTheDocument());
    const recipientAddress = screen.getByLabelText(/Recipient Stellar wallet address/i);
    recipientAddress.focus();
    fireEvent.keyDown(recipientAddress, { key: 'c', metaKey: true });

    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockProps.walletAddress);
  });

  it('still shows the success modal when the backend reports a duplicate (409)', async () => {
    const horizonHash = 'aabbccdd11223344aabbccdd11223344';
    const existingHash = 'deadbeef12345678deadbeef12345678';

    vi.mocked(buildSupportIntent).mockResolvedValue('unsigned-xdr');
    vi.mocked(signTransaction).mockResolvedValue({
      signedTxXdr: 'signed-xdr',
      signerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    vi.mocked(horizonServer.submitTransaction).mockResolvedValue({
      hash: horizonHash,
    } as never);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 409,
      headers: new Headers(),
      json: async () => ({ existingTxHash: existingHash }),
    } as Response);

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Send Support/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Send Support/i }));

    await waitFor(
      () => expect(screen.getByText(/Support Sent!/i)).toBeInTheDocument(),
      { timeout: 4000 },
    );

    // The panel reports the hash Horizon accepted; a duplicate response from
    // the backend must not turn the successful submission into an error.
    expect(
      screen.getByText(`${horizonHash.slice(0, 8)}...${horizonHash.slice(-8)}`),
    ).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), 'error');
  });

  it('does not show an error panel when backend returns 409', async () => {
    vi.mocked(buildSupportIntent).mockResolvedValue('unsigned-xdr');
    vi.mocked(signTransaction).mockResolvedValue({
      signedTxXdr: 'signed-xdr',
      signerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    vi.mocked(horizonServer.submitTransaction).mockResolvedValue({
      hash: 'somehash1234567890abcdef12345678',
    } as never);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 409,
      headers: new Headers(),
      json: async () => ({ existingTxHash: 'existinghash1234567890abcdef1234' }),
    } as Response);

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Send Support/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Send Support/i }));

    await waitFor(
      () => expect(screen.getByText(/Support Sent!/i)).toBeInTheDocument(),
      { timeout: 4000 },
    );

    // No error panel should be shown
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  it('ignores a stale balance response for a previous visitor address (#1448)', async () => {
    const firstAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const secondAddress = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const staleResolvers: Array<(value: unknown) => void> = [];

    vi.mocked(horizonServer.loadAccount).mockImplementation(((address: string) => {
      if (address === firstAddress) {
        // Hold the first account's requests open until after the switch.
        return new Promise((resolve) => staleResolvers.push(resolve));
      }
      return Promise.resolve({
        balances: [{ asset_type: 'native', balance: '50.0000000' }],
      });
    }) as never);

    render(<SupportPanel {...mockProps} />);
    await waitFor(() => expect(staleResolvers.length).toBeGreaterThan(0));

    // Switch wallets while the first address's requests are still in flight.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wallet-connected', { detail: { address: secondAddress } }),
      );
    });
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('50.00'));

    // The old account's responses now arrive late and must be discarded.
    await act(async () => {
      staleResolvers.forEach((resolve) =>
        resolve({ balances: [{ asset_type: 'native', balance: '999.0000000' }] }),
      );
    });

    expect(screen.getByRole('combobox')).toHaveTextContent('50.00');
    expect(screen.getByRole('combobox')).not.toHaveTextContent('999.00');
  });
});
