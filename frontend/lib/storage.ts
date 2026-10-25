'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** useState persisted to localStorage (SSR-safe, survives JSON errors). */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        // Merge objects so new settings keys get their defaults.
        setValue(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof initial === 'object' && !Array.isArray(initial)
            ? { ...initial, ...parsed }
            : parsed,
        );
      }
    } catch {
      /* ignore corrupted storage */
    }
    loaded.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* quota / private mode */
        }
        return next;
      });
    },
    [key],
  );

  return [value, set];
}
