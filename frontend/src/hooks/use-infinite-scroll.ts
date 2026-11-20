import { useCallback, useEffect, useRef, useState } from "react";

interface UseInfiniteScrollOptions {
  onLoadMore: () => void;
  hasMore: boolean;
  isLoading: boolean;
  threshold?: number;
}

export function useInfiniteScroll({
  onLoadMore,
  hasMore,
  isLoading,
  threshold = 0.8,
}: UseInfiniteScrollOptions) {
  // Keep a ref to the latest values so the observer callback always sees
  // current state without being recreated on every change.
  const stateRef = useRef({ hasMore, isLoading, onLoadMore });
  stateRef.current = { hasMore, isLoading, onLoadMore };

  // The sentinel is kept in state so the observer effect re-runs when it
  // mounts or unmounts, including when it sits behind a conditional
  // (e.g. "hasMore && profiles.length > 0").
  //
  // This is not a ref callback that returns a cleanup: React 18 ignores the
  // return value of ref callbacks, so the observer would never disconnect.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    setSentinel(node);
  }, []);

  useEffect(() => {
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (
          entry.isIntersecting &&
          stateRef.current.hasMore &&
          !stateRef.current.isLoading
        ) {
          stateRef.current.onLoadMore();
        }
      },
      { root: null, rootMargin: "0px", threshold }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, threshold]);

  return sentinelRef;
}
