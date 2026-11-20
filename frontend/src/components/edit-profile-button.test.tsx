import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { EditProfileButton } from '@/components/edit-profile-button';

const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('EditProfileButton', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders nothing when no wallet is connected', () => {
    render(<EditProfileButton username="stellar-dev" walletAddress={OWNER} />);
    expect(screen.queryByRole('link', { name: /edit profile/i })).not.toBeInTheDocument();
  });

  it('renders the edit link when the stored wallet is the owner', () => {
    localStorage.setItem('walletAddress', OWNER);
    render(<EditProfileButton username="stellar-dev" walletAddress={OWNER} />);
    expect(screen.getByRole('link', { name: /edit profile/i })).toHaveAttribute(
      'href',
      '/profile/stellar-dev/edit',
    );
  });

  it('shows the edit link after the owner connects mid-session (#1449)', () => {
    render(<EditProfileButton username="stellar-dev" walletAddress={OWNER} />);
    expect(screen.queryByRole('link', { name: /edit profile/i })).not.toBeInTheDocument();

    act(() => {
      localStorage.setItem('walletAddress', OWNER);
      window.dispatchEvent(new Event('wallet-connected'));
    });

    expect(screen.getByRole('link', { name: /edit profile/i })).toBeInTheDocument();
  });

  it('hides the edit link after the owner disconnects', () => {
    localStorage.setItem('walletAddress', OWNER);
    render(<EditProfileButton username="stellar-dev" walletAddress={OWNER} />);
    expect(screen.getByRole('link', { name: /edit profile/i })).toBeInTheDocument();

    act(() => {
      localStorage.removeItem('walletAddress');
      window.dispatchEvent(new Event('wallet-disconnected'));
    });

    expect(screen.queryByRole('link', { name: /edit profile/i })).not.toBeInTheDocument();
  });

  it('does not show the edit link when a different wallet connects', () => {
    render(<EditProfileButton username="stellar-dev" walletAddress={OWNER} />);

    act(() => {
      localStorage.setItem('walletAddress', OTHER);
      window.dispatchEvent(new Event('wallet-connected'));
    });

    expect(screen.queryByRole('link', { name: /edit profile/i })).not.toBeInTheDocument();
  });

  it('re-checks ownership when the wallet changes in another tab', () => {
    render(<EditProfileButton username="stellar-dev" walletAddress={OWNER} />);

    act(() => {
      localStorage.setItem('walletAddress', OWNER);
      window.dispatchEvent(new StorageEvent('storage', { key: 'walletAddress' }));
    });

    expect(screen.getByRole('link', { name: /edit profile/i })).toBeInTheDocument();
  });
});
