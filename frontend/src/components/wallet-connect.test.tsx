import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WalletConnect } from '@/components/wallet-connect';

// Mock @stellar/freighter-api so the Freighter adapter's dynamic import works
vi.mock('@stellar/freighter-api', () => ({
  getAddress: vi.fn(),
  isAllowed: vi.fn(),
  setAllowed: vi.fn(),
  signTransaction: vi.fn(),
}));

// Mock @/lib/config
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  API_BASE_URL: 'http://localhost:4000',
  STELLAR_NETWORK: 'TESTNET',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  CONTRACT_ID: '',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
}));

import { getAddress, isAllowed, setAllowed } from '@stellar/freighter-api';

const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('WalletConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Make Freighter "available" for tests that need it
    (window as any).freighter = true;
  });

  it('renders wallet selector when disconnected', () => {
    render(<WalletConnect />);

    expect(screen.getByText('Wallet')).toBeInTheDocument();
    expect(screen.getByText('Choose a wallet to connect.')).toBeInTheDocument();
    expect(screen.getByText('Freighter')).toBeInTheDocument();
    expect(screen.getByText('Click to connect')).toBeInTheDocument();
  });

  it('connects and shows address', async () => {
    (isAllowed as any).mockResolvedValue({ isAllowed: true });
    (getAddress as any).mockResolvedValue({ address: TEST_ADDRESS, error: null });

    render(<WalletConnect />);

    const button = screen.getByRole('button', { name: /freighter/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/Connected:/)).toBeInTheDocument();
    });
    expect(screen.getByText(/GAAAAA/)).toBeInTheDocument();
  });

  it('dispatches wallet-connected after storing the address', async () => {
    (isAllowed as any).mockResolvedValue({ isAllowed: true });
    (getAddress as any).mockResolvedValue({ address: TEST_ADDRESS, error: null });
    const storedAddresses: (string | null)[] = [];
    const listener = () => storedAddresses.push(localStorage.getItem('walletAddress'));
    window.addEventListener('wallet-connected', listener);

    try {
      render(<WalletConnect />);
      fireEvent.click(screen.getByRole('button', { name: /freighter/i }));

      await waitFor(() => {
        expect(storedAddresses).toEqual([TEST_ADDRESS]);
      });
    } finally {
      window.removeEventListener('wallet-connected', listener);
    }
  });

  it('persists connection across re-renders', async () => {
    localStorage.setItem('walletAddress', TEST_ADDRESS);
    localStorage.setItem('walletId', 'freighter');

    render(<WalletConnect />);

    await waitFor(() => {
      expect(screen.getByText(/Connected:/)).toBeInTheDocument();
    });
  });

  it('disconnects and clears state', async () => {
    (isAllowed as any).mockResolvedValue({ isAllowed: true });
    (getAddress as any).mockResolvedValue({ address: TEST_ADDRESS, error: null });

    render(<WalletConnect />);

    const connectBtn = screen.getByRole('button', { name: /freighter/i });
    fireEvent.click(connectBtn);

    await waitFor(() => {
      expect(screen.getByText(/Connected:/)).toBeInTheDocument();
    });

    const disconnectBtn = screen.getByText('Disconnect');
    fireEvent.click(disconnectBtn);

    expect(screen.getByText('Choose a wallet to connect.')).toBeInTheDocument();
    expect(screen.queryByText(/Connected:/)).not.toBeInTheDocument();
  });

  it('shows fallback when no wallets detected', () => {
    (window as any).freighter = undefined;

    render(<WalletConnect />);

    expect(screen.getByText(/No Stellar wallets detected/)).toBeInTheDocument();
    expect(screen.getByText('Install Freighter')).toBeInTheDocument();
  });

  it('shows error on connection failure', async () => {
    const errorMsg = 'User declined request';
    (isAllowed as any).mockResolvedValue({ isAllowed: true });
    (getAddress as any).mockResolvedValue({ address: '', error: errorMsg });

    render(<WalletConnect />);

    const button = screen.getByRole('button', { name: /freighter/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(errorMsg)).toBeInTheDocument();
    });
    // The specific error replaces the generic status line rather than joining it.
    expect(screen.queryByText('Connection failed.')).not.toBeInTheDocument();
  });

  it('renders multiple wallet options when multiple detected', () => {
    (window as any).albedo = true;
    (window as any).lobstr = true;

    render(<WalletConnect />);

    expect(screen.getByText('Freighter')).toBeInTheDocument();
    expect(screen.getByText('Albedo')).toBeInTheDocument();
    expect(screen.getByText('Lobstr')).toBeInTheDocument();
  });
});
