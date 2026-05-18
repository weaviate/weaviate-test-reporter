"use client";

import { useEffect, useRef, useState } from "react";

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * Minimal async hook — runs `fn()` on mount and whenever any of `deps` changes.
 *
 * Why not react-query: an MVP dashboard with three tabs and zero caching
 * needs doesn't justify the dependency footprint. Swap in if either show
 * up (Phase 3 territory).
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList = []
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    setLoading(true);
    setError(null);
    fn()
      .then((value) => {
        if (seq.current !== mySeq) return;
        setData(value);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (seq.current !== mySeq) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, refetch: () => setTick((t) => t + 1) };
}
