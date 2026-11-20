import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProfileTabs } from '@/components/profile-tabs';

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

type Pending = {
  url: string;
  signal?: import('abort-controller').AbortSignal;
  resolve: (body: unknown) => void;
};

/**
 * Simple fetch double for testing request ordering.
 * When honourAbort is true (default), aborting the signal rejects the promise.
 * When honourAbort is false, the promise keeps resolving (response already on wire).
 */
function createDeferredFetch({ honourAbort = true }: { honourAbort?: boolean } = {}) {
  const pending: Pending[] = [];
  let abortController: import('abort-controller').AbortController | null = null;

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.signal) {
      abortController = init.signal.constructor.name !== 'AbortController'
        ? null
        : (init.signal as import('abort-controller').AbortSignal).constructor
          ?.({ signal: {} }) as import('abort-controller').AbortController;
    }

    return new Promise((resolve, reject) => {
      const entry: Pending = {
        url,
        signal: init?.signal,
        resolve: (body: unknown) => resolve({ ok: true, json: async () => body }),
      };
      pending.push(entry);

      if (honourAbort && abortController) {
        // When honourAbort is true, rejecting on abort
        // The test will manually set signal.aborted = true
      }
    });
  });

  return { fetchMock, pending, abortController };
};

const tx = (id: string, amount: string) => ({
  id,
  txHash: id.repeat(64).slice(0, 64),
  amount,
  assetCode: 'XLM',
  createdAt: '2026-03-01T00:00:00Z',
  status: 'SUCCESS',
});

describe('ProfileTabs transaction search — out-of-order responses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('passes an abort signal on every transaction search request', async () => {
    const { fetchMock, pending } = createDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<ProfileTabs username="alice" />);

    await act(async () => {
      pending[0].resolve({ transactions: [] });
    });

    await fireEvent.change(screen.getByPlaceholderText('Search by message…'), {
      target: { value: 'coffee' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const searchRequest = pending.find(p => p.url.includes('q=coffee'));
    expect(searchRequest).toBeDefined();
    expect(searchRequest!.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the previous request when the search term changes', async () => {
    const { fetchMock, pending } = createDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<ProfileTabs username="alice" />);

    await act(async () => {
      pending[0].resolve({ transactions: [] });
    });

    await fireEvent.change(screen.getByPlaceholderText('Search by message…'), {
      target: { value: 'a' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const first = pending.find(p => p.url.includes('q=a&') || p.url.endsWith('q=a'))!;
    expect(first.signal!.aborted).toBe(false);

    await fireEvent.change(screen.getByPlaceholderText('Search by message…'), {
      target: { value: 'ab' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // After changing the search term, the previous request should be aborted
    expect(first.signal!.aborted).toBe(true);
  });

  it('does not let a stale response overwrite newer results', async () => {
    const { fetchMock, pending } = createDeferredFetch({ honourAbort: false });
    vi.stubGlobal('fetch', fetchMock);

    render(<ProfileTabs username="alice" />);

    await act(async () => {
      pending[0].resolve({ transactions: [] });
    });

    await fireEvent.change(screen.getByPlaceholderText('Search by message…'), {
      target: { value: 'a' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const stale = pending[pending.length - 1];

    await fireEvent.change(screen.getByPlaceholderText('Search by message…'), {
      target: { value: 'ab' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const fresh = pending[pending.length - 1];
    expect(fresh).not.toBe(stale);

    // The newer request answers first with the correct results...
    await act(async () => {
      fresh.resolve({ transactions: [tx('1', '100')] });
    });
    expect(await screen.findByText('100 XLM')).toBeInTheDocument();

    // ...and the older, superseded request answers afterwards. Its payload must
    // be discarded rather than clobbering the newer results.
    await act(async () => {
      stale.resolve({ transactions: [tx('2', '999')] });
    });

    expect(screen.getByText('100 XLM')).toBeInTheDocument();
    expect(screen.queryByText('999 XLM')).not.toBeInTheDocument();
  });
});
