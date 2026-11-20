import { useState, useCallback, useRef, useEffect } from 'react';

type Toast = { message: string; type: 'success' | 'error' };

export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type });
    timerRef.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // Clear a pending dismiss timer when the owning component unmounts, so it cannot fire into unmounted state (#1472).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { toast, showToast, dismiss: () => setToast(null) };
}
