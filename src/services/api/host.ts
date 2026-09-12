import axios from 'axios';
import type { HostSnapshot } from '@/features/host/types';
import { normalizeApiBase } from '@/utils/connection';

const HOST_REQUEST_TIMEOUT_MS = 8_000;

const isHostSnapshot = (value: unknown): value is HostSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<HostSnapshot>;
  return (
    snapshot.version === 1 &&
    typeof snapshot.sampledAt === 'string' &&
    typeof snapshot.host?.hostname === 'string' &&
    typeof snapshot.cpu?.usagePercent === 'number' &&
    typeof snapshot.memory?.usagePercent === 'number' &&
    Array.isArray(snapshot.storage) &&
    Array.isArray(snapshot.services)
  );
};

export async function fetchHostSnapshot(
  apiBase: string,
  managementKey: string
): Promise<HostSnapshot> {
  const base = normalizeApiBase(apiBase);
  if (!base || !managementKey) throw new Error('Host connection is not configured');

  const response = await axios.get<unknown>(`${base}/host/v1/snapshot`, {
    headers: { Authorization: `Bearer ${managementKey}` },
    timeout: HOST_REQUEST_TIMEOUT_MS,
  });
  if (!isHostSnapshot(response.data)) throw new Error('Host agent returned an invalid response');
  return response.data;
}
