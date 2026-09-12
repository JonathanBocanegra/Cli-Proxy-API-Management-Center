import { useCallback, useEffect, useRef, useState } from 'react';
import { useInterval } from '@/hooks/useInterval';
import { fetchHostSnapshot } from '@/services/api/host';
import { useAuthStore } from '@/stores';
import type { HostSnapshot } from '../types';

const POLL_INTERVAL_MS = 2_000;
const HISTORY_LIMIT = 48;

export interface HostHistoryPoint {
  sampledAt: string;
  cpu: number;
  diskRead: number;
  diskWrite: number;
  networkReceive: number;
  networkTransmit: number;
}

export function useHostTelemetry() {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [history, setHistory] = useState<HostHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestID = useRef(0);

  const refresh = useCallback(async () => {
    if (!connected) return;
    const currentRequest = ++requestID.current;
    setRefreshing(true);

    try {
      const next = await fetchHostSnapshot(apiBase, managementKey);
      if (requestID.current !== currentRequest) return;
      setSnapshot(next);
      setHistory((current) => {
        const last = current[current.length - 1];
        if (last?.sampledAt === next.sampledAt) return current;
        return [
          ...current,
          {
            sampledAt: next.sampledAt,
            cpu: next.cpu.usagePercent,
            diskRead: next.diskIo.readBytesPerSecond,
            diskWrite: next.diskIo.writeBytesPerSecond,
            networkReceive: next.network.receiveBytesPerSecond,
            networkTransmit: next.network.transmitBytesPerSecond,
          },
        ].slice(-HISTORY_LIMIT);
      });
      setError(null);
    } catch (requestError) {
      if (requestID.current !== currentRequest) return;
      setError(requestError instanceof Error ? requestError.message : 'Host agent is unavailable');
    } finally {
      if (requestID.current === currentRequest) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [apiBase, connected, managementKey]);

  useEffect(() => {
    void refresh();
    return () => {
      requestID.current += 1;
    };
  }, [refresh]);

  useInterval(() => void refresh(), connected ? POLL_INTERVAL_MS : null);

  return { snapshot, history, loading, refreshing, error, refresh };
}
