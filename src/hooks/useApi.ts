import { useState, useEffect, useCallback, useRef } from 'react';
import type { ServerStatus } from '../types';

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

export function useSnapshots(refreshMs = 30000) {
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadSnapshots = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const res = await fetch(`${API_BASE}/snapshots`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSnapshots(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load snapshots');
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    loadSnapshots();
    const id = setInterval(loadSnapshots, refreshMs);
    return () => clearInterval(id);
  }, [loadSnapshots, refreshMs]);

  return { snapshots, loading, error, refetch: loadSnapshots };
}
