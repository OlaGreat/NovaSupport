import { useEffect, useRef } from "react";

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
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Keep a ref to the latest values so the stable intersection callback
  // always sees current state without being recreated on every change.
  const stateRef = useRef({ hasMore, isLoading, onLoadMore });
  stateRef.current = { hasMore, isLoading, onLoadMore };

  useEffect(() => {
    const options: IntersectionObserverInit = {
      root: null,
      rootMargin: "0px",
      threshold,
    };

    // Stable callback — reads from the ref, never recreated due to state changes.
    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (entry.isIntersecting && stateRef.current.hasMore && !stateRef.current.isLoading) {
        stateRef.current.onLoadMore();
      }
    }, options);

    const currentSentinel = sentinelRef.current;
    if (currentSentinel) {
      observer.observe(currentSentinel);
    }

    return () => {
      // disconnect() releases the observer entirely, not just one target.
      observer.disconnect();
    };
  }, [threshold]); // only rebuilds if the intersection threshold itself changes

  return sentinelRef;
}
