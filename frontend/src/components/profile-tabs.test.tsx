import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProfileTabs } from '@/components/profile-tabs';

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

describe('ProfileTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when there are no transactions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ transactions: [] }),
    }));

    render(<ProfileTabs username="stellar-dev" />);

    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
    expect(
      await screen.findByText('Be the first to support this creator!')
    ).toBeInTheDocument();
  });

  it('shows the same empty-state copy regardless of username', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ transactions: [] }),
    }));

    render(<ProfileTabs username="alice" />);

    expect(
      await screen.findByText('Be the first to support this creator!')
    ).toBeInTheDocument();
  });

  it('renders transaction list when transactions exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        transactions: [
          {
            id: '1',
            txHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            amount: '100',
            assetCode: 'XLM',
            createdAt: '2026-03-01T00:00:00Z',
            status: 'SUCCESS',
          },
        ],
      }),
    }));

    render(<ProfileTabs username="stellar-dev" />);

    expect(await screen.findByText('100 XLM')).toBeInTheDocument();
    expect(screen.queryByText('No support yet')).not.toBeInTheDocument();
    
    // Check that status is rendered as a badge
    expect(screen.getByText('SUCCESS')).toBeInTheDocument();
  });

  it('renders status badges with correct colors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        transactions: [
          {
            id: '1',
            txHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            amount: '100',
            assetCode: 'XLM',
            createdAt: '2026-03-01T00:00:00Z',
            status: 'SUCCESS',
          },
          {
            id: '2',
            txHash: 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321',
            amount: '50',
            assetCode: 'USDC',
            createdAt: '2026-03-02T00:00:00Z',
            status: 'PENDING',
          },
          {
            id: '3',
            txHash: '1111111111111111111111111111111111111111111111111111111111111111',
            amount: '25',
            assetCode: 'XLM',
            createdAt: '2026-03-03T00:00:00Z',
            status: 'FAILED',
          },
          {
            id: '4',
            txHash: '2222222222222222222222222222222222222222222222222222222222222222',
            amount: '75',
            assetCode: 'XLM',
            createdAt: '2026-03-04T00:00:00Z',
            status: 'UNKNOWN',
          },
        ],
      }),
    }));

    render(<ProfileTabs username="stellar-dev" />);

    // Check that all status badges are rendered
    expect(await screen.findByText('SUCCESS')).toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();

    // Check that badges have correct CSS classes for colors
    const successBadge = screen.getByText('SUCCESS');
    const pendingBadge = screen.getByText('PENDING');
    const failedBadge = screen.getByText('FAILED');
    const unknownBadge = screen.getByText('UNKNOWN');

    expect(successBadge).toHaveClass('bg-green-100', 'text-green-800');
    expect(pendingBadge).toHaveClass('bg-yellow-100', 'text-yellow-800');
    expect(failedBadge).toHaveClass('bg-red-100', 'text-red-800');
    expect(unknownBadge).toHaveClass('bg-gray-100', 'text-gray-800');
  });

  it('renders the badges empty state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ transactions: [] }),
    }));

    render(<ProfileTabs username="stellar-dev" />);

    // Click on the badges tab
    const badgesTab = screen.getByText('Badges');
    fireEvent.click(badgesTab);

    expect(await screen.findByText('No badges yet')).toBeInTheDocument();
    expect(
      screen.getByText('Achievement badges will appear here once earned.')
    ).toBeInTheDocument();
  });
});
