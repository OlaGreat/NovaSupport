"use client";

import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { WalletConnect } from "@/components/wallet-connect";
import { ThemeToggle } from "@/components/theme-toggle";
import { getNetworkLabel } from "@/lib/stellar";
import { API_BASE_URL } from "@/lib/config";

type SearchResult = {
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  bio: string;
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const [failedAvatarUrls, setFailedAvatarUrls] = useState<Set<string>>(
    () => new Set(),
  );
  const searchRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout>();
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        searchRef.current &&
        !searchRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false);
      }
    }

    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setShowDropdown(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    if (!searchQuery.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }

    // Open the dropdown up front. It used to be opened only once results came
    // back, in the same tick that cleared isSearching — so the "Searching…"
    // state was never actually rendered for a fresh search (#1063).
    setIsSearching(true);
    setShowDropdown(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    timeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/profiles/search?q=${encodeURIComponent(searchQuery)}`,
          { signal: controller.signal },
        );

        if (response.ok) {
          const data = await response.json();
          setSearchResults(data);
          setActiveResultIndex(-1);
        } else {
          // A failed lookup closes the dropdown rather than claiming
          // "No results found", which would misreport the failure.
          setSearchResults([]);
          setShowDropdown(false);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Search error:", error);
        setSearchResults([]);
        setShowDropdown(false);
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    }, 300);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      controller.abort();
    };
  }, [searchQuery]);

  function handleResultClick() {
    setShowDropdown(false);
    setSearchQuery("");
    setActiveResultIndex(-1);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && searchResults.length > 0) {
      event.preventDefault();
      setActiveResultIndex((index) => (index + 1) % searchResults.length);
    } else if (event.key === "ArrowUp" && searchResults.length > 0) {
      event.preventDefault();
      setActiveResultIndex((index) =>
        index <= 0 ? searchResults.length - 1 : index - 1,
      );
    } else if (event.key === "Enter" && activeResultIndex >= 0) {
      const result = searchResults[activeResultIndex];
      if (result) {
        event.preventDefault();
        router.push(`/profile/${result.username}`);
        handleResultClick();
      }
    }
  }

  return (
    <main className="min-h-screen px-6 py-8 sm:px-10 bg-ink dark:bg-black transition-colors">
      <div className="mx-auto max-w-6xl">
        <header className="mb-10 flex flex-col gap-6 rounded-[2rem] border border-white/10 dark:border-white/20 bg-grid bg-[size:26px_26px] bg-center px-6 py-6 shadow-2xl shadow-black/25 dark:shadow-black/50">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <Link
                href="/"
                className="text-2xl font-semibold tracking-tight text-white"
              >
                NovaSupport
              </Link>
              <p className="mt-2 max-w-2xl text-sm text-sky/80 dark:text-sky/90">
                Stellar-native creator support on {getNetworkLabel()} with
                Freighter, Horizon, and a Soroban-ready contract path.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <nav className="flex flex-wrap items-center gap-3 text-sm text-sky/80 dark:text-sky/90">
                <Link href="/" className="hover:text-white transition">
                  Home
                </Link>
                <Link href="/explore" className="hover:text-white transition">
                  Explore
                </Link>
                <Link
                  href="/profile/stellar-dev"
                  className="hover:text-white transition"
                >
                  Sample profile
                </Link>
                <Link href="/create" className="hover:text-white transition">
                  Create draft
                </Link>
                <Link href="/recurring" className="hover:text-white transition">
                  Recurring support
                </Link>
                <Link href="/settings" className="hover:text-white transition">
                  Settings
                </Link>
              </nav>
              <ThemeToggle />
            </div>
          </div>

          {/* Search Bar */}
          <div className="relative" ref={searchRef}>
            <input
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showDropdown}
              aria-controls="creator-search-results"
              aria-activedescendant={
                activeResultIndex >= 0 && searchResults[activeResultIndex]
                  ? `creator-search-option-${searchResults[activeResultIndex].username}`
                  : undefined
              }
              placeholder="Search creators..."
              value={searchQuery}
              onChange={(e) => {
                setActiveResultIndex(-1);
                setSearchQuery(e.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
              className="w-full rounded-xl border border-white/10 dark:border-white/20 bg-white/5 dark:bg-white/10 px-4 py-2 text-sm text-white placeholder:text-sky/50 dark:placeholder:text-sky/60 focus:border-mint/50 focus:outline-none"
            />

            {/* Search Dropdown */}
            {showDropdown && (
              <div className="absolute top-full mt-2 w-full rounded-xl border border-white/10 dark:border-white/20 bg-ink/95 dark:bg-black/95 backdrop-blur-sm shadow-xl z-50 max-h-96 overflow-y-auto">
                {isSearching ? (
                  <div className="px-4 py-3 text-sm text-sky/70 dark:text-sky/80">
                    Searching...
                  </div>
                ) : null}
                <div id="creator-search-results" role="listbox" aria-label="Creator search results">
                  {!isSearching && searchResults.map((result, index) => (
                    <Link
                      key={result.username}
                      id={`creator-search-option-${result.username}`}
                      role="option"
                      aria-selected={activeResultIndex === index}
                      href={`/profile/${result.username}`}
                      onClick={handleResultClick}
                      className={`flex items-center gap-3 px-4 py-3 hover:bg-white/5 dark:hover:bg-white/10 transition border-b border-white/5 dark:border-white/10 last:border-0 ${activeResultIndex === index ? "bg-white/10" : ""}`}
                    >
                      {result.avatarUrl && !failedAvatarUrls.has(result.avatarUrl) ? (
                        <Image
                          src={result.avatarUrl}
                          alt={result.displayName}
                          width={40}
                          height={40}
                          className="h-10 w-10 rounded-full object-cover"
                          onError={() => {
                            setFailedAvatarUrls((urls) => {
                              const nextUrls = new Set(urls);
                              nextUrls.add(result.avatarUrl!);
                              return nextUrls;
                            });
                          }}
                        />
                      ) : (
                        <div className="h-10 w-10 rounded-full bg-gradient-to-br from-mint to-gold flex items-center justify-center text-sm font-bold text-ink">
                          {(result.displayName?.[0] || "?").toUpperCase()}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white truncate">
                          {result.displayName}
                        </p>
                        <p className="text-xs text-sky/70 dark:text-sky/80 truncate">
                          @{result.username}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
                {!isSearching && searchResults.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-sky/70 dark:text-sky/80">
                    No results found
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </header>
        <section className="mb-8">
          <WalletConnect />
        </section>
        {children}
      </div>
    </main>
  );
}
