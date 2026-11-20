import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Components under test call useRouter/usePathname, but there is no Next.js
// app router mounted in jsdom. Provide an inert one for every test file.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// focus-trap-react refuses to activate in jsdom: without layout, nothing
// reports as tabbable. Render children directly so modals can be tested.
vi.mock('focus-trap-react', () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const storage = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  },
  configurable: true,
});
