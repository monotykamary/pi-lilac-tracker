import { useState, useEffect, useCallback, useRef } from 'react';
import type { ServerStatus, Snapshot } from '../types';

const API_BASE = '/api';

export function useServerStatus(refreshMs = 10000): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/status`);
        if (!res.ok) return;
        const data = await res.json();
        if (active) setStatus(data);
      } catch {
        // server might not be running yet
      }
    };
    fetchStatus();
    const id = setInterval(fetchStatus, refreshMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [refreshMs]);

  return status;
}

// Rolling view window: the UI loads a bounded `days` slice so chart domains stay
// predictable as the server's JSONL grows unbounded.
//
// Fetching strategy — avoids re-pulling the whole window every poll, which is
// what drove the tab to OOM over time (a ~6MB parse + full state replace every
// 30s, forever):
//   - On mount: fetch the full `days` window once.
//   - On new data: useServerStatus reports `snapshot_count` (~every 10s). When
//     it rises, fetch ONLY the tail newer than the last snapshot we hold,
//     append + dedupe by timestamp, and re-trim the rolling window. The tail
//     payload is a handful of snapshots, not the whole window.
//   - Safety net: a low-frequency (every ~10× refreshMs) tail poll catches any
//     missed increment if /api/status is flaky or the tab was backgrounded.
//   - Manual refresh: full window refetch.
export function useSnapshots(
  refreshMs = 30000,
  days = 7,
  knownCount: number | null = null,
) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const lastCountRef = useRef<number | null>(null);
  const lastTsRef = useRef<string | null>(null);
  const daysRef = useRef(days);
  daysRef.current = days;

  // Track the newest timestamp we hold so tail fetches resume from it.
  useEffect(() => {
    lastTsRef.current = snapshots.length
      ? snapshots[snapshots.length - 1].timestamp
      : null;
  }, [snapshots]);

  const trimWindow = useCallback((list: Snapshot[]): Snapshot[] => {
    const cutoff = Date.now() - daysRef.current * 86_400_000;
    return list.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
  }, []);

  // Full window fetch — mount + manual refresh.
  const loadFull = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const from = new Date(
        Date.now() - daysRef.current * 86_400_000,
      ).toISOString();
      const res = await fetch(`${API_BASE}/snapshots?from=${encodeURIComponent(from)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Snapshot[];
      setSnapshots(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load snapshots');
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Tail fetch — only snapshots newer than the last one we hold. Append +
  // dedupe by timestamp, then re-trim the rolling window. Payload is just the
  // new tail (a few snapshots at 5-min cadence), not the whole window.
  const loadTail = useCallback(async () => {
    if (loadingRef.current) return;
    const from = lastTsRef.current;
    if (!from) {
      // Nothing held yet — fall back to a full load.
      return loadFull();
    }
    loadingRef.current = true;
    try {
      const res = await fetch(`${API_BASE}/snapshots?from=${encodeURIComponent(from)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tail = (await res.json()) as Snapshot[];
      if (tail.length === 0) return;
      setSnapshots((prev) => {
        const seen = new Set(prev.map((s) => s.timestamp));
        const out = prev.slice();
        for (const s of tail) {
          if (!seen.has(s.timestamp)) {
            out.push(s);
            seen.add(s.timestamp);
          }
        }
        return trimWindow(out);
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load snapshots');
    } finally {
      loadingRef.current = false;
    }
  }, [trimWindow, loadFull]);

  // Initial full load.
  useEffect(() => {
    loadFull();
  }, [loadFull]);

  // Reactive tail fetch: only when the server reports new snapshots.
  useEffect(() => {
    if (knownCount == null) return;
    if (lastCountRef.current == null) {
      lastCountRef.current = knownCount;
      return;
    }
    if (knownCount > lastCountRef.current) {
      lastCountRef.current = knownCount;
      loadTail();
    }
  }, [knownCount, loadTail]);

  // Low-frequency safety net: re-pull the tail every ~10× refreshMs even if the
  // count signal is missed (flaky /api/status, background-tab throttling).
  // Cheap — a small tail payload — and self-heals any gap.
  useEffect(() => {
    const id = setInterval(() => {
      void loadTail();
    }, refreshMs * 20);
    return () => clearInterval(id);
  }, [refreshMs, loadTail]);

  return { snapshots, loading, error, refetch: loadFull };
}
