import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ProfileTabs } from '@/components/profile-tabs';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, initial, animate, exit, ...props }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function tx(id: string, amount: string, createdAt: string) {
  return {
    id,
    txHash: id.repeat(64).slice(0, 64),
    amount,
    assetCode: 'XLM',
    createdAt,
    status: 'SUCCESS',
  };
}

describe('ProfileTabs ARIA tab semantics (#1451)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ transactions: [], badges: [] }),
    }));
  });

  it('exposes a tablist with tabs wired to their tabpanel', async () => {
    render(<ProfileTabs username="stellar-dev" />);

    const tablist = screen.getByRole('tablist', { name: 'Profile sections' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(2);

    const historyTab = screen.getByRole('tab', { name: /support history/i });
    const badgesTab = screen.getByRole('tab', { name: /badges/i });
    expect(historyTab).toHaveAttribute('aria-selected', 'true');
    expect(historyTab).toHaveAttribute('tabindex', '0');
    expect(badgesTab).toHaveAttribute('aria-selected', 'false');
    expect(badgesTab).toHaveAttribute('tabindex', '-1');

    const panel = screen.getByRole('tabpanel');
    expect(historyTab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', historyTab.id);
    await screen.findByText('No transactions yet');
  });

  it('updates aria-selected and the panel when a tab is clicked', async () => {
    render(<ProfileTabs username="stellar-dev" />);

    const badgesTab = screen.getByRole('tab', { name: /badges/i });
    fireEvent.click(badgesTab);

    expect(badgesTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /support history/i })).toHaveAttribute('aria-selected', 'false');
    const panel = screen.getByRole('tabpanel');
    expect(badgesTab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', badgesTab.id);
    await screen.findByText('No badges yet');
  });

  it('moves selection and focus with the arrow, Home and End keys', async () => {
    render(<ProfileTabs username="stellar-dev" />);

    const historyTab = screen.getByRole('tab', { name: /support history/i });
    const badgesTab = screen.getByRole('tab', { name: /badges/i });

    fireEvent.keyDown(historyTab, { key: 'ArrowRight' });
    expect(badgesTab).toHaveAttribute('aria-selected', 'true');
    expect(badgesTab).toHaveFocus();

    fireEvent.keyDown(badgesTab, { key: 'ArrowRight' });
    expect(historyTab).toHaveAttribute('aria-selected', 'true');
    expect(historyTab).toHaveFocus();

    fireEvent.keyDown(historyTab, { key: 'End' });
    expect(badgesTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(badgesTab, { key: 'Home' });
    expect(historyTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(historyTab, { key: 'ArrowLeft' });
    expect(badgesTab).toHaveAttribute('aria-selected', 'true');
    await screen.findByText('No badges yet');
  });
});

describe('ProfileTabs custom "From" date uses the local timezone (#1450)', () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    // Pin a non-UTC zone so the test is meaningful even when CI runs in UTC.
    // A bare "YYYY-MM-DD" parsed as UTC midnight would land at 09:00 local here.
    process.env.TZ = 'Asia/Tokyo';
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('includes early-morning local transactions on the start day and excludes the previous local day', async () => {
    const earlyOnStartDay = new Date(2026, 2, 10, 0, 30).toISOString();
    const lateOnPreviousDay = new Date(2026, 2, 9, 23, 30).toISOString();
    const laterOnStartDay = new Date(2026, 2, 10, 12, 0).toISOString();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        transactions: [
          tx('a', '11', earlyOnStartDay),
          tx('b', '22', lateOnPreviousDay),
          tx('c', '33', laterOnStartDay),
        ],
      }),
    }));

    const { container } = render(<ProfileTabs username="stellar-dev" />);
    await screen.findByText('11 XLM');

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const [fromInput] = Array.from(container.querySelectorAll('input[type="date"]'));
    fireEvent.change(fromInput, { target: { value: '2026-03-10' } });

    expect(screen.getByText('11 XLM')).toBeInTheDocument();
    expect(screen.getByText('33 XLM')).toBeInTheDocument();
    expect(screen.queryByText('22 XLM')).not.toBeInTheDocument();
  });
});
